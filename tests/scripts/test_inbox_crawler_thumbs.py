"""Inbox thumbnails (spec section 14): the pure picture maker, the registration hook, the backfill, cleanup.

The first half needs no database and uses small, really generated images (16-bit TIFF, JPEG, PNG, palette,
CMYK, truncated, too many pixels, multi-page TIFF, rotated by EXIF). The second half is Postgres-backed
(the `world` fixture, which also carries `file_thumbnails`).
"""

from __future__ import annotations

import io
import struct
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

PIL = pytest.importorskip("PIL")
from inbox_crawler import classify_sem, thumbs  # noqa: E402
from PIL import Image  # noqa: E402


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
