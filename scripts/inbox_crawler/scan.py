"""The scan loop (spec section 5): owners, an incremental walk, registration, baseline, copies, moves.

For each owner (a person's `Users/<uni alias>`, a team's `Shared/<share folder>`) the walk stats every
directory it knows from `inbox_dirs` (one cheap call) and lists only those whose modification time moved.
New files are classified and recognised and registered as candidates (an image's thumbnails are made from the
bytes already in hand and stored in the same transaction, spec section 14); the first complete scan of an owner
marks everything it finds `origin='backlog'` and then sets `baselined_at`. A file that vanished from a
changed directory becomes `gone` (undecided candidates only), unless a new file with the same content
turned up, which re-points the row. A share that drops mid-scan aborts the scan and marks nothing gone.

Ignored folders (spec section 15): a folder that is ignored, and everything below it, is NOT SCANNED: it is
neither listed nor statted, no file in it is opened, and, unlike an empty folder, it never makes a candidate
`gone` (any state), nor loses its cache rows. A rule only ever makes the crawler read less, so the owner's
rules are read when the crawler starts the owner and again before each folder it lists, before each batch of
registrations and (at most every RULES_TTL_S) before each file it reads: a rule added while a big folder is
walked stops the walk of it within a batch, and nothing is registered, classified or thumbnailed under a rule
found at that moment. One small query each time, never one per file.

Everything that touches the share goes through the `share` object (a `fs_readonly.Share` or a test fake).
The database is committed after each directory, so a killed scan loses nothing and resumes where it was.
"""

from __future__ import annotations

import io
import logging
import time
from dataclasses import dataclass, field

from . import classify_sem, db, hashing, kinds, owners, recognise, thumbs
from .fs_readonly import ReadRefused
from .identity import file_id

log = logging.getLogger("inbox_crawler.scan")

# Images up to this size are kept in memory while they are hashed, so classifying them costs no second read.
CLASSIFY_MAX_BYTES = 64 * 1024 * 1024
# Deeper than this is not a research folder, it is a loop or a mistake.
MAX_DEPTH = 30
# This many failed reads in a row mean the share is going away, not that files are unreadable.
MAX_CONSECUTIVE_FAILURES = 25
_ACTIVITY_EVERY_S = 5.0
# A directory whose mtime is newer than this (or in the future: a skewed clock) is listed again next scan.
RACY_WINDOW_S = 2.0
# New files are committed in batches of this many inside a folder, so a kill loses at most one batch of
# work in a big one. The folder's cache row is still written last, so an unfinished folder is listed again.
COMMIT_EVERY = 50
# A file modified this recently (or dated this far ahead: a clock a little off) may still be being written:
# it is left for the next scan rather than registered with a partial size and hash.
RECENT_FILE_S = 5.0
# While files are read, the owner's rules are looked up again when the last look is older than this (a
# big file through a slow throttle takes minutes, so the per-batch look alone can be stale).
RULES_TTL_S = 5.0

_IGNORED_NAMES = frozenset({"thumbs.db", "desktop.ini", ".ds_store"})
_IGNORED_PREFIXES = (".", "~$")
_IGNORED_SUFFIXES = (".tmp", ".temp")


def ignored_file(name: str) -> bool:
    """Editor and file-server litter that is never a found file."""
    low = name.lower()
    return (
        low in _IGNORED_NAMES
        or low.startswith(_IGNORED_PREFIXES)
        or low.endswith(_IGNORED_SUFFIXES)
    )


def still_the_same(
    share, rel: str, st, hashed: hashing.HashOutcome
) -> hashing.HashOutcome:
    """The fingerprint row says "this hash is of a file of this size and mtime", and others (the
    surface-scan renderer) rely on it. So a hash is kept as done only if the file is still what stat
    said before it was read; a file that changed while it was read is recorded as an error and hashed
    again later."""
    if hashed.status != "done":
        return hashed
    after = share.stat(
        rel
    )  # an OSError here (the share going away) is the caller's to handle
    if hashed.size != st.size or (after.size, after.mtime_ns) != (st.size, st.mtime_ns):
        return hashing.HashOutcome(
            "error", error="the file changed while it was being hashed"
        )
    return hashed


