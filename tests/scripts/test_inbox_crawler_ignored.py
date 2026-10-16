"""Ignored folders (spec section 15), the pure part: `owners.is_ignored` and `owners.below_root`.

IGNORE_CASES is a plain list so the JS twin's test in d1-inbox can mirror it row for row: (rel_folder, rules,
expected). Keep both tables the same when one changes.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from inbox_crawler import owners  # noqa: E402

# (rel_folder below the owner's root, the owner's rules, is it ignored?)
IGNORE_CASES = [
    # the folder itself, and anything beneath it
    ("World-Ti Paper", ["World-Ti Paper"], True),
    ("World-Ti Paper/Drafts", ["World-Ti Paper"], True),
    ("World-Ti Paper/Drafts/v2/figs", ["World-Ti Paper"], True),
    # whole path parts only: a lookalike name is not covered
    ("World-Ti Paper 2", ["World-Ti Paper"], False),
    ("World-Ti Paper 2/Drafts", ["World-Ti Paper"], False),
    ("World-Ti Paperwork", ["World-Ti Paper"], False),
    ("World-Ti", ["World-Ti Paper"], False),
    ("Old World-Ti Paper", ["World-Ti Paper"], False),
    # a rule does not cover its parent or its siblings
    ("World-Ti Paper", ["World-Ti Paper/Drafts"], False),
    ("World-Ti Paper/Final", ["World-Ti Paper/Drafts"], False),
    ("World-Ti Paper/Drafts", ["World-Ti Paper/Drafts"], True),
    ("World-Ti Paper/Drafts/old", ["World-Ti Paper/Drafts"], True),
    # the share is case-insensitive: so is the match, in both directions
    ("world-ti paper/drafts", ["World-Ti Paper"], True),
    ("WORLD-TI PAPER", ["world-ti paper"], True),
    ("World-Ti Paper/DRAFTS", ["world-ti paper/drafts"], True),
    # nested rules and several rules
    ("a/b/c", ["a/b", "a/b/c"], True),
    ("a/b", ["a/b/c", "a/b"], True),
    ("a/x", ["a/b", "a/b/c"], False),
    ("z", ["a", "z"], True),
    ("z/y", ["a", "z"], True),
    ("m", ["a", "z"], False),
    # no wildcards: a star or a question mark is an ordinary character
    ("anything", ["*"], False),
    ("a/b", ["a/*"], False),
    ("a/*", ["a/*"], True),
    # no rules, and the owner's root (empty) are never ignored
    ("a", [], False),
    ("", ["a"], False),
    ("", [], False),
    # a name with a dot or a space is just a name
    ("data.v2/raw", ["data.v2"], True),
    ("data.v2x", ["data.v2"], False),
    ("data v2", ["data.v2"], False),
]


@pytest.mark.parametrize(
    ("rel_folder", "rules", "expected"),
    IGNORE_CASES,
    ids=[f"{r!r}-{ru}" for r, ru, _e in IGNORE_CASES],
)
def test_is_ignored_cases(rel_folder, rules, expected):
    assert owners.is_ignored(rel_folder, rules) is expected
    # a compiled rule set answers the same, in any iteration order
    compiled = owners.ignore_rules(reversed(rules))
    assert owners.is_ignored(rel_folder, compiled) is expected


def test_an_empty_rule_is_no_rule():
    assert owners.ignore_rules(["", "a"]) == {"a"}
    assert owners.is_ignored("a", [""]) is False


def test_is_ignored_does_not_alter_the_rules():
    rules = ["World-Ti Paper"]
    owners.is_ignored("world-ti paper/x", rules)
    assert rules == ["World-Ti Paper"]


@pytest.mark.parametrize(
    ("root", "path", "expected"),
    [
        ("Users/ab1", "Users/ab1", ""),
        ("Users/ab1", "Users/ab1/sem", "sem"),
        ("Users/ab1", "Users/ab1/sem/raw", "sem/raw"),
        ("Users/ab1", "Users/ab12/sem", None),  # whole parts: not ab1's
        ("Users/ab1", "Users/ab1x", None),
        ("Users/ab1", "Shared/ab1/sem", None),
        ("Shared/Machining", "Shared/Machining/Old Jobs", "Old Jobs"),
    ],
)
def test_below_root(root, path, expected):
    assert owners.below_root(root, path) == expected
