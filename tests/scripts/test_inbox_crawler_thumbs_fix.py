# ruff: noqa: F811
"""Review fixes of the thumbnails backfill: who it may read for (M1), the failure marker (M2), a share hiccup
(Minor3) and transparent pictures.

Reuses the helpers of test_inbox_crawler_thumbs.py (a recording Share, the `folder` fixture, small pictures).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

pytest.importorskip("PIL")
from inbox_crawler import owners  # noqa: E402
from test_inbox_crawler_thumbs import (  # noqa: E402, F401
    folder,
    offered,
    picture,
    run_scan,
    settle,
)
from test_inbox_crawler_world import world  # noqa: E402, F401

ALL = ["a.png", "b.png", "broken.png"]


def pid_of(world, alias="abc12de"):
    return world.one(
        "SELECT person_id::text FROM people WHERE uni_alias = %s", (alias,)
    )[0]


def link_all(world):
    """Linked candidates survive an alias or share-folder change (migration 193's trigger deletes the others)."""
    world.q(
        "UPDATE file_candidates SET state = 'linked', link_kind = 'manual', "
        "linked_collection = 'physical_samples', linked_junction_id = gen_random_uuid(), "
        "link_batch_id = gen_random_uuid()"
    )
    world.commit()


@pytest.fixture
def only_folders():
    yield owners.set_only_folders
    owners.set_only_folders(None)


# ---- M1: the backfill reads only what the scan would read ------------------------------------


def test_a_scanned_person_still_gets_pictures(folder):
    _, _, store = run_scan(folder, thumbnails=False)
    assert sorted(offered(store)) == ALL


def test_a_former_person_is_not_read_for_but_scan_while_former_is(folder):
    world = folder
    _, _, store = run_scan(world, thumbnails=False)
    world.q("UPDATE people SET active = false WHERE uni_alias = 'abc12de'")
    world.commit()
    assert offered(store) == []
    world.q("UPDATE people SET scan_while_former = true WHERE uni_alias = 'abc12de'")
    world.commit()
    assert sorted(offered(store)) == ALL


def test_candidates_left_under_an_old_alias_are_not_read_for(folder):
    world = folder
    _, _, store = run_scan(world, thumbnails=False)
    link_all(world)
    world.q("UPDATE people SET uni_alias = 'zzz99yy' WHERE uni_alias = 'abc12de'")
    world.commit()
    assert offered(store) == []
    # the folder the candidates sit in is the owner's CURRENT one again once the alias is back (any case)
    world.q("UPDATE people SET uni_alias = 'ABC12DE' WHERE uni_alias = 'zzz99yy'")
    world.commit()
    assert sorted(offered(store)) == ALL


def test_a_candidate_of_somebody_elses_folder_is_not_read_for(folder):
    world = folder
    _, _, store = run_scan(world, thumbnails=False)
    other, _ = world.person("xyz98ab")
    world.q(
        "UPDATE file_candidates SET owner_person_id = %s WHERE rel_path = %s",
        (other, A),
    )
    world.commit()
    assert sorted(offered(store)) == ["b.png", "broken.png"]


def test_a_team_folder_is_read_for_until_its_share_folder_changes(world):
    team = world.team("Metals")
    world.write("Shared/Metals/t.png", picture())
    settle(world)
    _, _, store = run_scan(world, thumbnails=False)
    assert offered(store) == ["t.png"]
    link_all(world)
    world.q("UPDATE teams SET share_folder = 'Ceramics' WHERE team_id = %s", (team,))
    world.commit()
    assert offered(store) == []


def test_only_folders_limits_the_backfill_like_the_scan(folder, only_folders):
    world = folder
    team = world.team("Metals")
    world.write("Shared/Metals/t.png", picture())
    settle(world)
    _, _, store = run_scan(world, thumbnails=False)
    assert sorted(offered(store)) == ALL + ["t.png"]
    only_folders("somebody-else")
    assert offered(store) == []
    only_folders("ABC12DE")  # case does not matter, as in the scan
    assert sorted(offered(store)) == ALL
    only_folders("metals")
    assert offered(store) == ["t.png"]
    del team


def test_an_ignored_folder_is_not_read_for(folder):
    world = folder
    _, _, store = run_scan(world, thumbnails=False)
    world.ignore("SEM", person=pid_of(world))  # the share is case-insensitive
    world.commit()
    assert offered(store) == ["broken.png"]
    world.unignore("SEM", person=pid_of(world))
    world.commit()
    assert sorted(offered(store)) == ALL


def test_a_team_ignore_rule_hides_only_that_teams_folder(folder):
    world = folder
    team = world.team("Metals")
    world.write("Shared/Metals/sub/t.png", picture())
    settle(world)
    _, _, store = run_scan(world, thumbnails=False)
    world.ignore("sub", team=team)
    world.commit()
    assert sorted(offered(store)) == ALL