def fingerprint_file(
    share, rel: str, throttle, *, adopted: bool = False, progress=None
):
    """Stat, hash and re-check one file. Returns (outcome, stat or None, mtime or None). Used for a file a
    person has linked (adopted) and for retrying a hash that failed; both write file_fingerprints.

    Never raises for a path the share refuses (a `..` part, a link in the path, a file type the allow-list
    does not cover): that is an 'error' outcome like any unreadable file, so the caller writes its row, the
    row is retried no sooner than an hour later and the loop goes on to the next file."""
    try:
        st = share.stat(rel)
    except FileNotFoundError:
        return (
            hashing.HashOutcome("missing", error="the file is not on the share"),
            None,
            None,
        )
    except OSError as exc:
        return (
            hashing.HashOutcome("error", error=f"{type(exc).__name__}: {exc}"[:500]),
            None,
            None,
        )
    except ValueError:
        return (
            hashing.HashOutcome("error", error="not a path the share allows"),
            None,
            None,
        )
    if not st.is_file:
        return hashing.HashOutcome("error", error="not a regular file"), None, None
    try:
        out = hashing.hash_file(
            share, rel, throttle=throttle, adopted=adopted, progress=progress
        )
    except (ReadRefused, ValueError) as exc:
        log.warning("not reading %s: %s", rel, type(exc).__name__)
        refused = hashing.HashOutcome("error", error=f"read refused: {exc}"[:500])
        return refused, st, db.to_datetime(st.mtime_ns)
    try:
        out = still_the_same(share, rel, st, out)
    except OSError as exc:
        out = hashing.HashOutcome(
            "error", error=f"could not re-check the file ({type(exc).__name__})"
        )
    return out, st, db.to_datetime(st.mtime_ns)


class ShareUnavailable(Exception):  # noqa: N818 (a condition, not a bug)
    """The share is not there (or going away): abort, mark nothing gone."""


class _TooNew(Exception):  # noqa: N818
    """A file changed a moment ago: not registered this scan, its folder is listed again next time."""


class _Ignored(Exception):  # noqa: N818
    """A rule now ignores the folder of the file being registered: nothing of it is read or written."""


class OwnerUnavailable(Exception):  # noqa: N818
    """One owner's folder cannot be read while the share itself answers: record it, skip that owner."""


class OwnerChanged(OwnerUnavailable):
    """The owner's alias or share folder changed while its folder was being scanned: its work is dropped."""


@dataclass
class ScanStats:
    registered: int = 0
    errors: int = 0
    temporary_errors: int = 0
    listed_dirs: int = 0
    gone: int = 0
    repointed: int = 0
    owners_scanned: int = 0
    ignored_dirs: int = 0  # known folders passed over because a rule ignores them (not listed, not statted)
    aborted: bool = False
    interrupted: bool = False
    last_error: str | None = None
    unmatched: list[str] | None = (
        None  # set by a scan of everyone; None leaves the stored list alone
    )
    new_candidates: list[str] = field(default_factory=list)

    def error(self, msg: str, temporary: bool = False) -> None:
        """Record an error. A temporary one (the share hiccuping, an I/O error, a file vanishing while it
        is read) may clear by itself and blocks an owner's baseline; a permanent one (no permission, a
        folder too deep, a name that cannot be registered) will not, and does not."""
        self.errors += 1
        if temporary:
            self.temporary_errors += 1
        self.last_error = msg


@dataclass
class _Fresh:
    cand: db.Cand
    sha: str | None
    size: int
    mtime: object


