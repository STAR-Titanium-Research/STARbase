"""Is this image a (possible) SEM image? A pluggable per-instrument profile (spec section 7).

`classify_image(fh)` takes an in-memory `io.BytesIO` (the bytes the crawler already read through
`fs_readonly`), never a path or a handle, so Pillow cannot reach the share by itself. Each `SemProfile` looks at the picture
and either claims it with a confidence or says nothing. Two profiles: FEI/Thermo (TIFF tag 34682, read by
`sem_meta`) and JEOL (embedded metadata naming JEOL). A claim needs positive evidence: a dark strip with
text-like pixels alone never reaches `SEM_MIN_CONFIDENCE`, because thermal cameras, optical microscopes and
report figures have one. A negative signal (an optical-microscope or video-capture TIFF) caps every claim
below the threshold.

The tag is a guess until it has been validated on the maintainer's sample strips (physical-test backlog
IF8): the UI words it "possible SEM image". `extracted` carries only what was read from the file: embedded
metadata, and the data bar's text when OCR is switched on (default off). Never a value the picture merely
suggests.
"""

from __future__ import annotations

import re
import warnings
from collections.abc import Callable
from dataclasses import dataclass
from io import BytesIO
from typing import Protocol

from .kinds import Classification
from .sem_meta import fei_metadata

try:  # Pillow is a dependency of the service; the pure helpers below work without it
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None

SEM_MIN_CONFIDENCE = 0.6  # at or above this a profile's claim becomes kind sem_image
NEGATIVE_CAP = 0.55  # a negative signal (optical microscope, capture device) caps any claim at this
CLASSIFIER_VERSION = (
    "sem-2"  # stored as classified_by; --reclassify re-reads rows at an older version
)
MAX_PIXELS = 50_000_000  # refuse to decode anything bigger (a decompression bomb is just an image)
# Only these formats are decoded: Pillow knows dozens, some of which run external programs (EPS) or are
# not images at all. A file named .tif that is something else is a plain, undecoded image.
FORMATS = ["TIFF", "JPEG", "PNG", "BMP"]
DRAFT_ABOVE_PIXELS = (
    8_000_000  # a larger JPEG is decoded at half scale: the data bar is large
)

_TEXT_TAGS = (270, 271, 272, 305)  # ImageDescription, Make, Model, Software
_MAX_META_CHARS = 20_000


@dataclass(frozen=True)
class ProfileResult:
    confidence: float
    extracted: dict
    reason: str = ""


class SemProfile(Protocol):
    """A per-instrument detector. `inspect` gets the decoded picture (PIL image) and the OCR switch."""

    name: str

    def inspect(
        self, img, ocr: bool, ocr_func: Callable | None
    ) -> ProfileResult | None: ...


# ---- text parsing (metadata, OCR) -------------------------------------------------------

_KV = re.compile(r"(\d+(?:\.\d+)?)\s*kV", re.I)
_MAG = re.compile(
    r"(?:(?<![A-Za-z0-9])[x×]\s?(\d{1,3}(?:,\d{3})+|\d{2,6})(?![\d.]))"
    r"|(?:\bmag\w*\s*[=:]\s*(\d{1,3}(?:,\d{3})+|\d{2,6})\b)",
    re.I,
)
_SCALE = re.compile(r"(?<![\d.])(\d+(?:\.\d+)?)\s*(nm|µm|μm|um|mm)(?![A-Za-z])", re.I)
_UNITS = {
    "nm": "nm",
    "mm": "mm",
    "um": "\u00b5m",
    "\u00b5m": "\u00b5m",
    "\u03bcm": "\u00b5m",
}
_WD = re.compile(r"\bWD\s*[=:]?\s*(\d+(?:\.\d+)?)\s*mm", re.I)


def parse_text(text: str, *, scale_bar: bool = False) -> dict:
    """The values a block of text states: kV, magnification, working distance (and, for a data bar read
    by OCR, the scale-bar label). Only what is there; absent keys stay absent."""
    out: dict = {}
    m = _KV.search(text)
    if m:
        out["kv"] = float(m.group(1))
    m = _MAG.search(text)
    if m:
        out["magnification"] = int(re.sub(",", "", m.group(1) or m.group(2)))
    m = _WD.search(text)
    if m:
        out["working_distance_mm"] = float(m.group(1))
    if scale_bar:
        wd_end = _WD.search(text)
        for s in _SCALE.finditer(text):
            if wd_end and wd_end.start() <= s.start() < wd_end.end():
                continue  # the working distance is not the scale bar
            unit = _UNITS[s.group(2).lower()]
            out["scale_bar"] = f"{s.group(1)} {unit}"
            break
    return out


