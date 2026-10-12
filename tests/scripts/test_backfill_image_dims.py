import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

import backfill_image_dims as b  # noqa: E402


def png(w, h):
    return (
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I", 13)
        + b"IHDR"
        + struct.pack(">II", w, h)
        + b"\x08\x06\x00\x00\x00"
    )


def jpeg(w, h, exif=0):
    app1 = b"\xff\xe1" + struct.pack(">H", exif + 2) + b"\x00" * exif
    sof = b"\xff\xc0" + struct.pack(">HBHHB", 11, 8, h, w, 1) + b"\x01\x11\x00"
    return b"\xff\xd8" + app1 + sof + b"\xff\xd9"


def webp_vp8x(w, h):
    body = (
        b"VP8X"
        + struct.pack("<I", 10)
        + b"\x00\x00\x00\x00"
        + (w - 1).to_bytes(3, "little")
        + (h - 1).to_bytes(3, "little")
    )
    return b"RIFF" + struct.pack("<I", 4 + len(body)) + b"WEBP" + body


def test_png_size_reads_ihdr():
    assert b.image_size(png(6102, 5903)) == (6102, 5903)


def test_jpeg_size_skips_app_segments():
    assert b.image_size(jpeg(4928, 3264, exif=5000)) == (4928, 3264)


def test_webp_extended_size():
    assert b.image_size(webp_vp8x(2119, 1400)) == (2119, 1400)


def test_unknown_or_empty_bytes_give_none():
    assert b.image_size(b"") is None
    assert b.image_size(b"GIF89a....") is None
    assert b.image_size(b"\xff\xd8\xff") is None  # truncated JPEG