class Scanner:
    def __init__(
        self,
        share,
        store: db.Store,
        *,
        throttle: hashing.Throttle | None = None,
        lookup: recognise.Lookup | None = None,
        ocr: bool = False,
        ocr_func=None,
        profiles=None,
        stop=lambda: False,
        activity=lambda text: None,
        clock=time.monotonic,
        wall=time.time,
        thumbnails: bool = True,
    ):
        self.share = share
        self.store = store
        self.throttle = throttle
        self.lookup = lookup
        self.ocr = ocr
        self.ocr_func = ocr_func
        self.profiles = profiles
        self.thumbnails = thumbnails  # INBOX_THUMBNAILS=0 turns it off
        self.stop = stop
        self.activity = activity
        self._clock = clock
        self._wall = wall
        self._last_activity = 0.0
        self._failures = 0  # consecutive failed reads
        # The owner being scanned and its ignore rules as last read (see _load_rules)
        self._owner: owners.Owner | None = None
        self._rules = owners.IgnoreRules()
        self._rules_at = float("-inf")

    # ---- the share is there ----------------------------------------------------------

    def verify_share(self, bases=()) -> None:
        """Raise ShareUnavailable unless the share root and the base folders in use (Users, Shared) answer
        as directories. An empty mount point (the share not mounted) fails here. An owner's own folder is
        not part of this check: see _owner_ok."""
        for path in ["", *bases]:
            try:
                is_dir = self.share.stat(path).is_dir
            except OSError as exc:
                raise ShareUnavailable(
                    f"{path or 'the share root'} does not answer ({type(exc).__name__})"
                ) from exc
            if not is_dir:
                raise ShareUnavailable(f"{path or 'the share root'} is not a directory")

    def _owner_ok(self, owner: owners.Owner, bases) -> None:
        """The owner's folder answers as a directory, or OwnerUnavailable (the share is checked first, so a
        dropped share is never mistaken for one missing folder)."""
        try:
            is_dir = self.share.stat(owner.root).is_dir
        except OSError as exc:
            self.verify_share(bases)
            self._note_failure(exc)
            raise OwnerUnavailable(
                f"{owner.root}: cannot be read ({type(exc).__name__})"
            ) from exc
        if not is_dir:
            self.verify_share(bases)
            raise OwnerUnavailable(f"{owner.root}: is not a directory")

    def _note_failure(self, exc: OSError) -> None:
        if isinstance(exc, PermissionError):
            return  # a folder one cannot read says nothing about the share
        self._failures += 1
        if self._failures >= MAX_CONSECUTIVE_FAILURES:
            raise ShareUnavailable(
                f"{self._failures} reads failed in a row ({type(exc).__name__})"
            )

    def _tell(self, text: str, force: bool = False) -> None:
        now = self._clock()
        if force or now - self._last_activity >= _ACTIVITY_EVERY_S:
            self._last_activity = now
            self.activity(text)

    # ---- one scan --------------------------------------------------------------------

    def scan(self, *, person_id: str | None = None) -> ScanStats:
        """Scan everyone (person_id None), or one person: their personal folder and the folders of the
        teams they are an active member of. Never raises for a share problem: it returns stats with
        `aborted` set."""
        stats = ScanStats()
        if self.lookup is None:
            self.lookup = self.store.load_lookup()
        try:
            self._scan(stats, person_id)
        except ShareUnavailable as exc:
            self.store.rollback()
            stats.aborted = True
            stats.error(f"scan aborted, nothing marked gone: {exc}")
            log.warning("scan aborted: %s", exc)
        finally:
            self._owner = None
            self._rules = owners.IgnoreRules()
        if stats.ignored_dirs:
            log.info("%d ignored folders were not scanned", stats.ignored_dirs)
        return stats

    def _scan(self, stats: ScanStats, person_id: str | None) -> None:
        people = self.store.load_people()
        if person_id is not None:
            people = [p for p in people if p["person_id"] == person_id]
        teams = (
            self.store.load_teams()
            if person_id is None
            else self.store.load_teams_of(person_id)
        )
        claims = {
            owners.PERSON_BASE: ("person", owners.person_claims(people)),
            owners.TEAM_BASE: ("team", owners.team_claims(teams)),
        }
        bases = [b for b, (_k, c) in claims.items() if c]
        if person_id is None:
            bases = sorted(set(bases) | {b for b in claims if self._exists(b)})
        self.verify_share(bases)
        found: list[owners.Owner] = []
        unmatched: list[str] = []
        for base in (owners.PERSON_BASE, owners.TEAM_BASE):
            kind, base_claims = claims[base]
            if base not in bases:
                continue
            try:
                names = [e.name for e in self.share.scandir(base) if e.is_dir]
            except OSError as exc:
                raise ShareUnavailable(
                    f"cannot list {base} ({type(exc).__name__})"
                ) from exc
            m = owners.match_folders(base, names, base_claims, kind)
            found.extend(m.owners)
            unmatched.extend(m.unmatched)
        if person_id is None:
            stats.unmatched = unmatched
        for owner in found:
            if self.stop():
                stats.interrupted = True
                return
            try:
                self.scan_owner(owner, bases, stats)
            except OwnerUnavailable as exc:  # includes OwnerChanged
                self.store.rollback()  # this owner's unfinished work; folders already committed stand
                stats.error(str(exc))
                log.warning("skipping %s: %s", owner.root, exc)
                continue
            if stats.interrupted:
                return

    def _load_rules(self) -> None:
        """Read the current owner's ignore rules again (one small query)."""
        self._rules = self.store.load_ignored_for(self._owner)
        self._rules_at = self._clock()

    def _dir_ignored(self, path: str) -> bool:
        """Is this share path a folder the current owner ignores (or one below it), by the rules as last read?
        The owner's root never is."""
        below = owners.below_root(self._owner.root, path)
        return bool(below) and owners.is_ignored(below, self._rules)

    def _ignored_now(self, path: str, *, force: bool = False) -> bool:
        """Like _dir_ignored, after reading the rules again when `force` or when the last read is older than
        RULES_TTL_S."""
        if force or self._clock() - self._rules_at >= RULES_TTL_S:
            self._load_rules()
        return self._dir_ignored(path)

    def _exists(self, rel: str) -> bool:
        try:
            return self.share.stat(rel).is_dir
        except OSError:
            return False

    # ---- one owner -------------------------------------------------------------------

    def scan_owner(self, owner: owners.Owner, bases, stats: ScanStats) -> None:
        self._tell(f"scanning {owner.root}", force=True)
        self.verify_share(bases)
        self._owner_ok(owner, bases)
        self._bases = bases
        store = self.store
        store.drop_foreign_state(
            owner
        )  # a folder that changed hands starts clean for its new owner
        store.resync_paths(
            owner
        )  # the indexer may have moved files: its pointer rows say where
        # Files linked meanwhile in Data Studio are no longer found files: drop their undecided candidates.
        dropped = store.drop_linked_elsewhere(owner)
        if dropped:
            log.info(
                "%s: %d candidates dropped, their files are linked elsewhere",
                owner.root,
                dropped,
            )
        dirs = store.load_dirs(owner)
        cands = store.load_candidates(owner)
        self._owner = owner
        self._load_rules()  # the rules as they are when this owner starts (and again as the walk goes on)
        dir_ignored = self._dir_ignored
        origin = "new" if store.owner_baselined(owner) else "backlog"
        children: dict[str, set[str]] = {}
        for d in dirs:
            if d != owner.root:
                children.setdefault(d.rpartition("/")[0], set()).add(d)
        by_dir: dict[str, list[db.Cand]] = {}
        for c in cands.values():
            by_dir.setdefault(c.rel_path.rpartition("/")[0], []).append(c)
            if c.state == "new":
                # The walk only visits folders it knows from the cache, and a deleted folder's cache rows are
                # dropped. A file restored (or an undone link) after that would never be looked for again, so
                # every undecided file's folder, and each folder above it, is always stat-ed: a missing one
                # lands in vanished_dirs and its files are marked gone.
                d = c.rel_path.rpartition("/")[0]
                while d != owner.root and d.startswith(owner.root + "/"):
                    parent = d.rpartition("/")[0]
                    children.setdefault(parent, set()).add(d)
                    d = parent

        gone: list[db.Cand] = []
        vanished_dirs: list[str] = []
        # Folders whose listing showed a loss (a missing file or folder): their real mtime is written
        # only together with the gone marks, so an abort or a stop in between cannot hide the loss.
        deferred: dict[str, object] = {}
        fresh: list[_Fresh] = []
        temporary_before = stats.temporary_errors
        root_listed = False
        stack: list[tuple[str, int]] = [(owner.root, 0)]
        while stack:
            if self.stop():
                stats.interrupted = True
                self._commit(owner)
                return
            d, depth = stack.pop()
            if dir_ignored(d):
                # Not scanned: no stat, no listing, nothing below it is read, and nothing in it is judged
                # (see the sweep below). The one place that keeps an ignored folder out of the walk, for
                # folders from the cache and folders seen in a listing alike.
                stats.ignored_dirs += 1
                continue
            if depth > MAX_DEPTH:
                stats.error(f"{d}: deeper than {MAX_DEPTH} levels, not scanned")
                continue
            try:
                st = self.share.stat(d)
                self._failures = 0
            except FileNotFoundError:
                if d == owner.root:
                    self.verify_share(bases)
                    raise OwnerUnavailable(f"{owner.root}: is gone") from None
                vanished_dirs.append(d)
                self._failures += 1
                if self._failures >= MAX_CONSECUTIVE_FAILURES:
                    raise ShareUnavailable("known folders keep vanishing") from None
                continue
            except OSError as exc:
                self._note_failure(exc)
                stats.error(
                    f"{d}: cannot stat ({type(exc).__name__})",
                    temporary=not isinstance(exc, PermissionError),
                )
                continue
            if not st.is_dir:
                vanished_dirs.append(d)
                continue
            mtime = db.to_datetime(st.mtime_ns)
            row = dirs.get(d)
            if (
                row is not None
                and row.last_listed_at is not None
                and row.dir_mtime == mtime
            ):
                if d == owner.root:
                    root_listed = True
                stack.extend(
                    (c, depth + 1) for c in sorted(children.get(d, ()), reverse=True)
                )
                continue
            if self._ignored_now(d, force=True):
                # a rule was added since this scan started: it holds from now on, before the listing
                stats.ignored_dirs += 1
                continue
            listing_ok = self._list_dir(
                owner,
                d,
                mtime,
                depth,
                origin,
                cands,
                by_dir,
                children,
                gone,
                vanished_dirs,
                fresh,
                stack,
                stats,
                deferred,
            )
            if listing_ok and d == owner.root:
                root_listed = True

        # Marking things gone is the dangerous step: only after the share has answered again.
        if gone or vanished_dirs:
            self.verify_share(bases)
            self._owner_ok(owner, bases)
            lost = {c.candidate_id: c for c in gone if c.state == "new"}
            for v in (
                vanished_dirs
            ):  # everything that was under a folder that is no longer there
                for c in cands.values():
                    if c.state == "new" and c.rel_path.startswith(v + "/"):
                        lost[c.candidate_id] = c
            # An ignored subtree is not scanned, which is not the same as empty: whatever sits under one
            # keeps its state, even when a folder above it vanished.
            lost = {
                k: c
                for k, c in lost.items()
                if not dir_ignored(c.rel_path.rpartition("/")[0])
            }
            lost_list = sorted(lost.values(), key=lambda c: c.rel_path)
            self._reconcile_moves(lost_list, fresh, stats, owner)
            stats.gone += store.mark_gone([c.candidate_id for c in lost_list])
            store.forget_dirs_under(
                owner,
                vanished_dirs,
                keep=[
                    d
                    for d in dirs
                    if dir_ignored(d)
                    and any(d == v or d.startswith(v + "/") for v in vanished_dirs)
                ],
            )
            for d, mtime in deferred.items():  # same transaction as mark_gone
                if not any(d == v or d.startswith(v + "/") for v in vanished_dirs):
                    store.upsert_dir(owner, d, self._cacheable(mtime), listed=True)
        stats.owners_scanned += 1
        if root_listed and stats.temporary_errors == temporary_before:
            store.mark_baselined(owner)
        self._commit(owner)

    def _list_dir(
        self,
        owner,
        d,
        mtime,
        depth,
        origin,
        cands,
        by_dir,
        children,
        gone,
        vanished_dirs,
        fresh,
        stack,
        stats,
        deferred,
    ) -> bool:
        """List one changed directory and register its new files. True when it was listed (scandir answered)
        (the cache row is then updated); False leaves the cache as it was so the next scan lists it again."""
        store = self.store
        try:
            entries = self.share.scandir(d)
            self._failures = 0
        except FileNotFoundError:
            if d == owner.root:
                self.verify_share(self._bases)
                raise OwnerUnavailable(f"{owner.root}: is gone") from None
            vanished_dirs.append(d)
            return False
        except OSError as exc:
            self._note_failure(exc)
            stats.error(
                f"{d}: cannot list ({type(exc).__name__})",
                temporary=not isinstance(exc, PermissionError),
            )
            return False
        stats.listed_dirs += 1
        self._tell(f"scanning {d}")
        subdirs = sorted(
            e.name for e in entries if e.is_dir and not owners.skip_dir(e.name)
        )
        files = sorted(
            (e for e in entries if e.is_file and not ignored_file(e.name)),
            key=lambda e: e.name,
        )
        lost_before = len(gone) + len(vanished_dirs)
        wanted = {f"{d}/{n}" for n in subdirs}
        for known in sorted(children.get(d, ())):
            if known not in wanted and not self._dir_ignored(known):
                vanished_dirs.append(
                    known
                )  # (an ignored one is not judged: not scanned)
        present = {f"{d}/{e.name}" for e in files}
        for c in by_dir.get(d, ()):
            if c.state == "new" and c.rel_path not in present:
                gone.append(c)
        complete = True
        batch = 0
        # A file already linked to a record is not a found file: do not register it at all.
        unknown = [f"{d}/{e.name}" for e in files if f"{d}/{e.name}" not in cands]
        linked = store.already_linked([str(file_id(r)) for r in unknown])
        for seen, e in enumerate(files):
            if seen and seen % COMMIT_EVERY == 0:
                self._load_rules()  # once per batch of files: a rule found now stops the folder
            if self._dir_ignored(d):
                # A rule ignores this folder since the walk reached it: register, revive and read nothing more
                # here. (The folder is left "seen, not listed": removing the rule lists it again.)
                complete = False
                stats.ignored_dirs += 1
                break
            rel = f"{d}/{e.name}"
            known = cands.get(rel)
            if known is not None:
                if known.state == "gone":
                    store.revive(known.candidate_id)
                    cands[rel] = db.Cand(
                        known.candidate_id,
                        known.directus_files_id,
                        rel,
                        "new",
                        known.kind,
                    )
                continue
            if str(file_id(rel)) in linked:
                continue
            try:
                f = self._new_file(owner, rel, e.name, origin, stats)
            except _TooNew:
                complete = (
                    False  # no error: the folder is simply listed again next scan
                )
                continue
            except _Ignored:
                complete = False
                stats.ignored_dirs += 1
                break
            except OSError as exc:
                self._note_failure(exc)
                stats.error(
                    f"{rel}: cannot read its details ({type(exc).__name__})",
                    temporary=not isinstance(exc, PermissionError),
                )
                complete = False
                continue
            except Exception as exc:  # noqa: BLE001 (a DB error on one file must not stop the scan)
                if type(exc).__name__ == "ReadRefused":
                    raise  # a bug: the allow-list refused a read we asked for
                log.warning("registering %s failed: %s", rel, type(exc).__name__)
                stats.error(f"{rel}: not registered ({type(exc).__name__})")
                complete = False
                continue
            if f is not None:
                cands[rel] = f.cand
                by_dir.setdefault(d, []).append(f.cand)
                fresh.append(f)
                batch += 1
                if batch >= COMMIT_EVERY:
                    self._commit(
                        owner
                    )  # candidates are idempotent; the folder's own row still comes last
                    batch = 0
        for n in subdirs:
            child = f"{d}/{n}"
            if child not in children.get(d, ()):
                # Seen, not listed yet: if this scan stops before it gets there, the next one still does.
                store.upsert_dir(owner, child, None, listed=False)
                children.setdefault(d, set()).add(child)
        if complete:
            if len(gone) + len(vanished_dirs) > lost_before:
                # Something is missing here: keep the folder "changed" until the gone marks are written.
                store.upsert_dir(owner, d, None, listed=True)
                deferred[d] = mtime
            else:
                if not store.upsert_dir(owner, d, self._cacheable(mtime), listed=True):
                    raise OwnerChanged(f"{d}: another owner has this folder")
        elif not store.upsert_dir(owner, d, None, listed=False):
            # not done (a file to look at again): keep a row, so the folder is "seen, not listed yet"
            raise OwnerChanged(f"{d}: another owner has this folder")
        self._commit(owner)
        stack.extend((f"{d}/{n}", depth + 1) for n in reversed(subdirs))
        return True  # listed; `complete` only decided whether the folder's cache row was written

    def _commit(self, owner: owners.Owner) -> None:
        """Commit the owner's work, but only while the owner still holds the folder the scan started with.
        If the alias or share folder changed, the unfinished work is rolled back and the owner skipped."""
        if not self.store.owner_claim_unchanged(owner):
            self.store.rollback()
            raise OwnerChanged(
                f"{owner.root}: its alias or share folder changed during the scan"
            )
        self.store.commit()

    def _cacheable(self, mtime):
        """The mtime to cache for a listed folder. One changed in the last moments may change again within
        the same clock tick, which its modification time cannot show: leave it out so the next scan lists it."""
        return None if self._wall() - mtime.timestamp() < RACY_WINDOW_S else mtime

    # ---- one new file ----------------------------------------------------------------

    def _new_file(self, owner, rel, name, origin, stats) -> _Fresh | None:
        folder = rel.rpartition("/")[0]
        if self._ignored_now(
            folder
        ):  # a rule may have come in while earlier files were read
            raise _Ignored(rel)
        st = self.share.stat(
            rel
        )  # one metadata call; raises OSError for the caller to count
        self._failures = 0
        if not st.is_file:
            return None  # a link, a FIFO or a directory swapped in since the listing: not a found file
        if abs(self._wall() - st.mtime_ns / 1e9) < RECENT_FILE_S:
            raise _TooNew(rel)
        cls = kinds.kind_by_name(name)
        hashed = None
        if cls.kind in ("image", "surface_scan"):
            keep = (
                CLASSIFY_MAX_BYTES
                if cls.kind == "image" and st.size <= CLASSIFY_MAX_BYTES
                else 0
            )
            hashed = hashing.hash_file(
                self.share,
                rel,
                throttle=self.throttle,
                keep_up_to=keep,
                # a big file through a slow throttle takes minutes: keep the heartbeat beating
                progress=lambda _total: self._tell(f"hashing {rel}"),
            )
            if hashed.status == "missing":
                # Listed a moment ago and gone now: the file was removed or the share is going. Do not
                # register it with a hash that says "missing"; the folder is listed again next scan.
                raise FileNotFoundError(rel)
            hashed = self._still_the_same(rel, st, hashed)
            if self._ignored_now(
                folder
            ):  # hashing a big file takes a while: look again before using it
                raise _Ignored(rel)
            if (
                cls.kind == "image"
                and hashed.data is not None
                and hashed.status == "done"
            ):
                cls = classify_sem.classify_image(
                    io.BytesIO(hashed.data),
                    ocr=self.ocr,
                    ocr_func=self.ocr_func,
                    profiles=self.profiles,
                )
                if cls.reason.startswith("not decoded"):
                    log.info("%s is registered as a plain image: %s", rel, cls.reason)
        pictures = None
        pictures_failed = None
        if (
            self.thumbnails
            and cls.kind in ("image", "sem_image")
            and hashed is not None
            and hashed.status == "done"
            and hashed.data is not None
        ):
            # the bytes are already in memory (hashed and classified): no second read of the share
            pictures = thumbs.make_thumbnails(hashed.data)
            if pictures is None:
                # a marker, so the backfill does not read this file again until it changes
                pictures_failed = "not decoded"
        rec = recognise.recognise(rel, self.lookup, below=owner.root)
        if self._ignored_now(
            folder
        ):  # last look: nothing under a rule found at this moment is registered
            raise _Ignored(rel)
        result = self.store.register_file(
            owner=owner,
            rel=rel,
            size=st.size,
            mtime=db.to_datetime(st.mtime_ns),
            classification=cls,
            recognition=rec,
            origin=origin,
            hashed=hashed,
            thumbs=pictures,
            thumbs_failed=pictures_failed,
        )
        if not result.created or result.candidate_id is None:
            return None
        stats.registered += 1
        stats.new_candidates.append(result.candidate_id)
        fid = str(file_id(rel))
        cand = db.Cand(result.candidate_id, fid, rel, "new", cls.kind)
        sha = hashed.sha256 if hashed is not None and hashed.status == "done" else None
        return _Fresh(cand, sha, st.size, db.to_datetime(st.mtime_ns))

    def _still_the_same(
        self, rel, st, hashed: hashing.HashOutcome
    ) -> hashing.HashOutcome:
        return still_the_same(self.share, rel, st, hashed)

    # ---- moves -----------------------------------------------------------------------

    def _reconcile_moves(
        self, gone: list[db.Cand], fresh: list[_Fresh], stats, owner
    ) -> None:
        """A vanished undecided file and a new file with the same content, one of each: it moved.
        Re-point the candidate instead of marking it gone. Ambiguous matches are left as gone + new.

        The new file may have been registered by an earlier, interrupted scan; it was then recorded as a
        copy of the file that has now vanished (duplicate_of), so those copies count as well."""
        if not gone:
            return
        gone_by_sha: dict[str, list[db.Cand]] = {}
        for c in list(gone):
            if c.state != "new" or c.kind not in ("image", "sem_image", "surface_scan"):
                continue
            sha = self.store.fingerprint_of(c.directus_files_id)
            if sha:
                gone_by_sha.setdefault(sha, []).append(c)
        news_by_sha: dict[str, dict[str, _Fresh]] = {}
        for f in fresh:
            if f.sha:
                news_by_sha.setdefault(f.sha, {})[f.cand.candidate_id] = f
        for sha, olds in gone_by_sha.items():
            news = news_by_sha.setdefault(sha, {})
            for old in olds:
                for f in self.store.copies_of(old, owner):
                    news.setdefault(
                        f.cand.candidate_id, _Fresh(f.cand, sha, f.size, f.mtime)
                    )
        for sha, olds in gone_by_sha.items():
            news = list(news_by_sha.get(sha, {}).values())
            if len(olds) == 1 and len(news) == 1:
                old, new = olds[0], news[0]
                if self.store.repoint_candidate(old, new.cand, new.size, new.mtime):
                    gone[:] = [c for c in gone if c is not old]
                    stats.repointed += 1
                    log.info("re-pointed %s to %s", old.rel_path, new.cand.rel_path)