def _metadata_text(img) -> str:
    parts: list[str] = []
    try:
        tags = img.tag_v2  # TIFF only
    except AttributeError:
        tags = None
    if tags is not None:
        for key in tags:
            val = tags.get(key)
            if isinstance(val, bytes) and (key in _TEXT_TAGS or len(val) > 64):
                val = val.decode("latin-1", "ignore")
            if isinstance(val, str) and (key in _TEXT_TAGS or len(val) > 64):
                parts.append(val[:_MAX_META_CHARS])
    for val in (img.info or {}).values():  # PNG text chunks, JPEG comments
        if isinstance(val, bytes):
            val = val.decode("latin-1", "ignore")
        if isinstance(val, str):
            parts.append(val[:_MAX_META_CHARS])
    return "\n".join(parts)


# ---- the data bar -----------------------------------------------------------------------

DARK_ROW_MAX = 90  # a data-bar row (black, with some white text) averages below this
BAR_CONTRAST = 15  # the image just above the bar is at least this much brighter
BAR_MIN_FRAC, BAR_MAX_FRAC = 0.03, 0.20  # the bar's height, as a share of the image's
BAR_MIN_PX = 16
BRIGHT = 150  # a text or scale-bar pixel in the bar is brighter than this


def _gray(img):
    if img.mode == "L":
        return img
    if img.mode in ("I;16", "I;16L", "I;16B", "I"):
        return (
            img.point(lambda v: v / 256, "L") if img.mode != "I" else img.convert("L")
        )
    return img.convert("L")


def find_data_bar(gray) -> int | None:
    """The y of the top of a dark bar along the bottom edge, or None. Looks only at the bottom 30%."""
    w, h = gray.size
    if h < 64 or w < 64:
        return None
    y0 = int(h * 0.70)
    n = h - y0
    means = list(gray.crop((0, y0, w, h)).resize((1, n), Image.BOX).tobytes())
    lo = max(int(h * (1 - BAR_MAX_FRAC)), y0 + 6)
    hi = min(int(h * (1 - BAR_MIN_FRAC)), h - BAR_MIN_PX)
    for y in range(lo, hi + 1):
        below = means[y - y0 :]
        above = means[y - y0 - 6 : y - y0]
        if max(below) >= DARK_ROW_MAX:
            continue
        if sum(above) / len(above) - sum(below) / len(below) >= BAR_CONTRAST:
            return y
    return None


def bar_features(gray, y: int) -> tuple[bool, bool]:
    """(text-like content, scale-bar line) in the bar that starts at row y."""
    w, h = gray.size
    bar = gray.crop((0, y, w, h))
    hist = bar.histogram()
    bright = sum(hist[BRIGHT + 1 :])
    frac = bright / float(w * (h - y))
    binary = bar.point(lambda v: 255 if v > BRIGHT else 0)
    raw = binary.tobytes()
    short_max = max(12, int(w * 0.01))
    line_min = max(24, int(w * 0.03))
    short_runs = 0
    rows_with_text = 0
    line_rows: list[int] = []
    for r in range(h - y):
        row = raw[r * w : (r + 1) * w]
        if 255 not in row:
            continue
        runs = [len(m.group()) for m in re.finditer(b"\xff+", row)]
        shorts = sum(1 for n in runs if n <= short_max)
        short_runs += shorts
        if shorts >= 3:
            rows_with_text += 1
        if max(runs) >= line_min:
            line_rows.append(r)
    text_like = 0.003 <= frac <= 0.30 and short_runs >= 30 and rows_with_text >= 5
    # a scale bar is a long run that is only a few rows thick
    line = False
    if line_rows:
        groups, start, prev = [], line_rows[0], line_rows[0]
        for r in line_rows[1:]:
            if r != prev + 1:
                groups.append(prev - start + 1)
                start = r
            prev = r
        groups.append(prev - start + 1)
        line = any(g <= max(10, int((h - y) * 0.2)) for g in groups)
    return text_like, line


# ---- the FEI bar and the negative signal ------------------------------------------------------

BAR_TOP_MIN_MEAN = 150  # the bar's white top row: a row mean above this ...
BAR_TOP_RATIO = 2.5  # ... and at least this many times the mean of the row two below
DIVIDER_ROW_FRAC = (
    0.9  # a divider column is bright in more than this share of the body rows
)
DIVIDER_BRIGHT_FRAC = (
    0.4  # ... where bright means above this share of the bar's maximum
)
MIN_DIVIDERS = 3  # fewer vertical dividers is not a cell structure
BODY_MAX_BRIGHT = 0.5  # a bar body is mostly dark: more bright pixels than this is a picture, not a bar

