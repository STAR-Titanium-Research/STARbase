# ruff: noqa: F811
"""Inbox thumbnails (spec section 14): the pure picture maker, the registration hook, the backfill, cleanup.

The first half needs no database and uses small, really generated images (16-bit TIFF, JPEG, PNG, palette,
CMYK, truncated, too many pixels, multi-page TIFF, rotated by EXIF). The second half is Postgres-backed
(the `world` fixture, which also carries `file_thumbnails`).
"""

from __future__ import annotations

import io
import logging
import os
import struct
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

PIL = pytest.importorskip("PIL")
from inbox_crawler import (  # noqa: E402
    __main__ as cli,
)
from inbox_crawler import (  # noqa: E402
    classify_sem,
    daemon,
    db,
    fs_readonly,
    hashing,
    kinds,
    recognise,
    scan,
    thumbs,
)
from inbox_crawler.owners import Owner  # noqa: E402
from PIL import Image  # noqa: E402
from test_inbox_crawler_world import world  # noqa: E402, F401


def encode(img, fmt, **kw) -> bytes:
    buf = io.BytesIO()
    img.save(buf, fmt, **kw)
    return buf.getvalue()


def gradient(w, h, mode="RGB") -> Image.Image:
    """A picture with something in it (a horizontal ramp), so a JPEG is not a flat colour."""
    ramp = (
        Image.linear_gradient("L").resize((w, h)).rotate(90, expand=True).resize((w, h))
    )
    return ramp.convert(mode) if mode != "L" else ramp


