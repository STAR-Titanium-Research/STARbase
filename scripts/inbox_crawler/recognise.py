"""Recognise the record a file's path names (spec section 6). Pure: no database, no file system.

Three ways a path can name a record, strongest first:

* `short_id`  a path token that is exactly a known short ID (8 to 32 lower-case hex characters; a token
  made only of digits is ignored, so a date such as 20261015 is never a short ID);
* `code`      a full sample, operation or test code found as a whole delimited substring of the path;
* `edge_code` an insert-edge code (H13A-#2-fC) found the same way.

`recognise` reads only the `Lookup` it is given (the database layer builds one from `short_ids` and the code
columns), so it is testable without a database. When two or more records are named at the strongest level
they are all listed in `matches` and nothing is suggested; a suggestion is made only when exactly one
record is named at that level. A weaker level is never used to break a tie at a stronger one.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

# The characters a path is split on: / \ _ - . and space.
DELIMS = "/\\_-. "
_TOKEN = re.compile(r"[^/\\_\-. ]+")
_HEX_ID = re.compile(r"[0-9a-f]{8,32}")

# A code shorter than this would match noise ("A1" in any folder name).
MIN_CODE_LEN = 4

Ref = tuple[str, str]  # (collection, record id as text)


@dataclass(frozen=True)
class Lookup:
    """What the path is checked against. Keys are lower-cased; values are the records that carry it."""

    short_ids: Mapping[str, tuple[Ref, ...]] = field(default_factory=dict)
    codes: Mapping[str, tuple[Ref, ...]] = field(default_factory=dict)
    edge_codes: Mapping[str, tuple[Ref, ...]] = field(default_factory=dict)


@dataclass(frozen=True)
class Recognition:
    match_strength: str  # short_id | code | edge_code | none
    matches: list[dict]  # {collection, record_id, via, token} at the strongest level
    suggested_collection: str | None
    suggested_record_id: str | None


NO_MATCH = Recognition("none", [], None, None)


def usable_code(code) -> bool:
    """Whether a record code is specific enough to look for in a path."""
    if not code or not isinstance(code, str):
        return False
    c = code.strip()
    if len(c) < MIN_CODE_LEN or c.isdigit():
        return False
    return not c.lower().startswith(
        "tmp-"
    )  # a placeholder the database hands out before the real code


def _index(rows: Iterable[tuple], keep) -> dict[str, tuple[Ref, ...]]:
    out: dict[str, list[Ref]] = {}
    for key, collection, record_id in rows:
        if not keep(key):
            continue
        ref = (collection, str(record_id))
        bucket = out.setdefault(key.strip().lower(), [])
        if ref not in bucket:
            bucket.append(ref)
    return {k: tuple(v) for k, v in out.items()}


def build_lookup(short_id_rows, code_rows, edge_rows) -> Lookup:
    """From (short_id | code, collection, record_id) rows, as the database layer reads them."""
    return Lookup(
        short_ids=_index(
            short_id_rows, lambda s: bool(s) and bool(_HEX_ID.fullmatch(s.lower()))
        ),
        codes=_index(code_rows, usable_code),
        edge_codes=_index(edge_rows, usable_code),
    )


def _lower(text: str) -> str:
    # str.lower() can change a string's length (some non-ASCII letters); the spans below index the
    # original text, so keep every character's position.
    return "".join(c.lower() if len(c.lower()) == 1 else c for c in text)


def _short_id_hits(low: str, original: str, lookup: Lookup) -> list[tuple[Ref, str]]:
    hits: list[tuple[Ref, str]] = []
    for m in _TOKEN.finditer(low):
        tok = m.group()
        if not _HEX_ID.fullmatch(tok) or tok.isdigit():
            continue
        for ref in lookup.short_ids.get(tok, ()):
            hits.append((ref, original[m.start() : m.end()].lower()))
    return hits


def _code_hits(
    low: str, original: str, codes: Mapping[str, tuple[Ref, ...]]
) -> list[tuple[Ref, str]]:
    if not codes:
        return []
    n = len(low)
    longest = max(len(c) for c in codes)
    starts = [i for i in range(n) if i == 0 or low[i - 1] in DELIMS]
    ends = [j for j in range(1, n + 1) if j == n or low[j] in DELIMS]
    spans: list[tuple[int, int, Ref, str]] = []
    for i in starts:
        for j in ends:
            if j - i < MIN_CODE_LEN:
                continue
            if j - i > longest:
                break
            for ref in codes.get(low[i:j], ()):
                spans.append((i, j, ref, original[i:j]))
    # A code inside a longer matched code is part of it (a test code starts with its sample code), not a
    # second record named.
    kept = [
        s
        for s in spans
        if not any(
            o[0] <= s[0] and s[1] <= o[1] and (o[1] - o[0]) > (s[1] - s[0])
            for o in spans
        )
    ]
    return [(ref, text) for _i, _j, ref, text in kept]


def _distinct(hits: list[tuple[Ref, str]], via: str) -> list[dict]:
    seen: dict[Ref, dict] = {}
    for ref, token in hits:
        if ref not in seen:
            seen[ref] = {
                "collection": ref[0],
                "record_id": ref[1],
                "via": via,
                "token": token,
            }
    return [seen[r] for r in sorted(seen)]


def recognise(rel_path: str, lookup: Lookup) -> Recognition:
    """The strongest record(s) the path names, and a suggestion when exactly one record is named."""
    if not rel_path:
        return NO_MATCH
    low = _lower(rel_path)
    levels = (
        ("short_id", lambda: _short_id_hits(low, rel_path, lookup)),
        ("code", lambda: _code_hits(low, rel_path, lookup.codes)),
        ("edge_code", lambda: _code_hits(low, rel_path, lookup.edge_codes)),
    )
    for strength, find in levels:
        matches = _distinct(find(), "short_id" if strength == "short_id" else strength)
        if matches:
            if len(matches) == 1:
                m = matches[0]
                return Recognition(strength, matches, m["collection"], m["record_id"])
            return Recognition(strength, matches, None, None)
    return NO_MATCH