_OPTICAL = re.compile(r"microscope\s*x\s*\d+", re.I)
_DIRECTSHOW = re.compile(r"directshow", re.I)


def find_fei_bar(gray) -> int | None:
    """The top row y of an FEI-style bar, or None: the first row in the bottom quarter whose mean is above 150
    and at least 2.5 times the mean of the row two below. Relative, never an absolute white: a contrast-edited
    export lowers the dividers from 255 to about 207. A hit is not evidence of an SEM by itself."""
    w, h = gray.size
    if h < 64 or w < 64:
        return None
    y0 = int(h * 0.75)
    n = h - y0
    means = list(gray.crop((0, y0, w, h)).resize((1, n), Image.BOX).tobytes())
    for i in range(n - 2):
        if means[i] > BAR_TOP_MIN_MEAN and means[i] >= BAR_TOP_RATIO * means[i + 2]:
            return y0 + i
    return None


def bar_structure(gray, y: int) -> int | None:
    """The number of vertical divider columns in the bar whose top row is y, or None below 3. A divider column
    has more than 90% of the body rows (those under the top row) brighter than 0.4 times the bar's maximum;
    adjacent columns count once; a body that is mostly bright is a picture, not a bar. The cell layout varies (16 layouts in 120 real bars), so only this count is
    used, never a position."""
    w, h = gray.size
    if not 0 <= y < h - 4:
        return None
    top = gray.crop((0, y, w, h)).getextrema()[1]
    if top <= 0:
        return None
    body = gray.crop((0, y + 1, w, h))
    cut = top * DIVIDER_BRIGHT_FRAC
    binary = body.point(lambda v: 255 if v > cut else 0)
    cols = binary.resize(
        (w, 1), Image.BOX
    ).tobytes()  # per column: 255 x the share of bright body rows
    if sum(cols) > 255 * w * BODY_MAX_BRIGHT:
        return None
    groups, prev = 0, False
    for v in cols:
        divider = v > 255 * DIVIDER_ROW_FRAC
        groups += divider and not prev
        prev = divider
    return groups if groups >= MIN_DIVIDERS else None


def _tiff_text(tags, key: int) -> str:
    val = tags.get(key)
    if isinstance(val, bytes):
        val = val.decode("latin-1", "ignore")
    return val if isinstance(val, str) else ""


def negative_signal(img) -> str | None:
    """Why this image is not an SEM, or None: TIFF tag 272 (Model) matching `Microscope x<N>` (an optical
    microscope camera), or tag 271/272 naming a DirectShow capture device."""
    try:
        tags = img.tag_v2  # TIFF only
    except AttributeError:
        return None
    make, model = _tiff_text(tags, 271), _tiff_text(tags, 272)
    if _OPTICAL.search(model):
        return (
            f"optical microscope image (TIFF model {model.strip()[:40]!r}), not an SEM"
        )
    if _DIRECTSHOW.search(make) or _DIRECTSHOW.search(model):
        return "video-capture device image (DirectShow), not an SEM"
    return None


class JeolProfile:
    """JEOL SEM: embedded metadata naming JEOL, and a data bar (black strip along the bottom, white text, a
    scale-bar line). A bar alone is not evidence, so without JEOL metadata the confidence stays below the
    claim threshold."""

    name = "JEOL"

    def inspect(
        self, img, ocr: bool, ocr_func: Callable | None
    ) -> ProfileResult | None:
        extracted: dict = {}
        meta = _metadata_text(img)
        jeol_meta = bool(re.search(r"jeol", meta, re.I))
        if jeol_meta:
            extracted["instrument"] = "JEOL"
            extracted.update(parse_text(meta))
        gray = _gray(img)
        y = find_data_bar(gray)
        text_like = line = False
        if y is not None:
            text_like, line = bar_features(gray, y)
        if y is not None and text_like:
            conf = 0.6 + (0.3 if line else 0.0) + (0.1 if jeol_meta else 0.0)
            if not jeol_meta:
                conf = min(conf, NEGATIVE_CAP)  # a bar alone is no SEM evidence
            reason = "data bar with text" + (" and scale-bar line" if line else "")
            if ocr and ocr_func is not None:
                w, h = gray.size
                try:
                    text = ocr_func(gray.crop((0, y, w, h)))
                except Exception:  # an OCR failure must not lose the tag
                    text = ""
                read = parse_text(text or "", scale_bar=True)
                for k, v in read.items():
                    extracted.setdefault(k, v)
            return ProfileResult(round(min(conf, 1.0), 3), extracted, reason)
        if jeol_meta:
            return ProfileResult(0.65, extracted, "JEOL metadata, no data bar found")
        return None


