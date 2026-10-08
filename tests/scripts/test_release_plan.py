"""release_plan.py writes the GitHub Release notes grouped by category (#137).

The notes become the body of the Release, which the desktop app shows in its update dialog, so
a regression here changes what operators read. Loaded by path: .github/scripts is not a package.
"""

import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / ".github" / "scripts" / "release_plan.py"

spec = importlib.util.spec_from_file_location("release_plan", SCRIPT)
release_plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_plan)

CHANGELOG_TS = """export const CHANGELOG: ChangelogEntry[] = [
	{
		version: '9.9.9',
		date: '2026-10-08',
		notes: [
			'Record page: a Move panel button.',
			'Improved: the plot loads faster.',
			'Fixed: the FFT stayed blank until a channel chip was clicked.',
			'Security: the relay token is no longer logged.',
			'New: backup URL pre-filled.',
		],
	},
	{
		version: '9.9.8',
		date: '2026-10-01',
		notes: [
			'Only a new thing.',
		],
	},
];
"""


def test_group_notes_orders_groups_and_strips_prefixes():
    notes = [
        "Fixed: one.",
        "Record page: two.",
        "Improved: three.",
        "New: four.",
        "Security: five.",
        "fixed: six.",
    ]
    assert release_plan.group_notes(notes) == {
        "New": ["Record page: two.", "four.", "fixed: six."],
        "Improved": ["three."],
        "Fixed": ["one.", "Security: five."],
    }


def test_render_notes_writes_a_heading_per_non_empty_group():
    lines = release_plan.render_notes(["Fixed: a.", "b."])
    assert lines == ["### New", "", "- b.", "", "### Fixed", "", "- a."]
    assert release_plan.render_notes(["Only new."]) == ["### New", "", "- Only new."]


def test_changelog_entry_round_trips_into_grouped_markdown():
    _date, notes = release_plan.changelog_entry(CHANGELOG_TS, "9.9.9")
    md = "\n".join(release_plan.render_notes(notes))
    assert "### Fixed" in md and "### Improved" in md and "### New" in md
    assert md.index("### New") < md.index("### Improved") < md.index("### Fixed")
    assert "- the FFT stayed blank until a channel chip was clicked." in md
    assert "Fixed: the FFT" not in md


@pytest.fixture
def repo_tree(tmp_path, monkeypatch):
    """A minimal tree of what main() reads, with version 9.9.9 unreleased."""
    (tmp_path / "apps/force-app/desktop").mkdir(parents=True)
    (tmp_path / "apps/force-app/web/src").mkdir(parents=True)
    (tmp_path / "apps/force-app/desktop/package.json").write_text(
        json.dumps({"version": "9.9.9"})
    )
    (tmp_path / "package-lock.json").write_text(
        json.dumps({"packages": {"apps/force-app/desktop": {"version": "9.9.9"}}})
    )
    (tmp_path / "apps/force-app/web/src/changelog.ts").write_text(CHANGELOG_TS)
    monkeypatch.chdir(tmp_path)
    for k, v in {
        "EVENT": "pull_request",
        "REF": "refs/pull/1/merge",
        "SHA": "a" * 40,
        "REPO": "",
    }.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    return tmp_path


def test_release_notes_file_has_fixed_heading(repo_tree, monkeypatch):
    out = repo_tree / "release-notes.md"
    monkeypatch.setattr(sys, "argv", ["release_plan.py", "--notes", str(out)])
    release_plan.main()
    text = out.read_text(encoding="utf-8")
    assert text.startswith("Force App 9.9.9 (2026-10-08)\n")
    assert (
        "### Fixed\n\n- the FFT stayed blank until a channel chip was clicked.\n"
        in text
    )
    assert "- Security: the relay token is no longer logged." in text
    assert text.rstrip().endswith("within about ten minutes.")


def test_real_changelog_notes_keep_every_fixed_note_under_fixed():
    text = (ROOT / "apps/force-app/web/src/changelog.ts").read_text(encoding="utf-8")
    top = re.search(r"version:\s*'([^']+)'", text).group(1)
    _, notes = release_plan.changelog_entry(text, top)
    assert notes
    groups = release_plan.group_notes(notes)
    assert sum(len(v) for v in groups.values()) == len(notes)
    assert len(groups.get("Fixed", [])) >= sum(
        1 for n in notes if n.startswith("Fixed: ")
    )


def test_web_and_release_plan_prefix_tables_match():
    """changelogGroups.ts (the in-app What's new) and release_plan.py (the GitHub Release body)
    each carry their own copy of the prefix table; a prefix added to one must be added to both."""
    text = (ROOT / "apps/force-app/web/src/changelogGroups.ts").read_text(
        encoding="utf-8"
    )
    table = re.search(r"NOTE_PREFIXES[^=]*=\s*\{(.*?)\n\};", text, re.S)
    assert table, "NOTE_PREFIXES table not found in changelogGroups.ts"
    web = {
        name: (group.capitalize(), strip == "true")
        for name, group, strip in re.findall(
            r"(\w+):\s*\{\s*group:\s*'(\w+)',\s*strip:\s*(true|false)\s*\}",
            table.group(1),
        )
    }
    assert web, "no prefixes parsed from changelogGroups.ts"
    assert web == release_plan.NOTE_PREFIXES
    order = re.search(r"GROUP_KEYS[^=]*=\s*\[(.*?)\]", text, re.S)
    assert order, "GROUP_KEYS not found in changelogGroups.ts"
    web_order = tuple(k.capitalize() for k in re.findall(r"'(\w+)'", order.group(1)))
    assert web_order == release_plan.NOTE_GROUPS