def tiff16(w, h, lo, hi) -> bytes:
    """A 16-bit grey TIFF whose values run left to right from lo to hi."""
    row = b"".join(
        struct.pack("<H", lo + (hi - lo) * x // max(w - 1, 1)) for x in range(w)
    )
    img = Image.frombytes("I;16", (w, h), row * h)
    return encode(img, "TIFF")


def decode(jpeg: bytes) -> Image.Image:
    assert jpeg[:2] == b"\xff\xd8", "not a JPEG"
    img = Image.open(io.BytesIO(jpeg))
    img.load()
    return img


# ---- sizes, formats, normalisation ----------------------------------------------------


def test_a_big_jpeg_gets_a_thumbnail_and_a_preview_of_the_right_sizes():
    t = thumbs.make_thumbnails(encode(gradient(3000, 2000), "JPEG"))
    assert t is not None
    assert (t.preview_width, t.preview_height) == (1600, 1067)
    assert (t.thumb_width, t.thumb_height) == (320, 213)
    assert decode(t.preview).size == (1600, 1067)
    assert decode(t.thumb).size == (320, 213)
    assert 0 < len(t.thumb) < len(t.preview)


def test_a_small_picture_is_never_enlarged():
    t = thumbs.make_thumbnails(encode(gradient(100, 50), "PNG"))
    assert t is not None
    assert (t.thumb_width, t.thumb_height) == (100, 50)
    assert (t.preview_width, t.preview_height) == (100, 50)


def test_a_picture_between_the_two_sizes_is_only_reduced_for_the_thumbnail():
    t = thumbs.make_thumbnails(encode(gradient(900, 600), "PNG"))
    assert t is not None
    assert (t.preview_width, t.preview_height) == (900, 600)
    assert (t.thumb_width, t.thumb_height) == (320, 213)


def test_a_16_bit_tiff_is_stretched_to_8_bits():
    t = thumbs.make_thumbnails(tiff16(600, 400, 2000, 6000))
    assert t is not None
    img = decode(t.preview)
    assert img.mode == "L"
    lo, hi = img.getextrema()
    assert lo <= 12 and hi >= 243  # a low-key 16-bit picture is not left black
    assert (t.preview_width, t.preview_height) == (600, 400)


def test_a_flat_16_bit_tiff_still_gets_a_picture():
    t = thumbs.make_thumbnails(tiff16(64, 48, 500, 500))
    assert t is not None
    assert decode(t.thumb).size == (64, 48)


def test_a_32_bit_integer_and_a_float_tiff_get_a_picture():
    for mode in ("I", "F"):
        img = Image.new(mode, (80, 60))
        img.putdata([x % 80 * 3 for x in range(80 * 60)])
        t = thumbs.make_thumbnails(encode(img, "TIFF"))
        assert t is not None, mode
        assert decode(t.preview).mode == "L"


def test_a_png_with_alpha_a_palette_a_bilevel_and_a_cmyk_jpeg_become_viewable():
    rgba = gradient(120, 80).convert("RGBA")
    rgba.putalpha(128)
    palette = gradient(120, 80).quantize(16)
    bilevel = gradient(120, 80, "L").convert("1")
    cmyk = gradient(120, 80).convert("CMYK")
    cases = {
        "rgba": encode(rgba, "PNG"),
        "palette": encode(palette, "PNG"),
        "bilevel": encode(bilevel, "PNG"),
        "cmyk": encode(cmyk, "JPEG"),
        "grey": encode(gradient(120, 80, "L"), "PNG"),
        "bmp": encode(gradient(120, 80), "BMP"),
    }
    for name, data in cases.items():
        t = thumbs.make_thumbnails(data)
        assert t is not None, name
        assert decode(t.preview).mode in ("RGB", "L"), name
        assert (t.preview_width, t.preview_height) == (120, 80), name


def test_a_palette_picture_keeps_its_colours_rather_than_going_blocky():
    img = gradient(600, 400).quantize(32)
    t = thumbs.make_thumbnails(encode(img, "PNG"))
    assert t is not None
    out = decode(t.thumb)
    assert out.mode == "RGB" and out.size == (320, 213)


def test_only_the_first_frame_of_a_multi_page_tiff_is_used():
    first = Image.new("RGB", (400, 300), (200, 20, 20))
    second = Image.new("RGB", (200, 100), (20, 20, 200))
    data = encode(first, "TIFF", save_all=True, append_images=[second])
    assert Image.open(io.BytesIO(data)).n_frames == 2
    t = thumbs.make_thumbnails(data)
    assert t is not None
    assert (t.preview_width, t.preview_height) == (400, 300)
    r, _g, b = decode(t.thumb).resize((1, 1)).getpixel((0, 0))
    assert r > 150 and b < 80


@pytest.mark.parametrize(
    "orientation,size",
    [
        (1, (600, 400)),
        (3, (600, 400)),
        (6, (400, 600)),
        (8, (400, 600)),
        (5, (400, 600)),
    ],
)
def test_the_exif_orientation_is_applied(orientation, size):
    exif = Image.Exif()
    exif[0x0112] = orientation
    data = encode(gradient(600, 400), "JPEG", exif=exif.tobytes())
    t = thumbs.make_thumbnails(data)
    assert t is not None
    assert (t.preview_width, t.preview_height) == size
    assert decode(t.preview).size == size


def test_a_rotated_picture_really_is_rotated_not_just_resized():
    left_red = Image.new("RGB", (60, 40), (0, 0, 0))
    left_red.paste((250, 0, 0), (0, 0, 30, 40))
    exif = Image.Exif()
    exif[0x0112] = (
        6  # rotate 90 degrees clockwise to display: the left half ends up on top
    )
    t = thumbs.make_thumbnails(encode(left_red, "PNG", exif=exif.tobytes()))
    assert t is not None
    out = decode(t.preview)
    assert out.size == (40, 60)
    assert out.getpixel((20, 5))[0] > 150 and out.getpixel((20, 55))[0] < 60


def test_a_big_jpeg_is_decoded_at_a_reduced_scale_but_not_below_the_preview():
    w, h = 4200, 3000  # over DRAFT_ABOVE_PIXELS
    assert w * h > classify_sem.DRAFT_ABOVE_PIXELS
    t = thumbs.make_thumbnails(encode(gradient(w, h), "JPEG"))
    assert t is not None
    assert (t.preview_width, t.preview_height) == (1600, 1143)


def test_the_pictures_are_small_enough_for_a_database_row():
    t = thumbs.make_thumbnails(encode(gradient(2400, 1800), "JPEG", quality=92))
    assert t is not None
    assert len(t.thumb) < 25_000
    assert len(t.preview) < 400_000


# ---- what has no picture --------------------------------------------------------------


def test_a_truncated_file_has_no_picture_and_does_not_raise():
    png = encode(gradient(800, 600), "PNG")
    jpg = encode(gradient(800, 600), "JPEG")
    tif = tiff16(300, 200, 0, 60000)
    for data in (
        png[: len(png) // 2],
        jpg[: len(jpg) // 2],
        tif[: len(tif) // 2],
        png[:20],
    ):
        assert thumbs.make_thumbnails(data) is None


def test_too_many_pixels_is_refused_before_decoding():
    big = Image.new("1", (9000, 9000))  # 81 MP: over MAX_PIXELS, but a tiny PNG
    data = encode(big, "PNG")
    assert 9000 * 9000 > classify_sem.MAX_PIXELS
    assert len(data) < 1_000_000
    assert thumbs.make_thumbnails(data) is None


def test_garbage_empty_and_other_formats_have_no_picture():
    gif = encode(Image.new("P", (10, 10)), "GIF")
    assert thumbs.make_thumbnails(b"") is None
    assert thumbs.make_thumbnails(b"not an image at all" * 50) is None
    assert thumbs.make_thumbnails(b"%PDF-1.4 ...") is None
    assert thumbs.make_thumbnails(gif) is None  # not one of TIFF, JPEG, PNG, BMP


def test_only_bytes_are_accepted_never_a_path_or_a_handle(tmp_path):
    p = tmp_path / "a.png"
    p.write_bytes(encode(gradient(40, 30), "PNG"))
    assert thumbs.make_thumbnails(str(p)) is None
    assert thumbs.make_thumbnails(p) is None
    assert thumbs.make_thumbnails(io.BytesIO(p.read_bytes())) is None
    with p.open("rb") as fh:
        assert thumbs.make_thumbnails(fh) is None
    assert thumbs.make_thumbnails(None) is None
    assert thumbs.make_thumbnails(p.read_bytes()) is not None


def test_the_decode_limits_are_the_classifiers():
    assert thumbs.FORMATS is classify_sem.FORMATS
    assert thumbs.MAX_PIXELS == classify_sem.MAX_PIXELS
    assert thumbs.DRAFT_ABOVE_PIXELS == classify_sem.DRAFT_ABOVE_PIXELS


# =============================================================================================
# Postgres-backed: registration hook, stored rows, backfill, cleanup, the switch
# =============================================================================================

OLD = 1_600_000_000


class Share:
    """The real read-only Share, recording every open (path and `adopted`) and every stat."""

    def __init__(self, root):
        self.inner = fs_readonly.Share(root)
        self.opens: list[tuple[str, bool]] = []
        self.stats: list[str] = []

    def scandir(self, rel=""):
        return self.inner.scandir(rel)

    def stat(self, rel=""):
        self.stats.append(rel)
        return self.inner.stat(rel)

    def open_rb(self, rel, adopted=False):
        self.opens.append((rel, adopted))
        return self.inner.open_rb(rel, adopted=adopted)

    def opened(self, rel) -> int:
        return sum(1 for r, _a in self.opens if r == rel)


def settle(world):
    for dirpath, _dirs, _files in os.walk(world.root):
        os.utime(dirpath, (OLD, OLD))


def picture(color=(40, 90, 160), size=(80, 60)) -> bytes:
    img = gradient(*size)
    img.paste(color, (0, 0, size[0] // 2, size[1] // 2))
    return encode(img, "PNG")


def scanner(world, **kw):
    share = Share(world.root)
    store = db.Store(world.conn)
    kw.setdefault("throttle", None)
    return scan.Scanner(share, store, **kw), share, store


def run_scan(world, **kw):
    sc, share, store = scanner(world, **kw)
    stats = sc.scan()
    return stats, share, store


def thumb_rows(world):
    return {
        r[0]: r[1:]
        for r in world.q(
            "SELECT c.rel_path, t.thumb, t.preview, t.thumb_width, t.thumb_height, t.preview_width, "
            " t.preview_height, t.source_size, t.source_mtime, c.size_bytes, c.source_mtime "
            "FROM file_thumbnails t JOIN file_candidates c USING (candidate_id) "
            "WHERE t.thumb IS NOT NULL ORDER BY c.rel_path"
        )
    }


def markers(world):
    """{rel_path: failed_reason} of the rows that say "no picture can be made of this file"."""
    return dict(
        world.q(
            "SELECT c.rel_path, t.failed_reason FROM file_thumbnails t "
            "JOIN file_candidates c USING (candidate_id) WHERE t.thumb IS NULL ORDER BY c.rel_path"
        )
    )


def states(world):
    return {r[0]: r[1] for r in world.q("SELECT rel_path, state FROM file_candidates")}


def make_daemon(world, *, throttle=None, now=None, **cfg):
    share = Share(world.root)
    store = db.Store(world.conn)
    d = daemon.Daemon(
        store,
        share,
        None,
        config=daemon.Config(tick_s=0.01, error_sleep_s=0.01, **cfg),
        **({"now": now} if now else {}),
    )
    if throttle is not None:
        d.throttle = throttle
    return d, share, store


A = "Users/abc12de/sem/a.png"
B = "Users/abc12de/sem/b.png"
BROKEN = "Users/abc12de/broken.png"


@pytest.fixture
def folder(world):
    world.person("abc12de", user=True)
    world.write(A, picture())
    world.write(B, picture((200, 30, 30), (120, 90)))
    world.write("Users/abc12de/notes.pdf", b"%PDF-1.4 notes")
    world.write("Users/abc12de/scan1.al3d", b"AL3D" * 100)
    world.write(BROKEN, b"\x89PNG not really")
    settle(world)
    return world


# ---- at registration ----------------------------------------------------------------------


def test_a_new_image_gets_its_thumbnails_when_it_is_registered(folder):
    world = folder
    stats, _, _ = run_scan(world)
    assert stats.errors == 0 and stats.registered == 5
    rows = thumb_rows(world)
    assert set(rows) == {A, B}
    thumb, preview, tw, th, pw, ph, ssize, smtime, csize, cmtime = rows[A]
    assert bytes(thumb)[:2] == b"\xff\xd8" and bytes(preview)[:2] == b"\xff\xd8"
    assert (tw, th, pw, ph) == (80, 60, 80, 60)
    assert decode(bytes(thumb)).size == (tw, th)
    assert (ssize, smtime) == (
        csize,
        cmtime,
    )  # made from the file the candidate describes
    assert csize == os.path.getsize(Path(world.root, A))


def test_registering_costs_no_second_read_of_the_share(folder):
    world = folder
    _, share, _ = run_scan(world)
    assert share.opened(A) == 1
    assert share.opened("Users/abc12de/notes.pdf") == 0
    assert all(adopted is False for _r, adopted in share.opens)


def test_documents_and_surface_scans_get_no_row_and_an_undecodable_image_a_marker(
    folder,
):
    world = folder
    run_scan(world)
    none = {
        r[0]
        for r in world.q(
            "SELECT c.rel_path FROM file_candidates c LEFT JOIN file_thumbnails t USING (candidate_id) "
            "WHERE t.candidate_id IS NULL"
        )
    }
    assert none == {"Users/abc12de/notes.pdf", "Users/abc12de/scan1.al3d"}
    assert markers(world) == {
        BROKEN: "not decoded"
    }  # tried, and not tried again until it changes
    # an undecodable image is still a found file
    assert (
        world.one("SELECT kind FROM file_candidates WHERE rel_path = %s", (BROKEN,))[0]
        == "image"
    )


def test_a_sem_image_gets_thumbnails_too(folder):
    world = folder

    class Claims:
        name = "stub"

        def inspect(self, img, ocr, ocr_func, bar_reader=None):
            return classify_sem.ProfileResult(0.9, {}, "stub")

    run_scan(world, profiles=(Claims(),))
    kinds_with = {
        r[0]
        for r in world.q(
            "SELECT c.kind FROM file_thumbnails t JOIN file_candidates c USING (candidate_id) "
            "WHERE t.thumb IS NOT NULL"
        )
    }
    assert kinds_with == {"sem_image"}


def test_thumbnails_off_registers_files_without_them(folder):
    world = folder
    stats, _, _ = run_scan(world, thumbnails=False)
    assert stats.registered == 5
    assert thumb_rows(world) == {}


def test_the_thumbnails_are_in_the_transaction_of_the_candidate(world):
    pid, _ = world.person("abc12de")
    world.commit()
    store = db.Store(world.conn)
    owner = Owner("person", pid, "Users/abc12de", "abc12de", claim="abc12de")
    mtime = db.to_datetime(1_600_000_000_000_000_000)
    made = thumbs.make_thumbnails(picture())

    def register(rel):
        return store.register_file(
            owner=owner,
            rel=rel,
            size=123,
            mtime=mtime,
            classification=kinds.Classification("image"),
            recognition=recognise.NO_MATCH,
            origin="new",
            hashed=None,
            thumbs=made,
        )

    register("Users/abc12de/x.png")
    world.conn.rollback()  # the scan lost its connection before it committed
    assert world.one("SELECT count(*) FROM file_candidates")[0] == 0
    assert world.one("SELECT count(*) FROM file_thumbnails")[0] == 0
    register("Users/abc12de/x.png")
    world.conn.commit()
    assert world.one("SELECT count(*) FROM file_candidates")[0] == 1
    assert world.one("SELECT count(*) FROM file_thumbnails")[0] == 1


def test_a_database_without_the_table_still_registers_the_file(folder, caplog):
    world = folder
    world.q("DROP TABLE file_thumbnails")
    world.commit()
    with caplog.at_level(logging.WARNING):
        stats, _, _ = run_scan(world)
    assert stats.errors == 0 and stats.registered == 5
    assert len(states(world)) == 5
    assert "migration 198" in caplog.text


# ---- the stored rows ---------------------------------------------------------------------


def test_storing_again_replaces_the_pair(folder):
    world = folder
    _, _, store = run_scan(world)
    cid, size, mtime = world.one(
        "SELECT candidate_id::text, size_bytes, source_mtime FROM file_candidates WHERE rel_path = %s",
        (A,),
    )
    other = thumbs.make_thumbnails(picture((250, 250, 0), (300, 200)))
    store.store_thumbnails(cid, other, size, mtime)
    store.commit()
    q = "SELECT count(*) FROM file_thumbnails WHERE candidate_id = %s"
    assert world.one(q, (cid,))[0] == 1
    assert world.one(
        "SELECT thumb_width, preview_width FROM file_thumbnails WHERE candidate_id = %s",
        (cid,),
    ) == (other.thumb_width, other.preview_width)


def test_a_deleted_candidate_takes_its_thumbnails_with_it(folder):
    world = folder
    run_scan(world)
    world.q("DELETE FROM file_candidates WHERE rel_path = %s", (A,))
    world.commit()
    assert set(thumb_rows(world)) == {B}


def test_marking_a_file_gone_deletes_its_thumbnails_and_a_return_makes_them_again(
    folder,
):
    world = folder
    run_scan(world)
    settle(world)
    os.unlink(Path(world.root, A))
    stats, _, _ = run_scan(world)
    assert stats.gone == 1
    assert states(world)[A] == "gone"
    assert set(thumb_rows(world)) == {B}
    world.write(A, picture())
    settle(world)
    run_scan(world)  # revived: 'new' again, and no thumbnails yet
    assert states(world)[A] == "new"
    assert set(thumb_rows(world)) == {B}
    d, _, _ = make_daemon(world)
    assert d.thumbnail_pending() == 1
    assert set(thumb_rows(world)) == {A, B}


def test_a_decided_file_that_vanishes_is_not_gone_and_keeps_its_thumbnails(folder):
    world = folder
    run_scan(world)
    world.q("UPDATE file_candidates SET state = 'dismissed' WHERE rel_path = %s", (A,))
    world.commit()
    settle(world)
    os.unlink(Path(world.root, A))
    run_scan(world)
    assert states(world)[A] == "dismissed"
    assert A in thumb_rows(world)


# ---- who is offered to the backfill -------------------------------------------------------


def offered(store, limit=100, **kw):
    got = store.candidates_missing_thumbnails(limit, **kw)
    return [t.rel_path.rsplit("/", 1)[1] for t in got]


def test_the_backfill_is_offered_images_without_a_row_that_a_person_can_still_see(
    folder,
):
    world = folder
    _, _, store = run_scan(world, thumbnails=False)
    world.q("UPDATE file_candidates SET state = 'dismissed' WHERE rel_path = %s", (B,))
    world.q("UPDATE file_candidates SET state = 'gone' WHERE rel_path = %s", (BROKEN,))
    world.commit()
    # undecided first; documents, scans and gone files never
    assert offered(store) == ["a.png", "b.png"]
    assert offered(store, limit=1) == ["a.png"]
    world.q(
        "UPDATE file_candidates SET state = 'linked', link_kind = 'manual', "
        "linked_collection = 'physical_samples', linked_junction_id = gen_random_uuid(), "
        "link_batch_id = gen_random_uuid() WHERE rel_path = %s",
        (B,),
    )
    world.commit()
    assert offered(store) == ["a.png", "b.png"]  # a linked image has its picture too


def test_a_row_made_from_another_size_or_time_is_offered_again(folder):
    world = folder
    _, _, store = run_scan(world)
    assert (
        offered(store) == []
    )  # broken.png has a marker for its current size and time: done
    ids = "(SELECT candidate_id FROM file_candidates WHERE rel_path = %s)"
    world.q(
        f"UPDATE file_thumbnails SET source_size = source_size + 1 WHERE candidate_id IN {ids}",
        (A,),
    )
    world.q(
        "UPDATE file_thumbnails SET source_mtime = source_mtime + interval '1 second' "
        f"WHERE candidate_id IN {ids}",
        (B,),
    )
    world.q(
        "UPDATE file_thumbnails SET source_size = source_size + 1 WHERE failed_reason IS NOT NULL"
    )
    world.commit()
    assert sorted(offered(store)) == [
        "a.png",
        "b.png",
        "broken.png",
    ]  # a changed file is tried again


def test_skip_max_bytes_and_a_failed_discovery_hash_keep_a_file_off_the_list(folder):
    world = folder
    _, _, store = run_scan(world, thumbnails=False)
    a_id = world.one(
        "SELECT candidate_id::text FROM file_candidates WHERE rel_path = %s", (A,)
    )[0]
    assert "a.png" in offered(store)
    assert "a.png" not in offered(store, skip={a_id})
    size_b = os.path.getsize(Path(world.root, B))
    assert "b.png" not in offered(store, max_bytes=size_b - 1)
    assert "b.png" in offered(store, max_bytes=size_b)
    world.q(
        "UPDATE file_fingerprints SET status = 'error', content_sha256 = NULL WHERE directus_files_id IN "
        "(SELECT directus_files_id FROM file_candidates WHERE rel_path = %s)",
        (B,),
    )
    world.commit()
    assert "b.png" not in offered(store)  # the hash retry (an hour later) comes first


# ---- the backfill step --------------------------------------------------------------------


def test_the_backfill_reads_only_allow_listed_images_not_adopted_through_the_throttle(
    folder,
):
    world = folder
    run_scan(world, thumbnails=False)
    seen = []

    class Spy(hashing.Throttle):
        def consume(self, n):
            seen.append(n)

    d, share, _ = make_daemon(world, throttle=Spy(1e9))
    assert d.thumbnail_pending() == 2
    assert {r for r, _a in share.opens} == {A, B, BROKEN}  # no document, no .al3d
    assert all(adopted is False for _r, adopted in share.opens)
    assert sum(seen) == sum(
        os.path.getsize(Path(world.root, r)) for r, _a in share.opens
    )
    assert set(thumb_rows(world)) == {A, B}


def test_the_backfill_is_bounded_per_call_and_finishes(folder):
    world = folder
    run_scan(world, thumbnails=False)
    d, share, _ = make_daemon(world)
    assert d.thumbnail_pending(limit=1) == 1
    assert len(thumb_rows(world)) == 1
    assert d.thumbnail_pending(limit=1) == 1
    assert len(thumb_rows(world)) == 2
    assert d.thumbnail_pending(limit=1) == 0  # broken.png: tried once, then left alone
    opened = len(share.opens)
    assert d.thumbnail_pending(limit=10) == 0
    assert len(share.opens) == opened


def test_one_call_hands_back_after_its_time_budget(folder):
    world = folder
    run_scan(world, thumbnails=False)
    clock = [datetime(2026, 10, 16, 12, 0, tzinfo=UTC)]

    def now():
        clock[0] += timedelta(seconds=daemon.THUMB_BUDGET_S * 0.75)
        return clock[0]

    d, _, _ = make_daemon(world, now=now)
    assert d.thumbnail_pending() == 1  # the second image would start past the budget
    assert len(thumb_rows(world)) == 1
    assert d.thumbnail_pending() == 1  # the next tick goes on with the rest
    assert len(thumb_rows(world)) == 2


def test_a_file_that_cannot_be_decoded_is_read_once_per_process_not_every_tick(folder):
    world = folder
    run_scan(world, thumbnails=False)
    d, share, _ = make_daemon(world)
    for _ in range(4):
        d.thumbnail_pending()
    assert share.opened(BROKEN) == 1


def test_the_backfill_skips_a_file_that_vanished_and_marks_nothing_gone(folder):
    world = folder
    run_scan(world, thumbnails=False)
    os.unlink(Path(world.root, A))
    d, share, _ = make_daemon(world)
    assert d.thumbnail_pending() == 1  # b.png only
    assert set(thumb_rows(world)) == {B}
    assert states(world)[A] == "new"  # the scan decides that, not this step
    assert share.opened(A) == 0


def test_the_backfill_makes_no_picture_of_a_file_that_changed_since_it_was_registered(
    folder,
):
    world = folder
    run_scan(world, thumbnails=False)
    p = Path(world.root, A)
    p.write_bytes(picture((9, 9, 9), (200, 100)))
    os.utime(p, (OLD, OLD))
    d, share, _ = make_daemon(world)
    d.thumbnail_pending()
    assert A not in thumb_rows(world)
    assert share.opened(A) == 0  # stat said it is not the file the row describes


def test_a_file_that_changes_while_it_is_read_gets_no_picture(folder, monkeypatch):
    world = folder
    run_scan(world, thumbnails=False)
    real = scan.still_the_same

    def changed(share, rel, st, hashed):
        if rel == A:
            return hashing.HashOutcome(
                "error", error="the file changed while it was read"
            )
        return real(share, rel, st, hashed)

    monkeypatch.setattr(scan, "still_the_same", changed)
    d, _, _ = make_daemon(world)
    d.thumbnail_pending()
    assert set(thumb_rows(world)) == {B}


def test_the_backfill_makes_a_stale_row_again(folder):
    world = folder
    run_scan(world)
    world.q("UPDATE file_thumbnails SET source_size = 1")
    world.commit()
    d, _, _ = make_daemon(world)
    assert d.thumbnail_pending() == 2
    for r in thumb_rows(world).values():
        assert r[6] == r[8]  # source_size is the candidate's size again


def test_the_switch_off_means_no_thumbnails_at_registration_and_no_backfill(folder):
    world = folder
    d, share, _ = make_daemon(world, thumbnails=False)
    assert d.tick() == "scheduled"  # scans and registers
    assert len(states(world)) == 5
    assert d.thumbnail_pending() == 0
    d.tick()
    assert thumb_rows(world) == {}
    assert share.opened(A) == 1  # the scan's read, nothing more


def test_an_idle_tick_runs_the_backfill(folder):
    world = folder
    run_scan(world, thumbnails=False)
    d, _, _ = make_daemon(world)
    d.tick()
    assert set(thumb_rows(world)) == {A, B}


def test_a_missing_table_switches_the_backfill_off_for_ten_minutes_without_failing_the_tick(
    folder, caplog
):
    world = folder
    run_scan(world, thumbnails=False)
    world.q("DROP TABLE file_thumbnails")
    world.commit()
    clock = [datetime(2026, 10, 16, 12, 0, tzinfo=UTC)]
    d, share, _ = make_daemon(world, now=lambda: clock[0])
    with caplog.at_level(logging.WARNING):
        assert d.thumbnail_pending() == 0
    assert "migration 198" in caplog.text
    d.tick()  # the heartbeat and everything else go on
    clock[0] += timedelta(minutes=5)
    stats_before = len(share.stats)
    assert d.thumbnail_pending() == 0
    assert len(share.stats) == stats_before  # still off: it did not even ask
    clock[0] += timedelta(minutes=6)
    world.q(
        "CREATE TABLE file_thumbnails (candidate_id uuid PRIMARY KEY REFERENCES file_candidates "
        "ON DELETE CASCADE, thumb bytea, preview bytea, thumb_width int, "
        "thumb_height int, preview_width int, preview_height int, failed_reason text, "
        "source_size bigint NOT NULL, "
        "source_mtime timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now())"
    )
    world.commit()
    assert (
        d.thumbnail_pending() == 2
    )  # the migration came: it picks up where it left off


# ---- the switch in the entry point ------------------------------------------------------------


@pytest.mark.parametrize("value,expected", [(None, 1), ("1", 1), ("0", 0)])
def test_inbox_thumbnails_0_switches_the_entry_point_off(
    world, monkeypatch, value, expected
):
    world.person("abc12de")
    world.write("Users/abc12de/a.png", picture())
    settle(world)
    world.commit()
    for k in (
        "D1_INBOX_URL",
        "D1_INBOX_CRAWLER_SECRET",
        "INBOX_OCR",
        "INBOX_THUMBNAILS",
    ):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("DATABASE_URL", world.dsn)
    monkeypatch.setenv("INBOX_PRIVATE_SCHEMA", world.schema)
    if value is not None:
        monkeypatch.setenv("INBOX_THUMBNAILS", value)
    assert cli.main(["--once", "--root", world.root]) == 0
    assert world.one("SELECT count(*) FROM file_candidates")[0] == 1
    assert world.one("SELECT count(*) FROM file_thumbnails")[0] == expected


def test_the_backfill_batch_and_budget_come_from_the_config():
    # INBOX_THUMB_BATCH / INBOX_THUMB_BUDGET_S: the defaults stay 25 and 20 s, a Config can raise them
    cfg = daemon.Config()
    assert cfg.thumb_batch == daemon.THUMB_BATCH == 25
    assert cfg.thumb_budget_s == daemon.THUMB_BUDGET_S == 20
    cfg = daemon.Config(thumb_batch=150, thumb_budget_s=90.0)
    assert (cfg.thumb_batch, cfg.thumb_budget_s) == (150, 90.0)
