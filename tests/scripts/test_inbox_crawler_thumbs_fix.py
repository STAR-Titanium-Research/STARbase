# ruff: noqa: F811
"""Review fixes of the thumbnails backfill: who it may read for (M1), the failure marker (M2), a share hiccup
(Minor3) and transparent pictures.

Reuses the helpers of test_inbox_crawler_thumbs.py (a recording Share, the `folder` fixture, small pictures).
"""

from __future__ import annotations

import io
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

pytest.importorskip("PIL")
from inbox_crawler import daemon, db, hashing, owners, thumbs  # noqa: E402
from PIL import Image  # noqa: E402
from test_inbox_crawler_thumbs import (  # noqa: E402, F401
    BROKEN,
    OLD,
    A,
    Share,
    folder,
    make_daemon,
    markers,
    offered,
    picture,
    run_scan,
    settle,
    thumb_rows,
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


# ---- M2: a file that cannot be decoded gets a marker, not a retry every restart --------------------


def marker_rows(world):
    return world.q(
        "SELECT c.rel_path, t.failed_reason, t.thumb IS NULL, t.preview IS NULL, t.source_size, "
        "t.source_mtime, c.size_bytes, c.source_mtime FROM file_thumbnails t "
        "JOIN file_candidates c USING (candidate_id) WHERE t.failed_reason IS NOT NULL"
    )


def test_registration_writes_a_marker_for_an_image_it_could_not_decode(folder):
    world = folder
    run_scan(world)
    (row,) = marker_rows(world)
    rel, reason, no_thumb, no_preview, size, mtime, c_size, c_mtime = row
    assert (rel, reason, no_thumb, no_preview) == (BROKEN, "not decoded", True, True)
    assert (size, mtime) == (c_size, c_mtime)  # keyed on the file as it was seen


def test_no_marker_is_written_when_thumbnails_are_off(folder):
    run_scan(folder, thumbnails=False)
    assert marker_rows(folder) == []


def test_a_marker_for_the_current_size_and_time_is_done_and_another_is_missing(folder):
    world = folder
    _, _, store = run_scan(world)
    assert offered(store) == []
    world.q(
        "UPDATE file_thumbnails SET source_size = source_size + 1 WHERE failed_reason IS NOT NULL"
    )
    world.commit()
    assert offered(store) == ["broken.png"]
    world.q(
        "UPDATE file_thumbnails SET source_size = source_size - 1 WHERE failed_reason IS NOT NULL"
    )
    world.q(
        "UPDATE file_thumbnails SET source_mtime = source_mtime + interval '1 second' "
        "WHERE failed_reason IS NOT NULL"
    )
    world.commit()
    assert offered(store) == ["broken.png"]


def test_the_backfill_marks_what_it_cannot_decode_and_a_restart_does_not_read_it_again(
    folder,
):
    world = folder
    run_scan(world, thumbnails=False)
    d, share, _ = make_daemon(world)
    assert d.thumbnail_pending() == 2
    assert markers(world) == {BROKEN: "not decoded"}
    assert share.opened(BROKEN) == 1
    d2, share2, _ = make_daemon(world)  # a new process: no in-memory set
    assert d2.thumbnail_pending() == 0
    assert share2.opened(BROKEN) == 0


def candidate(world, rel):
    return world.one(
        "SELECT candidate_id::text, size_bytes, source_mtime FROM file_candidates WHERE rel_path = %s",
        (rel,),
    )


def test_a_picture_replaces_a_marker_and_a_marker_replaces_a_picture(folder):
    world = folder
    _, _, store = run_scan(world)
    broken, ok = candidate(world, BROKEN), candidate(world, A)
    assert store.store_thumbnails(
        broken[0], thumbs.make_thumbnails(picture()), *broken[1:]
    )
    assert markers(world) == {}
    assert store.store_thumbnail_failure(ok[0], "not decoded", *ok[1:])
    store.commit()
    assert markers(world) == {A: "not decoded"}
    assert BROKEN in thumb_rows(world) and A not in thumb_rows(world)


def test_a_file_whose_bytes_were_not_kept_is_marked_too_large(folder, monkeypatch):
    world = folder
    run_scan(world, thumbnails=False)
    real = hashing.hash_file

    def no_bytes_kept(share, rel, **kw):
        out = real(share, rel, **kw)
        out.data = None  # as when the file is over keep_up_to
        return out

    monkeypatch.setattr(hashing, "hash_file", no_bytes_kept)
    d, _, _ = make_daemon(world)
    assert d.thumbnail_pending() == 0
    assert set(markers(world).values()) == {"too large"}
    assert len(markers(world)) == 3  # the three images


def test_the_database_refuses_a_half_marker(folder):
    world = folder
    run_scan(world)
    with pytest.raises(Exception, match="check"):
        world.q(
            "UPDATE file_thumbnails SET failed_reason = 'x' WHERE failed_reason IS NULL"
        )
    world.conn.rollback()


# ---- Minor3: a share hiccup stops the batch for this tick and blocks nobody -----------------------


class Hiccup(Share):
    """A Share whose stat of the listed paths fails like a share that does not answer."""

    def __init__(self, root, failing=()):
        super().__init__(root)
        self.failing = set(failing)

    def stat(self, rel=""):
        if rel in self.failing:
            raise OSError(5, "Input/output error")
        return super().stat(rel)


def hiccup_daemon(world, failing):
    store = db.Store(world.conn)
    share = Hiccup(world.root, failing)
    d = daemon.Daemon(
        store, share, None, config=daemon.Config(tick_s=0.01, error_sleep_s=0.01)
    )
    d.throttle = None
    return d, share


def test_a_share_hiccup_ends_the_batch_but_marks_nothing_as_tried(folder):
    world = folder
    _, _, store = run_scan(world, thumbnails=False)
    first = store.candidates_missing_thumbnails(10)[0].rel_path
    d, share = hiccup_daemon(world, {first})
    assert d.thumbnail_pending() == 0  # it stopped at the first file
    assert d._thumbs_tried == set()
    share.failing.clear()  # the share is back
    assert d.thumbnail_pending() == 2
    assert first in set(thumb_rows(world)) | set(markers(world))


def test_a_vanished_file_is_skipped_and_the_batch_goes_on(folder):
    world = folder
    run_scan(world, thumbnails=False)
    os.unlink(Path(world.root, A))
    d, _, _ = make_daemon(world)
    assert d.thumbnail_pending() == 1
    assert len(d._thumbs_tried) == 1  # a.png: gone, tried once per process


def test_a_file_that_changed_since_the_row_is_tried_once_per_process_not_every_tick(
    folder,
):
    world = folder
    run_scan(world, thumbnails=False)
    p = Path(world.root, A)
    p.write_bytes(picture((9, 9, 9), (200, 100)))
    os.utime(p, (OLD, OLD))
    d, share, _ = make_daemon(world)
    d.thumbnail_pending()
    d.thumbnail_pending()
    assert len(d._thumbs_tried) == 1
    assert share.opened(A) == 0


# ---- transparency is composited on white -----------------------------------------------------------


def jpeg_pixel(data, xy):
    return Image.open(io.BytesIO(data)).convert("RGB").getpixel(xy)


def png(img, **kw):
    out = io.BytesIO()
    img.save(out, "PNG", **kw)
    return out.getvalue()


def test_a_transparent_rgba_picture_is_flattened_on_white_not_black():
    img = Image.new(
        "RGBA", (64, 64), (0, 0, 0, 0)
    )  # fully transparent, black underneath
    img.paste((200, 0, 0, 255), (0, 0, 32, 64))  # an opaque red left half
    got = thumbs.make_thumbnails(png(img))
    assert got is not None
    assert min(jpeg_pixel(got.preview, (56, 32))) > 235  # white, not black
    r, g, b = jpeg_pixel(got.preview, (8, 32))
    assert r > 170 and g < 60 and b < 60  # the opaque part keeps its colour


def test_a_grey_picture_with_alpha_is_flattened_on_white():
    img = Image.new("LA", (64, 64), (0, 0))
    img.paste((40, 255), (0, 0, 32, 64))
    got = thumbs.make_thumbnails(png(img))
    assert got is not None
    assert jpeg_pixel(got.thumb, (56, 32))[0] > 235
    assert jpeg_pixel(got.thumb, (8, 32))[0] < 90


def test_a_palette_png_with_a_transparent_colour_is_flattened_on_white():
    img = Image.new("P", (64, 64), 0)
    img.putpalette([0, 0, 0, 255, 0, 0] + [0] * 762)
    img.paste(1, (0, 0, 32, 64))
    got = thumbs.make_thumbnails(png(img, transparency=0))
    assert got is not None
    assert min(jpeg_pixel(got.preview, (56, 32))) > 235
    assert jpeg_pixel(got.preview, (8, 32))[0] > 170


def test_a_partly_transparent_pixel_is_blended_with_white():
    img = Image.new(
        "RGBA", (64, 64), (0, 0, 0, 128)
    )  # half transparent black over white: mid grey
    got = thumbs.make_thumbnails(png(img))
    r, g, b = jpeg_pixel(got.preview, (32, 32))
    assert 100 < r < 160 and abs(r - g) < 6 and abs(g - b) < 6
