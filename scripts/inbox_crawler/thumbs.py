"""Small derived pictures of an image (spec section 14): a thumbnail for the Inbox row and a reduced preview.

`make_thumbnails(data)` takes the file's bytes, already in memory (what the crawler read through `fs_readonly`
and hashed), never a path or a handle, so Pillow cannot reach the share by itself. It is pure: no database, no
share, no clock, and it never raises. Anything it cannot decode, or will not (a format outside `FORMATS`, more
than `MAX_PIXELS`, a truncated file), is `None`: that file simply has no picture.

The decode limits are classification's (`classify_sem.FORMATS`, `MAX_PIXELS`, `DRAFT_ABOVE_PIXELS`). The picture
is normalised for a browser: 16-bit, 32-bit and float grey is stretched to 8 bits, palette, CMYK and
the rarer modes become RGB, transparency is composited on white, an 8-bit grey picture stays grey, the first frame of a multi-page TIFF is the one
shown, and the EXIF orientation is applied. Both pictures are JPEG, scaled with LANCZOS and never enlarged.

Both are derived, replaceable data in `d1_private.file_thumbnails`. The preview is a reduced copy: the UI says
so, and the original stays on the share.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass
from io import BytesIO

from .classify_sem import DRAFT_ABOVE_PIXELS, FORMATS, MAX_PIXELS

try:  # Pillow is a dependency of the service; the module imports without it and then makes nothing
    from PIL import Image, ImageOps
except ImportError:  # pragma: no cover
    Image = None
    ImageOps = None

THUMB_PX = 320  # the long side of the row's thumbnail
PREVIEW_PX = 1600  # the long side of the preview
THUMB_QUALITY = 78  # about 10 to 25 KB at 320 px
PREVIEW_QUALITY = 80  # about 150 to 400 KB at 1600 px
_ORIENTATION = 0x0112  # the EXIF/TIFF orientation tag
# Modes Pillow resamples correctly. Anything else (palette, bilevel, ...) is converted before it is scaled,
# because Pillow scales those with nearest-neighbour.
_RESIZABLE = frozenset({"L", "RGB", "RGBA", "CMYK", "LA", "I", "F"})


@dataclass(frozen=True)
class Thumbs:
    thumb: bytes
    preview: bytes
    thumb_width: int
    thumb_height: int
    preview_width: int
    preview_height: int


def _encode_jpeg(img, quality: int) -> bytes:
    buf = BytesIO()
    img.save(buf, "JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def _orientation(img) -> int | None:
    try:
        value = img.getexif().get(_ORIENTATION)
    except Exception:  # noqa: BLE001 (broken metadata is not a reason to lose the picture)
        return None
    return value if isinstance(value, int) and 2 <= value <= 8 else None


def _scaled(img):
    """The decoded picture as an 8-bit L or RGB image, no longer than PREVIEW_PX on its long side."""
    mode = img.mode
    if mode.startswith("I;16"):
        img = img.convert("I")  # Pillow cannot scale the 16-bit modes itself
        mode = "I"
    elif mode in ("P", "PA") and "transparency" in img.info:
        img = img.convert(
            "RGBA"
        )  # a transparent palette colour is composited on white below
        mode = "RGBA"
    elif mode not in _RESIZABLE:
        img = img.convert("L" if mode == "1" else "RGB")
        mode = img.mode
    img.thumbnail((PREVIEW_PX, PREVIEW_PX), Image.LANCZOS)
    if mode in ("I", "F"):
        # stretch what the picture uses to 0..255 (a 16-bit SEM image rarely fills its range)
        lo, hi = img.getextrema()
        k = 255.0 / (hi - lo) if hi > lo else 1.0
        return img.point(lambda v: v * k - lo * k).convert("L")
    if mode in ("RGBA", "LA"):
        # JPEG has no alpha: composite on white (a plain convert would show the colour under a transparent
        # pixel, usually black)
        # (instance methods only: the read-only test allows no Image.new)
        alpha = img.getchannel("A")
        flat = alpha.point(lambda _v: 255)  # an all-white picture of the same size
        if mode == "RGBA":
            flat = flat.convert("RGB")
        flat.paste(img.convert("RGB" if mode == "RGBA" else "L"), mask=alpha)
        return flat
    if mode in ("L", "RGB"):
        return img
    return img.convert("RGB")


def make_thumbnails(data: bytes) -> Thumbs | None:
    """JPEG thumbnail and preview of the image in `data`, or None when there is none to make. Never raises."""
    if not isinstance(data, bytes):
        # Pillow is only ever given bytes the crawler already read through fs_readonly, never a path or a
        # handle on the share.
        return None
    if Image is None:  # pragma: no cover
        return None
    try:
        with warnings.catch_warnings():
            # Pillow only warns between 1x and 2x its limit; a warning here is a refusal.
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            warnings.simplefilter(
                "ignore", UserWarning
            )  # Pillow's "Corrupt EXIF data" is not worth a log line
            Image.MAX_IMAGE_PIXELS = MAX_PIXELS
            img = Image.open(BytesIO(data), formats=FORMATS)
            w, h = img.size  # known from the header, before anything is decoded
            if w < 1 or h < 1 or w * h > MAX_PIXELS:
                return None
            orientation = _orientation(img)
            if img.format == "JPEG" and w * h > DRAFT_ABOVE_PIXELS:
                # a big JPEG is decoded at a reduced scale, but never below the preview's size
                scale = PREVIEW_PX / max(w, h)
                if scale < 1:
                    img.draft(None, (max(1, int(w * scale)), max(1, int(h * scale))))
            img.load()
            small = _scaled(img)
            if orientation is not None:
                small.getexif()[_ORIENTATION] = orientation
                small = ImageOps.exif_transpose(small)
            preview = _encode_jpeg(small, PREVIEW_QUALITY)
            preview_size = small.size
            small.thumbnail(
                (THUMB_PX, THUMB_PX), Image.LANCZOS
            )  # the preview is encoded: reuse its pixels
            thumb = _encode_jpeg(small, THUMB_QUALITY)
            return Thumbs(
                thumb,
                preview,
                small.size[0],
                small.size[1],
                preview_size[0],
                preview_size[1],
            )
    except Exception:  # noqa: BLE001 (a corrupt, truncated, huge or exotic file just has no picture)
        return None
