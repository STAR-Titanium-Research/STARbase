"""Whose folder is whose (spec section 5, step 1). Pure: names in, owners out.

`Users/<uni alias>` is one person's personal folder, `Shared/<share folder>` is one team's. Folder names on
the share are untrusted input: an alias or folder name that holds a separator or is only dots is never
joined into a path, and hidden and snapshot directories are never entered.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

PERSON_BASE = "Users"
TEAM_BASE = "Shared"

# Directories no scan enters, whatever their depth. Hidden ('.snapshot', '.git'), NetApp-style snapshots
# ('~snapshot') that would expose every user's copies, and the usual file-server litter.
_SKIP_EXACT = frozenset(
    {"_dedup_removed", "$recycle.bin", "system volume information", "lost+found"}
)
_SKIP_PREFIXES = (".", "~snapshot")


@dataclass(frozen=True)
class Owner:
    kind: str  # 'person' | 'team'
    id: str  # people.person_id or teams.team_id
    root: (
        str  # the folder's share-relative path, as the share spells it ("Users/AB123")
    )
    label: str = ""  # for the log and the activity text: the alias or the folder name

    @property
    def person_id(self) -> str | None:
        return self.id if self.kind == "person" else None

    @property
    def team_id(self) -> str | None:
        return self.id if self.kind == "team" else None


def skip_dir(name: str) -> bool:
    """Whether a scan must not enter a directory of this name."""
    low = name.lower()
    return low in _SKIP_EXACT or low.startswith(_SKIP_PREFIXES)


def safe_folder_name(name) -> bool:
    """A name that can be one path component: no separator, not blank, not only dots, no NUL."""
    if not isinstance(name, str) or not name or name != name.strip():
        return False
    if "/" in name or "\\" in name or "\x00" in name:
        return False
    return set(name) != {"."} and not skip_dir(name)


@dataclass(frozen=True)
class Matching:
    owners: list[Owner]  # folders to scan
    skipped: list[
        str
    ]  # matched but not scanned (a Former person's folder): neither scanned nor unmatched
    unmatched: list[str]  # share-relative paths of folders that match nobody


def _pick(dirs: list[str], wanted: str) -> str | None:
    """The on-share spelling of a folder: an exact match, else a case-insensitive one (SMB is
    case-insensitive; the alias is unique ignoring case)."""
    if wanted in dirs:
        return wanted
    low = wanted.lower()
    same = sorted(d for d in dirs if d.lower() == low)
    return same[0] if same else None


def match_folders(
    base: str,
    dir_names: Iterable[str],
    claims: Iterable[tuple[str, str, str, bool]],
    kind: str,
) -> Matching:
    """Match the directories directly under `base` ('Users' or 'Shared') with who claims them.

    `claims` is (id, folder name, label, scannable): every person with an alias (scannable when
    active or `scan_while_former`), every team with a share folder (always scannable).
    """
    dirs = sorted(d for d in dir_names if safe_folder_name(d))
    owners: list[Owner] = []
    skipped: list[str] = []
    used: set[str] = set()
    for owner_id, folder, label, scannable in sorted(
        claims, key=lambda c: (str(c[1]).lower(), c[0])
    ):
        if not safe_folder_name(folder):
            continue  # never join a name with a separator in it into a path
        found = _pick([d for d in dirs if d not in used], folder)
        if found is None:
            continue
        used.add(found)
        path = f"{base}/{found}"
        if scannable:
            owners.append(Owner(kind, owner_id, path, label or folder))
        else:
            skipped.append(path)
    unmatched = [f"{base}/{d}" for d in dirs if d not in used]
    return Matching(owners, skipped, unmatched)


def person_claims(people: Iterable[dict]) -> list[tuple[str, str, str, bool]]:
    return [
        (
            str(p["person_id"]),
            p["uni_alias"],
            p["uni_alias"],
            bool(p.get("active", True)) or bool(p.get("scan_while_former", False)),
        )
        for p in people
        if p.get("uni_alias")
    ]


def team_claims(teams: Iterable[dict]) -> list[tuple[str, str, str, bool]]:
    return [
        (str(t["team_id"]), t["share_folder"], t.get("name") or t["share_folder"], True)
        for t in teams
        if t.get("share_folder")
    ]
