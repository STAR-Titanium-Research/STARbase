"""INBOX_PERSON_DIR names the folder of personal folders: the lab share spells it `User`, the spec `Users`."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from inbox_crawler import owners  # noqa: E402


@pytest.fixture(autouse=True)
def _restore():
    before = owners.PERSON_BASE
    yield
    owners.PERSON_BASE = before


def test_the_default_is_the_spec_spelling():
    assert owners.PERSON_BASE == "Users"


@pytest.mark.parametrize("empty", [None, "", "  "])
def test_unset_or_empty_keeps_the_current_folder(empty):
    owners.set_person_base(empty)
    assert owners.PERSON_BASE == "Users"


def test_a_folder_name_is_used():
    owners.set_person_base("User")
    assert owners.PERSON_BASE == "User"


@pytest.mark.parametrize("bad", ["User/x", "User\\x", ".", ".."])
def test_a_path_or_dots_is_refused(bad):
    with pytest.raises(ValueError):
        owners.set_person_base(bad)
    assert owners.PERSON_BASE == "Users"


@pytest.fixture
def only_folders():
    yield owners.set_only_folders
    owners.set_only_folders(None)


PEOPLE = [
    {"person_id": "p1", "uni_alias": "mtp21dp", "active": True},
    {"person_id": "p2", "uni_alias": "abc12de", "active": True},
]


def test_no_allow_list_scans_everyone(only_folders):
    only_folders("")
    assert [c[3] for c in owners.person_claims(PEOPLE)] == [True, True]


def test_the_allow_list_skips_everyone_else_ignoring_case(only_folders):
    only_folders(" MTP21DP , ")
    assert [(c[1], c[3]) for c in owners.person_claims(PEOPLE)] == [
        ("mtp21dp", True),
        ("abc12de", False),
    ]
    assert owners.team_claims([{"team_id": "t1", "share_folder": "Grp"}])[0][3] is False


def test_a_skipped_folder_is_neither_scanned_nor_unmatched(only_folders):
    only_folders("mtp21dp")
    m = owners.match_folders(
        "User", ["mtp21dp", "abc12de", "zz9"], owners.person_claims(PEOPLE), "person"
    )
    assert [o.root for o in m.owners] == ["User/mtp21dp"]
    assert m.skipped == ["User/abc12de"]
    assert m.unmatched == ["User/zz9"]
