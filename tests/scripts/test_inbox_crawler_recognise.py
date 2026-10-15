"""Recognition of a record named in a file's path (spec section 6, review focus 4).

`recognise` is pure: it consults a supplied lookup (known short IDs, record codes) and never a database.
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from inbox_crawler import recognise as rc  # noqa: E402

SAMPLE = str(uuid.UUID(int=1))
SAMPLE2 = str(uuid.UUID(int=2))
OP = str(uuid.UUID(int=3))
TEST = str(uuid.UUID(int=4))
EDGE = str(uuid.UUID(int=5))
EDGE2 = str(uuid.UUID(int=6))

SHORT_ROWS = [
    ("3fa9c1d2", "physical_samples", SAMPLE),
    ("ab12cd34", "physical_samples", SAMPLE2),
    ("0badf00d", "manufacturing_operations", OP),
    ("deadbeef12", "test_sessions", TEST),
    (
        "20261015",
        "test_sessions",
        str(uuid.UUID(int=9)),
    ),  # an all-digit short ID looks like a date
]
CODE_ROWS = [
    ("116-RK-MH-2024-12-18", "physical_samples", SAMPLE),
    ("SB-24-0117", "physical_samples", SAMPLE2),
    ("22-04-21-MF25-4624-950C_11kN_20dia", "manufacturing_operations", OP),
    ("116-RK-MH-2024-12-18-SEM1", "test_sessions", TEST),
]
EDGE_ROWS = [
    ("H13A-#2-fC", "insert_edges", EDGE),
    ("H13A-#3-fC", "insert_edges", EDGE2),
]


@pytest.fixture
def lookup():
    return rc.build_lookup(SHORT_ROWS, CODE_ROWS, EDGE_ROWS)


def one(rel, lookup):
    return rc.recognise(rel, lookup)


# ---- short IDs -----------------------------------------------------------------------


def test_a_short_id_in_the_file_name_is_a_suggestion(lookup):
    r = one("Users/abc12de/sem/3fa9c1d2.tif", lookup)
    assert r.match_strength == "short_id"
    assert (r.suggested_collection, r.suggested_record_id) == (
        "physical_samples",
        SAMPLE,
    )
    assert r.matches == [
        {
            "collection": "physical_samples",
            "record_id": SAMPLE,
            "via": "short_id",
            "token": "3fa9c1d2",
        }
    ]


@pytest.mark.parametrize(
    "rel",
    [
        "Users/a/3fa9c1d2/IMG_0001.tif",  # in a folder name
        "Users/a/IMG_3fa9c1d2.tif",  # after an underscore
        "Users/a/IMG-3fa9c1d2-x.tif",  # between hyphens
        "Users/a/IMG 3fa9c1d2 x.tif",  # between spaces
        "Users/a/IMG.3fa9c1d2.tif",  # between dots
        "Users\\a\\3fa9c1d2.tif",  # a backslash path
        "Users/a/3FA9C1D2.TIF",  # upper case
        "Users/a/3fa9c1d2-0000-4000-8000-000000000001.tif",  # a whole UUID: its first group is the short ID
    ],
)
def test_delimiters_and_case(rel, lookup):
    r = one(rel, lookup)
    assert r.match_strength == "short_id", rel
    assert r.suggested_record_id == SAMPLE


@pytest.mark.parametrize(
    "rel",
    [
        "Users/a/img3fa9c1d2.tif",  # glued to letters: not its own token
        "Users/a/3fa9c1d2x.tif",
        "Users/a/x3fa9c1d2.tif",
        "Users/a/3fa9c1d.tif",  # one character short
        "Users/a/3fa9c1d2e.tif",  # longer than the known ID
        "Users/a/3fa9c1d2ab.tif",
        "Users/a/c0ffee11.tif",  # 8 hex characters that no record has
    ],
)
def test_a_token_must_be_exactly_a_known_short_id(rel, lookup):
    r = one(rel, lookup)
    assert r.match_strength == "none", rel
    assert r.matches == [] and r.suggested_record_id is None


def test_a_longer_short_id_matches_exactly(lookup):
    r = one("Users/a/deadbeef12.png", lookup)
    assert (r.suggested_collection, r.suggested_record_id) == ("test_sessions", TEST)


@pytest.mark.parametrize(
    "rel",
    [
        "Users/a/20261015.tif",
        "Users/a/scan_20261015_1530.tif",
        "Users/a/20261015/img.tif",
    ],
)
def test_a_date_is_never_a_short_id_even_when_a_record_has_that_id(rel, lookup):
    r = one(rel, lookup)
    assert r.match_strength == "none", rel
    assert r.suggested_record_id is None


def test_all_digit_tokens_of_any_length_are_ignored():
    lk = rc.build_lookup([("1234567890", "physical_samples", SAMPLE)], [], [])
    assert one("Users/a/1234567890.tif", lk).match_strength == "none"


def test_two_records_in_one_path_are_listed_but_never_suggested(lookup):
    r = one("Users/a/3fa9c1d2_ab12cd34.tif", lookup)
    assert r.match_strength == "short_id"
    assert r.suggested_collection is None and r.suggested_record_id is None
    assert {m["record_id"] for m in r.matches} == {SAMPLE, SAMPLE2}


def test_two_records_split_between_folder_and_file_are_ambiguous(lookup):
    r = one("Users/a/3fa9c1d2/ab12cd34.tif", lookup)
    assert r.suggested_record_id is None
    assert len(r.matches) == 2


def test_the_same_short_id_twice_is_one_record(lookup):
    r = one("Users/a/3fa9c1d2/3fa9c1d2_a.tif", lookup)
    assert r.suggested_record_id == SAMPLE
    assert len(r.matches) == 1


def test_two_records_sharing_a_token_are_never_a_suggestion():
    # the lookup says one token names two records (it cannot happen for short IDs, which are unique,
    # but the pure function must still refuse it)
    lk = rc.Lookup(
        short_ids={"3fa9c1d2": (("physical_samples", SAMPLE), ("test_sessions", TEST))},
        codes={},
        edge_codes={},
    )
    r = one("Users/a/3fa9c1d2.tif", lk)
    assert r.match_strength == "short_id"
    assert r.suggested_record_id is None and len(r.matches) == 2


# ---- full codes ----------------------------------------------------------------------


def test_a_sample_code_in_the_path_is_a_code_match(lookup):
    r = one("Users/a/116-RK-MH-2024-12-18/IMG_0001.tif", lookup)
    assert r.match_strength == "code"
    assert (r.suggested_collection, r.suggested_record_id) == (
        "physical_samples",
        SAMPLE,
    )
    assert r.matches[0]["via"] == "code"
    assert r.matches[0]["token"] == "116-RK-MH-2024-12-18"


def test_an_operation_code_and_a_test_code_are_codes_too(lookup):
    op = one("Users/a/22-04-21-MF25-4624-950C_11kN_20dia.mat", lookup)
    assert (op.suggested_collection, op.suggested_record_id) == (
        "manufacturing_operations",
        OP,
    )
    t = one("Users/a/116-RK-MH-2024-12-18-SEM1_001.tif", lookup)
    assert (t.suggested_collection, t.suggested_record_id) == ("test_sessions", TEST)


def test_a_longer_code_swallows_the_shorter_code_inside_it(lookup):
    # the test code starts with the sample code: that is one record named, not two
    r = one("Users/a/116-RK-MH-2024-12-18-SEM1.tif", lookup)
    assert r.suggested_record_id == TEST
    assert len(r.matches) == 1


def test_codes_match_whatever_the_case(lookup):
    r = one("Users/a/sb-24-0117.tif", lookup)
    assert r.suggested_record_id == SAMPLE2
    assert r.matches[0]["token"] == "sb-24-0117"  # as written in the path


@pytest.mark.parametrize(
    "rel",
    [
        "Users/a/xSB-24-0117.tif",  # glued to a letter before
        "Users/a/SB-24-0117x.tif",  # glued after
        "Users/a/SB-24-01170.tif",  # a longer number
        "Users/a/SB-24.tif",  # only part of the code
    ],
)
def test_a_code_must_be_a_whole_delimited_substring(rel, lookup):
    assert one(rel, lookup).match_strength == "none", rel


def test_a_code_shared_by_two_records_is_ambiguous():
    lk = rc.build_lookup(
        [],
        [
            ("PASS-0042", "manufacturing_operations", OP),
            ("PASS-0042", "manufacturing_operations", str(uuid.UUID(int=7))),
        ],
        [],
    )
    r = one("Users/a/PASS-0042.mat", lk)
    assert r.match_strength == "code"
    assert r.suggested_record_id is None and len(r.matches) == 2


def test_codes_that_would_match_noise_are_left_out_of_the_lookup():
    lk = rc.build_lookup(
        [],
        [
            ("A1", "physical_samples", SAMPLE),  # too short
            ("2024", "physical_samples", SAMPLE2),  # only digits: a year
            ("TMP-1b2c3d4e-0000", "physical_samples", OP),  # a placeholder code
            ("", "physical_samples", TEST),
            (None, "physical_samples", TEST),
        ],
        [],
    )
    assert lk.codes == {}
    assert one("Users/a/A1/2024/TMP-1b2c3d4e-0000.tif", lk).match_strength == "none"


# ---- edge codes and the strength order ------------------------------------------------


def test_an_edge_code_is_the_weakest_suggestion(lookup):
    r = one("Users/a/H13A-#2-fC/scan.tif", lookup)
    assert r.match_strength == "edge_code"
    assert (r.suggested_collection, r.suggested_record_id) == ("insert_edges", EDGE)


def test_two_edges_in_a_path_are_never_a_suggestion(lookup):
    r = one("Users/a/H13A-#2-fC_H13A-#3-fC.tif", lookup)
    assert r.match_strength == "edge_code"
    assert r.suggested_record_id is None and len(r.matches) == 2


def test_short_id_beats_code_beats_edge_code(lookup):
    p = "Users/a/H13A-#2-fC/116-RK-MH-2024-12-18/{}.tif"
    both = one(p.format("ab12cd34"), lookup)
    assert both.match_strength == "short_id" and both.suggested_record_id == SAMPLE2
    assert [m["via"] for m in both.matches] == [
        "short_id"
    ]  # only the strongest level is listed
    code_edge = one(p.format("IMG_1"), lookup)
    assert (
        code_edge.match_strength == "code" and code_edge.suggested_record_id == SAMPLE
    )
    only_edge = one("Users/a/H13A-#2-fC/IMG_1.tif", lookup)
    assert only_edge.match_strength == "edge_code"


def test_an_ambiguous_strong_level_does_not_fall_back_to_a_weaker_suggestion(lookup):
    r = one("Users/a/3fa9c1d2_ab12cd34/H13A-#2-fC.tif", lookup)
    assert r.match_strength == "short_id"
    assert r.suggested_record_id is None


def test_matches_are_in_a_stable_order(lookup):
    a = one("Users/a/ab12cd34_3fa9c1d2.tif", lookup)
    b = one("Users/a/3fa9c1d2_ab12cd34.tif", lookup)
    assert a.matches == b.matches


# ---- nothing to find / purity ---------------------------------------------------------


@pytest.mark.parametrize("rel", ["", "Users/a/IMG_0001.tif", "Users/abc12de/sem"])
def test_nothing_named_gives_none(rel, lookup):
    r = one(rel, lookup)
    assert r.match_strength == "none"
    assert (
        r.matches == []
        and r.suggested_collection is None
        and r.suggested_record_id is None
    )


def test_the_empty_lookup_matches_nothing():
    assert (
        one("Users/a/3fa9c1d2.tif", rc.build_lookup([], [], [])).match_strength
        == "none"
    )


def test_recognition_is_pure_and_never_touches_a_database():
    src = (ROOT / "scripts/inbox_crawler/recognise.py").read_text(encoding="utf-8")
    for word in ("psycopg2", "import db", "from . import db", "SELECT ", "cursor"):
        assert word not in src, word
