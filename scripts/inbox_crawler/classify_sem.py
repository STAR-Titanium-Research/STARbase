"""Is this image a (possible) SEM image? A pluggable per-instrument profile (spec section 7).

`classify_image(fh)` takes an in-memory `io.BytesIO` (the bytes the crawler already read through
`fs_readonly`), never a path or a handle, so Pillow cannot reach the share by itself. Each `SemProfile` looks at the picture
and either claims it with a confidence or says nothing. Two profiles: FEI/Thermo (TIFF tag 34682, read by
`sem_meta`, or a bar with a cell structure whose header labels `sem_bar` read by OCR) and JEOL (embedded metadata
naming JEOL). A claim needs positive evidence: a dark strip with text-like pixels alone never reaches
`SEM_MIN_CONFIDENCE`, because thermal cameras, optical microscopes and report figures have one. A negative
signal (an optical-microscope or video-capture TIFF) caps every claim below the threshold.

The tag is a guess until it has been validated on the maintainer's sample strips (physical-test backlog
IF8): the UI words it "possible SEM image". `extracted` carries only what was read from the file: embedded
metadata, and the data bar's text when OCR is switched on (`INBOX_OCR=1`, default off). Never a value the
picture merely suggests.
"""

from __future__ import annotations

import logging
import os
import re
import warnings
from collections.abc import Callable
from dataclasses import dataclass
from io import BytesIO
from typing import Protocol

from .kinds import Classification
from .sem_meta import (
    DIVIDER_BRIGHT_FRAC,
    DIVIDER_ROW_FRAC,
    RANGES,
    SEP,
    fei_metadata,
    tiff_tag_text,
    um_of,
)

log = logging.getLogger("inbox_crawler.classify_sem")

try:  # Pillow is a dependency of the service; the pure helpers below work without it
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None

SEM_MIN_CONFIDENCE = 0.6  # at or above this a profile's claim becomes kind sem_image
NEGATIVE_CAP = 0.55  # a negative signal (optical microscope, capture device) caps any claim at this
CLASSIFIER_VERSION = (
    "sem-2"  # stored as classified_by; --reclassify re-reads rows at an older version
)
OCR_CLAIM_CONFIDENCE = 0.8  # a bar with a cell structure and at least MIN_BAR_LABELS header labels read by OCR
MIN_BAR_LABELS = 2
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
    """A per-instrument detector. `inspect` gets the decoded picture (PIL image), the OCR switch, the text OCR
    function JEOL uses (`ocr_func`) and the cell recogniser the FEI data-bar reader uses (`bar_reader`)."""

    name: str

    def inspect(
        self,
        img,
        ocr: bool,
        ocr_func: Callable | None,
        bar_reader: Callable | None = None,
    ) -> ProfileResult | None: ...


# ---- text parsing (metadata, OCR) -------------------------------------------------------

_KV = re.compile(
    r"(?<![\d.])(\d+(?:\.\d+)?)\s*kV", re.I
)  # the lookbehind keeps a long digit run linear
_NUM = rf"\d{{1,3}}(?:{SEP}\d{{3}}){{1,2}}|\d{{1,6}}"  # at most 999 999 999: bounds the scan of a long digit run
_MAG = re.compile(
    # "x5,000" or "×250" (the sign first, commas only: a space would swallow the next number)
    r"(?:(?<![A-Za-z0-9])[x×]\s?(\d{1,3}(?:,\d{3})+|\d{2,6})(?![\d.]))"
    # "mag: 5000"
    r"|(?:\bmag\w*\s*[=:]\s*(\d{1,3}(?:,\d{3})+|\d{2,6})\b)"
    # "1 200 x", "40×", "3 000 x" (an instrument bar prints the sign last, thin spaces between thousands)
    rf"|(?:(?<![\d.,])({_NUM})\s*[x×](?![A-Za-z0-9]))",
    re.I,
)
_SCALE = re.compile(r"(?<![\d.])(\d+(?:\.\d+)?)\s*(nm|µm|μm|um|mm)(?![A-Za-z])", re.I)
_WD = re.compile(r"\bWD\s*[=:]?\s*(\d+(?:\.\d+)?)\s*mm", re.I)


