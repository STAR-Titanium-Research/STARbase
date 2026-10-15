"""The scan loop (spec section 5): owners, an incremental walk, registration, baseline, copies, moves.

For each owner (a person's `Users/<uni alias>`, a team's `Shared/<share folder>`) the walk stats every
directory it knows from `inbox_dirs` (one cheap call) and lists only those whose modification time moved.
New files are classified and recognised and registered as candidates; the first complete scan of an owner
marks everything it finds `origin='backlog'` and then sets `baselined_at`. A file that vanished from a
changed directory becomes `gone` (undecided candidates only), unless a new file with the same content
turned up, which re-points the row. A share that drops mid-scan aborts the scan and marks nothing gone.

Everything that touches the share goes through the `share` object (a `fs_readonly.Share` or a test fake).
The database is committed after each directory, so a killed scan loses nothing and resumes where it was.
"""

from __future__ import annotations

import io
import logging
import time
from dataclasses import dataclass, field

from . import classify_sem, db, hashing, kinds, owners, recognise

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
    try:
        after = share.stat(rel)
    except OSError as exc:
        return hashing.HashOutcome(
            "error", error=f"could not re-check the file ({type(exc).__name__})"
        )
    if hashed.size != st.size or (after.size, after.mtime_ns) != (st.size, st.mtime_ns):
        return hashing.HashOutcome(
            "error", error="the file changed while it was being hashed"
        )
    return hashed


def fingerprint_file(share, rel: str, throttle, *, adopted: bool = False):
    """Stat, hash and re-check one file. Returns (outcome, stat or None, mtime or None). Used for a file a
    person has linked (adopted) and for retrying a hash that failed; both write file_fingerprints."""
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
    out = hashing.hash_file(share, rel, throttle=throttle, adopted=adopted)
    out = still_the_same(share, rel, st, out)
    return out, st, db.to_datetime(st.mtime_ns)


class ShareUnavailable(Exception):  # noqa: N818 (a condition, not a bug)
    """The share is not there (or going away): abort, mark nothing gone."""


