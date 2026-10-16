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
