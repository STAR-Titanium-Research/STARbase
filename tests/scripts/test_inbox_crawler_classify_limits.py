"""Image decoding limits (review item 6): size is checked before decoding, formats are restricted,
a bomb warning is an error, and a failing image is a plain image, never a crashed scan.

All files here are tiny synthetic bytes; the "huge" ones only claim a large size in their header.
"""

from __future__ import annotations

import io
import struct
import sys
import warnings
import zlib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

pytest.importorskip("PIL")
from inbox_crawler import classify_sem as csem  # noqa: E402
from PIL import Image, ImageFile  # noqa: E402


def png_claiming(width, height):
    """A few dozen bytes of PNG whose header claims width x height pixels (no real pixel data)."""

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(b"\x00"))
        + chunk(b"IEND", b"")
    )


@pytest.fixture
def load_spy(monkeypatch):
    calls = []
    real = ImageFile.ImageFile.load

    def spy(self):
        calls.append(self.size)
        return real(self)

    monkeypatch.setattr(ImageFile.ImageFile, "load", spy)
    return calls


def test_the_limit_is_about_fifty_million_pixels():
    assert 40_000_000 <= csem.MAX_PIXELS <= 60_000_000


@pytest.mark.parametrize("size", [(30000, 30000), (8000, 8000), (100000, 1000)])
def test_a_header_claiming_too_many_pixels_is_refused_before_decoding(size, load_spy):
    c = csem.classify_image(io.BytesIO(png_claiming(*size)))
    assert c.kind == "image" and c.confidence is None and c.extracted == {}
    assert "not decoded" in c.reason or "too large" in c.reason
    assert load_spy == []  # nothing was decoded


def test_the_size_is_judged_against_the_limit_in_force(monkeypatch, load_spy):
    monkeypatch.setattr(csem, "MAX_PIXELS", 1000)
    b = io.BytesIO()
    Image.new("L", (64, 48), 100).save(b, "PNG")  # 3072 pixels
    c = csem.classify_image(io.BytesIO(b.getvalue()))
    assert c.kind == "image" and load_spy == []
    monkeypatch.setattr(csem, "MAX_PIXELS", 10_000)
    csem.classify_image(io.BytesIO(b.getvalue()))
    assert load_spy  # under the limit it is decoded


def test_a_bomb_warning_is_an_error_not_a_log_line(monkeypatch):
    monkeypatch.setattr(csem, "MAX_PIXELS", 1000)
    b = io.BytesIO()
    Image.new("L", (40, 30), 0).save(
        b, "PNG"
    )  # 1200 pixels: between 1x and 2x the limit, a warning in Pillow
    with warnings.catch_warnings():
        warnings.simplefilter(
            "error"
        )  # the test itself would fail on an escaped warning
        c = csem.classify_image(io.BytesIO(b.getvalue()))
    assert c.kind == "image" and "not decoded" in c.reason


def test_the_global_pillow_warning_filters_are_left_as_they_were():
    before = list(warnings.filters)
    csem.classify_image(io.BytesIO(png_claiming(30000, 30000)))
    assert list(warnings.filters) == before


@pytest.mark.parametrize(
    "name,data",
    [
        ("gif", b"GIF89a\x01\x00\x01\x00\x00\x00\x00;"),
        ("eps", b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\nshowpage\n"),
        ("pdf", b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"),
        ("webp", b"RIFF\x1a\x00\x00\x00WEBPVP8 "),
        ("garbage", b"\x00" * 64),
        ("empty", b""),
    ],
)
def test_only_the_expected_formats_are_decoded(name, data):
    c = csem.classify_image(io.BytesIO(data))
    assert c.kind == "image" and c.confidence is None
    assert "not decoded" in c.reason


@pytest.mark.parametrize("fmt", ["TIFF", "PNG", "BMP", "JPEG"])
def test_the_four_expected_formats_still_decode(fmt):
    b = io.BytesIO()
    Image.new("L", (64, 48), 90).save(b, fmt)
    c = csem.classify_image(io.BytesIO(b.getvalue()))
    assert "not decoded" not in c.reason


def test_a_truncated_image_is_a_plain_image():
    b = io.BytesIO()
    Image.effect_noise((200, 200), 30).convert("L").save(b, "PNG")
    c = csem.classify_image(io.BytesIO(b.getvalue()[:-200]))
    assert c.kind == "image" and "not decoded" in c.reason


def test_a_memory_error_while_decoding_never_crashes_the_scan(monkeypatch):
    def boom(self):
        raise MemoryError

    monkeypatch.setattr(ImageFile.ImageFile, "load", boom)
    b = io.BytesIO()
    Image.new("L", (64, 48), 0).save(b, "PNG")
    c = csem.classify_image(io.BytesIO(b.getvalue()))
    assert c.kind == "image" and "MemoryError" in c.reason


def test_a_jpeg_is_drafted_down_before_it_is_decoded(monkeypatch):
    sizes = []
    real = ImageFile.ImageFile.load

    def spy(self):
        sizes.append(self.size)
        return real(self)

    monkeypatch.setattr(ImageFile.ImageFile, "load", spy)
    b = io.BytesIO()
    Image.effect_noise((4096, 3072), 30).convert("L").save(b, "JPEG")
    csem.classify_image(io.BytesIO(b.getvalue()))
    assert sizes and sizes[0][0] < 4096  # decoded at reduced scale, not at full size