def parse_text(text: str, *, scale_bar: bool = False) -> dict:
    """The values a block of text states: kV, magnification, working distance (and, for a data bar read
    by OCR, the scale-bar label as `scale_bar_um`, a number of micrometres). Only what is there; absent keys
    stay absent. A kV, magnification or working distance outside `sem_meta.RANGES` is left out, never guessed."""
    out: dict = {}

    def keep(key: str, value: float) -> None:
        lo, hi = RANGES[key]
        if lo <= value <= hi:
            out[key] = value

    m = _KV.search(text)
    if m:
        keep("kv", float(m.group(1)))
    m = _MAG.search(text)
    if m:
        digits = m.group(1) or m.group(2) or m.group(3)
        keep("magnification", int(re.sub(SEP, "", digits)))
    m = _WD.search(text)
    if m:
        keep("working_distance_mm", float(m.group(1)))
    if scale_bar:
        wd_end = _WD.search(text)
        for s in _SCALE.finditer(text):
            if wd_end and wd_end.start() <= s.start() < wd_end.end():
                continue  # the working distance is not the scale bar
            out["scale_bar_um"] = um_of(s.group(1), s.group(2))
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


def negative_signal(img) -> str | None:
    """Why this image is not an SEM, or None: TIFF tag 272 (Model) matching `Microscope x<N>` (an optical
    microscope camera), or tag 271/272 naming a DirectShow capture device."""
    make, model = tiff_tag_text(img, 271) or "", tiff_tag_text(img, 272) or ""
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
        self,
        img,
        ocr: bool,
        ocr_func: Callable | None,
        bar_reader: Callable | None = None,
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
            if (
                ocr and ocr_func is not None and jeol_meta
            ):  # a bar alone is capped: not worth reading
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


_BAR_TOLERANCE = {  # how far the bar's printed value may be from the metadata's before they disagree
    "kv": lambda meta: max(0.01, 0.005 * meta),
    "working_distance_mm": lambda meta: 0.06,  # the bar prints 0.1 mm
    "spot": lambda meta: 0.05,
    "magnification": lambda meta: max(
        1.0, 0.02 * meta
    ),  # a printed 40x is a rounded 40.05
    # calculated from the bar's pixel length and its label: a pixel or two of the bar is a percent of it, as in `sem_bar.SCALE_TOLERANCE`
    "pixel_size_nm": lambda meta: 0.05 * meta,
    "hfw_um": lambda meta: 0.05 * meta,
}
_warned: dict[
    str, bool
] = {}  # one log line per kind of reader trouble, not one per file


def _warn_once(kind: str, message: str, *args) -> None:
    (log.debug if _warned.get(kind) else log.warning)(message, *args)
    _warned[kind] = True


def _confidence_of(parsed, keys) -> dict:
    """The recogniser's confidence for each of `keys` the bar read, rounded to 2 decimals. Recorded for whoever
    looks at the value later, never a threshold (correct reads scored as low as 0.60)."""
    return {
        key: round(parsed.confidence[key], 2)
        for key in keys
        if key in parsed.confidence
    }


def _squash(text) -> str:
    return "".join(str(text).upper().split())


def _bar_agrees(key: str, meta_value, bar_value) -> bool:
    """Whether the bar's value for `key` agrees with the metadata's."""
    if isinstance(meta_value, str) or isinstance(bar_value, str):
        return _squash(meta_value) == _squash(bar_value)
    tolerance = _BAR_TOLERANCE.get(key)
    if tolerance is None:
        return meta_value == bar_value
    return abs(meta_value - bar_value) <= tolerance(abs(meta_value))


