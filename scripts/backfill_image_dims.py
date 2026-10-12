"""Fill directus_files.width/height for uploaded images whose size Directus never recorded.

Why: Directus only resizes an image (``/assets/<id>?width=...``, used by the Explorer's card
thumbnails) when it knows the original's width and height. Files the force crawler uploads (the
``frm_f*`` figures) were stored without them (126 of 182 Fz figures on 2026-10-12).

Reads only the first bytes of each file (PNG IHDR, JPEG SOF, WebP VP8/VP8L/VP8X header) from the
Directus uploads volume through ``docker exec <container> head -c``, and writes width/height. Dry
run by default; ``--apply`` writes. Only ``storage = 'local'`` rows with NULL width or height and an
image/png, image/jpeg or image/webp type are touched.

    DATABASE_URL=postgres://... python scripts/backfill_image_dims.py [--apply] [--limit N]
        [--container d1-database-directus-1] [--uploads /directus/uploads]
"""

from __future__ import annotations

import argparse
import os
import struct
import subprocess
import sys

HEAD_BYTES = 256 * 1024  # a JPEG's SOF can follow large EXIF blocks


def png_size(b: bytes) -> tuple[int, int] | None:
    if len(b) >= 24 and b[:8] == b"\x89PNG\r\n\x1a\n" and b[12:16] == b"IHDR":
        return struct.unpack(">II", b[16:24])
    return None


def jpeg_size(b: bytes) -> tuple[int, int] | None:
    if b[:2] != b"\xff\xd8":
        return None
    i = 2
    while i + 9 < len(b):
        if b[i] != 0xFF:
            i += 1
            continue
        marker = b[i + 1]
        if (
            marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7
        ):  # SOI, TEM, RSTn carry no length
            i += 2
            continue
        seg_len = struct.unpack(">H", b[i + 2 : i + 4])[0]
        # SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack(">HH", b[i + 5 : i + 9])
            return (w, h)
        i += 2 + seg_len
    return None


def webp_size(b: bytes) -> tuple[int, int] | None:
    if len(b) < 30 or b[:4] != b"RIFF" or b[8:12] != b"WEBP":
        return None
    chunk = b[12:16]
    if chunk == b"VP8 " and b[23:26] == b"\x9d\x01\x2a":
        w, h = struct.unpack("<HH", b[26:30])
        return (w & 0x3FFF, h & 0x3FFF)
    if chunk == b"VP8L" and b[20] == 0x2F:
        bits = int.from_bytes(b[21:25], "little")
        return ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
    if chunk == b"VP8X":
        w = int.from_bytes(b[24:27], "little") + 1
        h = int.from_bytes(b[27:30], "little") + 1
        return (w, h)
    return None


def image_size(b: bytes) -> tuple[int, int] | None:
    return png_size(b) or jpeg_size(b) or webp_size(b)


def read_head(container: str, path: str) -> bytes:
    out = subprocess.run(
        ["docker", "exec", container, "head", "-c", str(HEAD_BYTES), path],
        capture_output=True,
        check=False,
    )
    return out.stdout if out.returncode == 0 else b""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--apply", action="store_true", help="write width/height (default: dry run)"
    )
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--container", default="d1-database-directus-1")
    ap.add_argument("--uploads", default="/directus/uploads")
    args = ap.parse_args(argv)

    import psycopg2  # imported here so the parsers can be tested without it

    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2
    conn = psycopg2.connect(url)
    cur = conn.cursor()
    cur.execute(
        "SELECT id, filename_disk FROM directus_files"
        " WHERE storage = 'local' AND (width IS NULL OR height IS NULL)"
        " AND type IN ('image/png', 'image/jpeg', 'image/webp') AND filename_disk IS NOT NULL"
        " ORDER BY uploaded_on" + (f" LIMIT {int(args.limit)}" if args.limit else "")
    )
    rows = cur.fetchall()
    found = failed = 0
    for file_id, disk in rows:
        size = image_size(read_head(args.container, f"{args.uploads}/{disk}"))
        if size is None:
            failed += 1
            print(f"  ? {file_id} {disk}: size not readable")
            continue
        found += 1
        if args.apply:
            cur.execute(
                "UPDATE directus_files SET width = %s, height = %s WHERE id = %s"
                " AND (width IS NULL OR height IS NULL)",
                (size[0], size[1], file_id),
            )
    if args.apply:
        conn.commit()
    verb = "set" if args.apply else "would set"
    print(f"{len(rows)} image(s) without a size; {verb} {found}; unreadable {failed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