class FeiProfile:
    """FEI/Thermo SEM. Claims from metadata only here (the OCR claim of a bar with its labels read comes with
    the bar reader): TIFF tag 34682 with `[System] Type=SEM` and `[PrivateFei]` is 0.9, 0.95 when the image also
    has a bar with a cell structure."""

    name = "FEI"

    def inspect(
        self, img, ocr: bool, ocr_func: Callable | None
    ) -> ProfileResult | None:
        meta = fei_metadata(img)
        if meta is None:
            return None
        gray = _gray(img)
        y = find_fei_bar(gray)
        bar_px = meta.pop("bar_height_px", None)
        if y is None and bar_px and bar_px < gray.size[1]:
            y = (
                gray.size[1] - bar_px
            )  # DatabarHeight places a bar whose top row is not bright
        structured = y is not None and bar_structure(gray, y) is not None
        if "acquired_at" in meta:
            meta["acquired_at"] = meta["acquired_at"].isoformat()
        reason = "FEI metadata" + (" and data bar" if structured else ", no data bar")
        return ProfileResult(0.95 if structured else 0.9, meta, reason)


PROFILES: tuple[SemProfile, ...] = (JeolProfile(), FeiProfile())


def default_ocr(bar_image) -> str:
    """OCR of the data bar through the optional pytesseract package. Raises when it is not installed."""
    import pytesseract  # optional: not in the service's requirements until OCR has been validated

    return pytesseract.image_to_string(bar_image, config="--psm 6")


def classify_image(
    fh,
    *,
    ocr: bool = False,
    profiles=None,
    ocr_func: Callable | None = None,
) -> Classification:
    """sem_image with a confidence and what was read, or a plain image. `fh` is a binary file object."""
    if not isinstance(fh, BytesIO):
        # Pillow is only ever given bytes the crawler already read through fs_readonly, never a path or
        # a handle on the share.
        raise TypeError("classify_image takes an in-memory io.BytesIO")
    if Image is None:  # pragma: no cover
        return Classification(
            "image", None, {}, "Pillow is not installed", CLASSIFIER_VERSION
        )
    profiles = PROFILES if profiles is None else profiles
    if ocr and ocr_func is None:
        ocr_func = default_ocr
    try:
        with warnings.catch_warnings():
            # Pillow only warns between 1x and 2x its limit; a warning here is an error.
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            Image.MAX_IMAGE_PIXELS = MAX_PIXELS
            img = Image.open(fh, formats=FORMATS)
            w, h = img.size  # known from the header, before anything is decoded
            if w * h > MAX_PIXELS:
                return Classification(
                    "image",
                    None,
                    {},
                    f"not decoded: too large ({w} x {h} pixels)",
                    CLASSIFIER_VERSION,
                )
            if img.format == "JPEG" and w * h > DRAFT_ABOVE_PIXELS:
                img.draft("L", (w // 2, h // 2))
            img.load()
    except Exception as exc:  # a corrupt, huge or exotic file is still a found file
        return Classification(
            "image",
            None,
            {},
            f"not decoded: {type(exc).__name__}",
            CLASSIFIER_VERSION,
        )
    best: ProfileResult | None = None
    for p in profiles:
        try:
            r = p.inspect(img, ocr, ocr_func)
        except Exception:  # one broken profile must not stop the others
            continue
        if r is not None and (best is None or r.confidence > best.confidence):
            best = r
    negative = None
    try:
        negative = negative_signal(img)
    except Exception:  # a broken tag must not lose the classification
        pass
    if negative is not None and best is not None:
        best = ProfileResult(
            min(best.confidence, NEGATIVE_CAP), best.extracted, negative
        )
    if best is not None and best.confidence >= SEM_MIN_CONFIDENCE:
        return Classification(
            "sem_image",
            best.confidence,
            dict(best.extracted),
            best.reason,
            CLASSIFIER_VERSION,
        )
    if negative is not None:
        reason = negative
    elif best is not None or _has_bar_structure(img):
        reason = "data-bar-like strip, no SEM evidence"
    else:
        reason = "no SEM profile matched"
    return Classification("image", None, {}, reason, CLASSIFIER_VERSION)


def _has_bar_structure(img) -> bool:
    """A bar with a cell structure is present (and no profile claimed the image)."""
    try:
        gray = _gray(img)
        y = find_fei_bar(gray)
        return y is not None and bar_structure(gray, y) is not None
    except Exception:
        return False