@dataclass
class ScanStats:
    registered: int = 0
    errors: int = 0
    listed_dirs: int = 0
    gone: int = 0
    repointed: int = 0
    owners_scanned: int = 0
    aborted: bool = False
    interrupted: bool = False
    last_error: str | None = None
    unmatched: list[str] | None = (
        None  # set by a scan of everyone; None leaves the stored list alone
    )
    new_candidates: list[str] = field(default_factory=list)

    def error(self, msg: str) -> None:
        self.errors += 1
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
    ):
        self.share = share
        self.store = store
        self.throttle = throttle
        self.lookup = lookup
        self.ocr = ocr
        self.ocr_func = ocr_func
        self.profiles = profiles
        self.stop = stop
        self.activity = activity
        self._clock = clock
        self._wall = wall
        self._last_activity = 0.0
        self._failures = 0  # consecutive failed reads

    # ---- the share is there ----------------------------------------------------------

    def verify_share(self, bases=(), owner: owners.Owner | None = None) -> None:
        """Raise ShareUnavailable unless the share root, the base folders in use and the owner's folder
        all answer as directories. An empty mount point (the share not mounted) fails here."""
        paths = ["", *bases] + ([owner.root] if owner is not None else [])
        for path in paths:
            try:
                is_dir = self.share.stat(path).is_dir
            except OSError as exc:
                raise ShareUnavailable(
                    f"{path or 'the share root'} does not answer ({type(exc).__name__})"
                ) from exc
            if not is_dir:
                raise ShareUnavailable(f"{path or 'the share root'} is not a directory")

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
        """Scan everyone (person_id None), or one person's personal folder. Never raises for a share
        problem: it returns stats with `aborted` set."""
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
        return stats

    def _scan(self, stats: ScanStats, person_id: str | None) -> None:
        people = self.store.load_people()
        if person_id is not None:
            people = [p for p in people if p["person_id"] == person_id]
        teams = [] if person_id is not None else self.store.load_teams()
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
            self.scan_owner(owner, bases, stats)
            if stats.interrupted:
                return

    def _exists(self, rel: str) -> bool:
        try:
            return self.share.stat(rel).is_dir
        except OSError:
            return False

    # ---- one owner -------------------------------------------------------------------

    def scan_owner(self, owner: owners.Owner, bases, stats: ScanStats) -> None:
        self._tell(f"scanning {owner.root}", force=True)
        self.verify_share(bases, owner)
        store = self.store
        dirs = store.load_dirs(owner)
        cands = store.load_candidates(owner)
        origin = "new" if store.owner_baselined(owner) else "backlog"
        children: dict[str, set[str]] = {}
        for d in dirs:
            if d != owner.root:
                children.setdefault(d.rpartition("/")[0], set()).add(d)
        by_dir: dict[str, list[db.Cand]] = {}
        for c in cands.values():
            by_dir.setdefault(c.rel_path.rpartition("/")[0], []).append(c)

        gone: list[db.Cand] = []
        vanished_dirs: list[str] = []
        fresh: list[_Fresh] = []
        owner_errors_before = stats.errors
        root_listed = False
        stack: list[tuple[str, int]] = [(owner.root, 0)]
        while stack:
            if self.stop():
                stats.interrupted = True
                store.commit()
                return
            d, depth = stack.pop()
            if depth > MAX_DEPTH:
                stats.error(f"{d}: deeper than {MAX_DEPTH} levels, not scanned")
                continue
            try:
                st = self.share.stat(d)
                self._failures = 0
            except FileNotFoundError:
                if d == owner.root:
                    raise ShareUnavailable(f"{owner.root} is gone") from None
                vanished_dirs.append(d)
                self._failures += 1
                if self._failures >= MAX_CONSECUTIVE_FAILURES:
                    raise ShareUnavailable("known folders keep vanishing") from None
                continue
            except OSError as exc:
                self._note_failure(exc)
                stats.error(f"{d}: cannot stat ({type(exc).__name__})")
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
            )
            if listing_ok and d == owner.root:
                root_listed = True

        # Marking things gone is the dangerous step: only after the share has answered again.
        if gone or vanished_dirs:
            self.verify_share(bases, owner)
            lost = {c.candidate_id: c for c in gone if c.state == "new"}
            for v in (
                vanished_dirs
            ):  # everything that was under a folder that is no longer there
                for c in cands.values():
                    if c.state == "new" and c.rel_path.startswith(v + "/"):
                        lost[c.candidate_id] = c
            lost_list = sorted(lost.values(), key=lambda c: c.rel_path)
            self._reconcile_moves(lost_list, fresh, stats)
            stats.gone += store.mark_gone([c.candidate_id for c in lost_list])
            store.forget_dirs_under(owner, vanished_dirs)
        stats.owners_scanned += 1
        if root_listed and stats.errors == owner_errors_before:
            store.mark_baselined(owner)
        store.commit()

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
    ) -> bool:
        """List one changed directory and register its new files. True when it was listed completely
        (the cache row is then updated); False leaves the cache as it was so the next scan lists it again."""
        store = self.store
        try:
            entries = self.share.scandir(d)
            self._failures = 0
        except FileNotFoundError:
            if d == owner.root:
                raise ShareUnavailable(f"{owner.root} is gone") from None
            vanished_dirs.append(d)
            return False
        except OSError as exc:
            self._note_failure(exc)
            stats.error(f"{d}: cannot list ({type(exc).__name__})")
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
        wanted = {f"{d}/{n}" for n in subdirs}
        for known in sorted(children.get(d, ())):
            if known not in wanted:
                vanished_dirs.append(known)
        present = {f"{d}/{e.name}" for e in files}
        for c in by_dir.get(d, ()):
            if c.state == "new" and c.rel_path not in present:
                gone.append(c)
        complete = True
        for e in files:
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
            try:
                f = self._new_file(owner, rel, e.name, origin, stats)
            except OSError as exc:
                self._note_failure(exc)
                stats.error(f"{rel}: cannot read its details ({type(exc).__name__})")
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
        for n in subdirs:
            child = f"{d}/{n}"
            if child not in children.get(d, ()):
                # Seen, not listed yet: if this scan stops before it gets there, the next one still does.
                store.upsert_dir(owner, child, None, listed=False)
                children.setdefault(d, set()).add(child)
        if complete:
            # A directory changed in the last moments may change again within the same clock tick, which
            # its modification time cannot show. Leave its time out of the cache so the next scan lists it.
            racy = self._wall() - mtime.timestamp() < RACY_WINDOW_S
            store.upsert_dir(owner, d, None if racy else mtime, listed=True)
        store.commit()
        stack.extend((f"{d}/{n}", depth + 1) for n in reversed(subdirs))
        return complete

    # ---- one new file ----------------------------------------------------------------

    def _new_file(self, owner, rel, name, origin, stats) -> _Fresh | None:
        st = self.share.stat(
            rel
        )  # one metadata call; raises OSError for the caller to count
        self._failures = 0
        cls = kinds.kind_by_name(name)
        hashed = None
        if cls.kind in ("image", "surface_scan"):
            keep = (
                CLASSIFY_MAX_BYTES
                if cls.kind == "image" and st.size <= CLASSIFY_MAX_BYTES
                else 0
            )
            hashed = hashing.hash_file(
                self.share, rel, throttle=self.throttle, keep_up_to=keep
            )
            hashed = self._still_the_same(rel, st, hashed)
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
        rec = recognise.recognise(rel, self.lookup)
        result = self.store.register_file(
            owner=owner,
            rel=rel,
            size=st.size,
            mtime=db.to_datetime(st.mtime_ns),
            classification=cls,
            recognition=rec,
            origin=origin,
            hashed=hashed,
        )
        if not result.created or result.candidate_id is None:
            return None
        stats.registered += 1
        stats.new_candidates.append(result.candidate_id)
        fid = str(self._file_id(rel))
        cand = db.Cand(result.candidate_id, fid, rel, "new", cls.kind)
        sha = hashed.sha256 if hashed is not None and hashed.status == "done" else None
        return _Fresh(cand, sha, st.size, db.to_datetime(st.mtime_ns))

    def _still_the_same(
        self, rel, st, hashed: hashing.HashOutcome
    ) -> hashing.HashOutcome:
        return still_the_same(self.share, rel, st, hashed)

    @staticmethod
    def _file_id(rel):
        from .identity import file_id

        return file_id(rel)

    # ---- moves -----------------------------------------------------------------------

    def _reconcile_moves(self, gone: list[db.Cand], fresh: list[_Fresh], stats) -> None:
        """A vanished undecided file and a new file with the same content, one of each: it moved.
        Re-point the candidate instead of marking it gone. Ambiguous matches are left as gone + new."""
        if not gone or not fresh:
            return
        gone_by_sha: dict[str, list[db.Cand]] = {}
        for c in list(gone):
            if c.state != "new" or c.kind not in ("image", "sem_image", "surface_scan"):
                continue
            sha = self.store.fingerprint_of(c.directus_files_id)
            if sha:
                gone_by_sha.setdefault(sha, []).append(c)
        fresh_by_sha: dict[str, list[_Fresh]] = {}
        for f in fresh:
            if f.sha:
                fresh_by_sha.setdefault(f.sha, []).append(f)
        for sha, olds in gone_by_sha.items():
            news = fresh_by_sha.get(sha, [])
            if len(olds) == 1 and len(news) == 1:
                old, new = olds[0], news[0]
                if self.store.repoint_candidate(old, new.cand, new.size, new.mtime):
                    gone[:] = [c for c in gone if c is not old]
                    stats.repointed += 1
                    log.info("re-pointed %s to %s", old.rel_path, new.cand.rel_path)