class FeiProfile:
    """FEI/Thermo SEM. Two kinds of positive evidence. Metadata: TIFF tag 34682 with `[System] Type=SEM` and
    `[PrivateFei]` is 0.9, 0.95 when the image also has a bar with a cell structure. Or, for a PNG, JPEG, BMP or a
    TIFF without the tag and only with `INBOX_OCR=1`: a bar with a cell structure whose header labels (at least
    two of `HV det WD mag mode spot`) the recogniser reads is 0.8, and its values come from the bar. With both,
    the metadata's values win and a bar that disagrees is noted in `flags` (`bar_mismatch`)."""

    name = "FEI"

    def inspect(
        self,
        img,
        ocr: bool,
        ocr_func: Callable | None,
        bar_reader: Callable | None = None,
    ) -> ProfileResult | None:
        meta = fei_metadata(img)
        reading = ocr and bar_reader is not None
        if meta is None and not reading:
            return None  # no metadata and no bar reading: nothing can claim the image
        gray = _gray(img)
        y = find_fei_bar(gray)
        if meta is not None:
            bar_px = meta.pop("bar_height_px", None)
            if y is None and bar_px and bar_px < gray.size[1]:
                y = (
                    gray.size[1] - bar_px
                )  # DatabarHeight places a bar whose top row is not bright
        structured = y is not None and bar_structure(gray, y) is not None
        read = None
        if reading and structured:
            read = self._read_bar(
                gray, y, bar_reader, None if meta is None else meta.get("hfw_um")
            )
        if meta is None:
            if read is None or read[0] < MIN_BAR_LABELS:
                return None
            labels, parsed = read
            extracted = {
                **parsed.values,
                "sources": parsed.sources,
                "flags": parsed.flags,
            }
            if parsed.confidence:
                extracted["ocr_confidence"] = _confidence_of(parsed, parsed.values)
            return ProfileResult(
                OCR_CLAIM_CONFIDENCE,
                extracted,
                f"data bar read by OCR ({labels} labels)",
            )
        if "acquired_at" in meta:
            meta["acquired_at"] = meta["acquired_at"].isoformat()
        if read is not None:
            self._compare(meta, read[1])
        reason = "FEI metadata" + (" and data bar" if structured else ", no data bar")
        return ProfileResult(0.95 if structured else 0.9, meta, reason)

    @staticmethod
    def _read_bar(gray, y: int, bar_reader, hfw_um):
        """`(labels read, BarValues)` for the bar whose top row is y, or None when the reader fails: a reader
        trouble must never lose the image, which is still classified from its metadata or stays a plain image."""
        try:
            from . import sem_bar

            w, h = gray.size
            bar = gray.crop((0, y, w, h))
            cells = sem_bar.cut_cells(bar)
            read = sem_bar.read_bar(bar, bar_reader, cells)
            labels = sum(1 for key in read if key != "scale")
            parsed = sem_bar.parse_bar(
                read,
                image_width=w,
                scale_px=sem_bar.scale_bar_length_px(bar, cells) if read else None,
                hfw_um=hfw_um,
            )
            return labels, parsed
        except Exception as exc:  # noqa: BLE001 - numpy missing, a recogniser fault, a bad crop
            _warn_once(
                "bar", "the data bar was not read (%s: %s)", type(exc).__name__, exc
            )
            return None

    @staticmethod
    def _compare(meta: dict, parsed) -> None:
        """Metadata wins. A bar value that disagrees is noted as `bar_mismatch` under its field; a value only the
        bar states (the scale-bar label) is added as `ocr`, unless the metadata flagged that field itself."""
        flags, sources = meta["flags"], meta["sources"]
        for key, bar_value in parsed.values.items():
            if key in meta:
                if not _bar_agrees(key, meta[key], bar_value):
                    flags[key] = "bar_mismatch"
            elif key not in flags:
                meta[key] = bar_value
                sources[key] = parsed.sources[key]
                meta.setdefault("ocr_confidence", {}).update(
                    _confidence_of(parsed, [key])
                )
                if parsed.flags.get("check_this"):
                    flags["check_this"] = True
        if parsed.flags.get("magnification") == "hfw_mismatch":
            flags["magnification"] = (
                "bar_mismatch"  # the bar's number contradicts the field width
            )
        if parsed.flags.get("scale_bar_um") == "length_mismatch":
            flags["scale_bar_um"] = "length_mismatch"


PROFILES: tuple[SemProfile, ...] = (JeolProfile(), FeiProfile())


def _default_bar_reader():
    """The RapidOCR recogniser for `INBOX_OCR_DEVICE`, built once per process (`sem_bar` caches it), or None with
    one log line when it cannot be built (rapidocr or numpy is not installed): bars are then not read."""
    try:
        from . import sem_bar

        return sem_bar.default_bar_reader(os.environ.get("INBOX_OCR_DEVICE", "cpu"))
    except Exception as exc:  # noqa: BLE001 - ImportError mostly; any failure means no bar reading
        _warn_once(
            "reader",
            "INBOX_OCR=1 but the data-bar reader is not available (%s: %s): bars are not read",
            type(exc).__name__,
            exc,
        )
        return None


def classify_image(
    fh,
    *,
    ocr: bool = False,
    profiles=None,
    ocr_func: Callable | None = None,
    bar_reader: Callable | None = None,
) -> Classification:
    """sem_image with a confidence and what was read, or a plain image. `fh` is a binary file object.
    `ocr_func` reads text for the JEOL profile; `bar_reader` is the cell recogniser the FEI data-bar reader uses
    (`sem_bar.Recogniser`). With `ocr` on and no `bar_reader`, the default one is built once per process."""
    if not isinstance(fh, BytesIO):
        # Pillow is only ever given bytes the crawler already read through fs_readonly, never a path or
        # a handle on the share.
        raise TypeError("classify_image takes an in-memory io.BytesIO")
    if Image is None:  # pragma: no cover
        return Classification(
            "image", None, {}, "Pillow is not installed", CLASSIFIER_VERSION
        )
    profiles = PROFILES if profiles is None else profiles
    if ocr and bar_reader is None:
        bar_reader = _default_bar_reader()
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
            r = p.inspect(img, ocr, ocr_func, bar_reader)
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
