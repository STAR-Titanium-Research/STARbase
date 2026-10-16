"""The FEI/Thermo data bar read cell by cell (SEM reader spec section 2, tier 2).

Real FEI bars are bilevel white on black in a fixed font: two rows of cells (a header and its value) and the scale
bar on the right, for example `20.00 kV | ETD | 9.2 mm | 3 000 x | SE | 3.0 | 40 µm`. The method is the one the
2026-10-16 trial proved on 246 real TIFF bars and 37 real PNG, JPEG and BMP exports (branch `spike/sem-bar-ocr`),
ported here, not imported:

1. Cut the cells ourselves from the vertical divider columns. RapidOCR's text detector is never run: it smears the
   whole bar into one garbage line. Only a text recogniser reads the crops.
2. Map a cell to a field by its header text (`hv det wd mag mode spot`), never by position: the layouts differ.
3. Parse each value as one number with its unit, range-check it, and cross-check the magnification
   (`mag x HFW` against the screen-width constants, the scale-bar label against the bar's pixel length). A value
   that fails is left out with a flag; one that nothing could vouch for is kept with `flags.check_this`.

OCR confidence is recorded in `BarValues.confidence` and is never a filter (correct reads scored as low as 0.60).

Like `sem_meta` this is a pure function of an in-memory `PIL.Image`: it opens no file, writes nothing, spawns
nothing and calls no network. `numpy` and the optional `rapidocr_onnxruntime` come with `INBOX_OCR=1`; the
recogniser is injected, so the unit tests need neither.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy
from PIL import Image, ImageOps

from .sem_meta import DIVIDER_BRIGHT_FRAC, DIVIDER_ROW_FRAC, RANGES, SEP, um_of

log = logging.getLogger("inbox_crawler.sem_bar")

# A list of RGB numpy arrays (one per crop) in, `(text, confidence)` per crop out, in the same order.
Recogniser = Callable[[list], list[tuple[str, float]]]

CANVAS_M = (
    0.2984,
    0.2984 * 0.858,
)  # `magnification x HFW` (metres) on real files: two screen widths
MAG_TOLERANCE = 0.02  # a printed 40x is a rounded 40.05
SCALE_TOLERANCE = 0.05  # the scale-bar label against the bar's pixel length

MIN_CELL_PX = 12  # a narrower strip between dividers is not a cell
INSET_PX = 2  # crops stay this far inside a cell, off the divider and the top row
SPLIT_BAND = (
    0.3,
    0.7,
)  # the header/value gap is looked for in this band of the bar's height
SPLIT_LEFT = 0.4  # ... judged on this share of the width, where the cells are (the scale bar is on the right)
SPLIT_TOLERANCE = 2  # a row is as dark as the darkest if its mean is within this much
MIN_CELLS = 3
SCALE_LINE_MIN_PX = 20  # a scale bar is a run at least this long
SCALE_LINE_BRIGHT_FRAC = (
    200 / 255
)  # "above 200" on a plain bar, relative so a contrast-edited export still works
CROP_SCALE = 2  # each crop is enlarged this much (LANCZOS) ...
CROP_BORDER = 6  # ... and padded with this many white pixels before recognition

HEADERS = (
    "hv",
    "det",
    "wd",
    "mag",
    "mode",
    "spot",
)  # matched by the start of the header text
_SCALE_LABEL = re.compile(
    r"\d\s*[nuμµm]m$"
)  # the scale-bar cell carries its label on the top row


@dataclass(frozen=True)
class BarCell:
    """One cell of the bar: its columns and its header and value crops (grey-scale images)."""

    x0: int
    x1: int
    header: Image.Image
    value: Image.Image


@dataclass
class BarValues:
    """What the bar states, in the keys of `extracted`: `values` (numeric, unit in the key, absent when unknown),
    `sources` (every kept key `ocr`, derived from `values`), `flags` (why a value is absent or unconfirmed) and `confidence` (the
    recogniser's score for each kept key; recorded, never a threshold)."""

    values: dict = field(default_factory=dict)
    flags: dict = field(default_factory=dict)
    confidence: dict = field(default_factory=dict)

    @property
    def sources(self) -> dict:
        return {key: "ocr" for key in self.values}


# ---- cells ----------------------------------------------------------------------------------


def _gray(bar) -> Image.Image:
    return bar if bar.mode == "L" else bar.convert("L")


def cut_cells(bar) -> list[BarCell]:
    """The cells of an FEI bar (an image of the bar alone, top row first), or `[]` below three cells.

    Vertical dividers are the columns where more than 90% of the body rows (row 2 down to the last but one) are
    brighter than 0.4 times the bar's maximum: relative, because a contrast-edited export lowers the dividers from
    255 to about 207. There is no horizontal line between a cell's header and its value, so the two rows are split
    at the middle of the darkest run of rows in the 30% to 70% band, judged on the left 40% of the width (the only
    horizontal lines are the scale bar's, on the right, and a full-width row mean would take that for the gap).
    Crops sit 2 px inside the cell; a cell narrower than 12 px is dropped."""
    gray = _gray(bar)
    a = numpy.asarray(gray)
    h, w = a.shape
    top = int(a.max()) if a.size else 0
    if top <= 0 or h < 8 or w < MIN_CELLS * MIN_CELL_PX:
        return []
    left = a[:, : int(w * SPLIT_LEFT)].mean(axis=1)
    band = range(int(SPLIT_BAND[0] * h), int(SPLIT_BAND[1] * h) + 1)
    darkest = min(left[y] for y in band)
    dark = [y for y in band if left[y] <= darkest + SPLIT_TOLERANCE]
    mid = (dark[0] + dark[-1]) // 2
    if mid - INSET_PX < 1 or (h - 1) - (mid + INSET_PX) < 1:
        return []
    body = a[INSET_PX : h - 1]
    bright_share = (body > DIVIDER_BRIGHT_FRAC * top).mean(axis=0)
    groups: list[list[int]] = []
    for x in numpy.nonzero(bright_share > DIVIDER_ROW_FRAC)[0].tolist():
        if groups and x - groups[-1][-1] <= 1:
            groups[-1].append(x)
        else:
            groups.append([x])
    xs = [0] + [g[len(g) // 2] for g in groups] + [w]
    cells = []
    for x0, x1 in zip(xs, xs[1:]):
        if x1 - x0 < MIN_CELL_PX:
            continue
        header = gray.crop((x0 + INSET_PX, INSET_PX, x1 - 1, mid))
        value = gray.crop((x0 + INSET_PX, mid + INSET_PX, x1 - 1, h - 1))
        cells.append(BarCell(x0, x1, header, value))
    return cells if len(cells) >= MIN_CELLS else []


def scale_bar_length_px(bar, cells: list[BarCell] | None = None) -> int | None:
    """The scale bar's length in pixels, or None: the longest run of bright pixels of at least 20 px in any single
    row of the rightmost cell. A real FEI bar is drawn through its own label ("---- 50 um ----"), so a row with
    two or more such runs is one bar broken by the label: it measures from the start of the first run to the end
    of the last. The top row is not looked at, and a run that spans the whole cell is a divider row,
    not a scale bar. "Bright" is relative (200 of 255 of the bar's maximum) so a contrast-edited bar still reads.
    `cells` are the bar's `cut_cells` when the caller already has them."""
    if cells is None:
        cells = cut_cells(bar)
    if not cells:
        return None
    a = numpy.asarray(_gray(bar))
    h = a.shape[0]
    x0, x1 = cells[-1].x0 + INSET_PX, cells[-1].x1 - 1
    bright = a[INSET_PX : h - 1, x0:x1] > SCALE_LINE_BRIGHT_FRAC * int(a.max())
    width = x1 - x0
    best = 0
    for row in bright:
        edges = numpy.diff(numpy.pad(row.astype(numpy.int8), 1))
        runs = [
            (start, end)
            for start, end in zip(
                numpy.nonzero(edges == 1)[0].tolist(),
                numpy.nonzero(edges == -1)[0].tolist(),
            )
            if SCALE_LINE_MIN_PX <= end - start < width
        ]  # a run from edge to edge is not a scale bar; a shorter one is a glyph stroke
        if runs:
            best = max(best, runs[-1][1] - runs[0][0])
    return best if best >= SCALE_LINE_MIN_PX else None


# ---- recognition ----------------------------------------------------------------------------


def _prepare(crop) -> numpy.ndarray:
    """Black text on white, 2x with Lanczos, 6 px of white padding, as an RGB array."""
    big = ImageOps.invert(crop).resize(
        (crop.width * CROP_SCALE, crop.height * CROP_SCALE), Image.LANCZOS
    )
    return numpy.asarray(
        ImageOps.expand(big, border=CROP_BORDER, fill=255).convert("RGB")
    )


def read_bar(
    bar, recognise: Recogniser, cells: list[BarCell] | None = None
) -> dict[str, tuple[str, float]]:
    """The text of each field the bar shows, `{key: (text, confidence)}` with key one of `hv det wd mag mode spot
    scale`. One `recognise` call reads every crop (a header and a value per cell, in cell order). A header is
    matched by its start (`hv`, `det`, `wd`, `mag`, `mode`, `spot`; others are ignored); when no header matches but
    it reads like a length (`40 µm`), the cell is the scale bar and that label is the `scale` text. `{}` when the
    bar has no cells or the recogniser did not answer for every crop. `cells` are the bar's `cut_cells` when the
    caller already has them."""
    if cells is None:
        cells = cut_cells(bar)
    if not cells:
        return {}
    crops = []
    for cell in cells:
        crops += [_prepare(cell.header), _prepare(cell.value)]
    results = recognise(crops)
    if len(results) != len(crops):
        log.warning(
            "the recogniser answered for %d of %d crops: the bar is not read",
            len(results),
            len(crops),
        )
        return {}
    out: dict[str, tuple[str, float]] = {}
    for i in range(len(cells)):
        head, head_conf = results[2 * i]
        text, conf = results[2 * i + 1]
        head = str(head).strip()
        key = next((k for k in HEADERS if head.lower().startswith(k)), None)
        if key is None and _SCALE_LABEL.search(head):
            key, text, conf = "scale", head, head_conf
        if key is not None and key not in out:
            out[key] = (str(text).strip(), float(conf))
    return out


# ---- parsing and checks ---------------------------------------------------------------------

_DECIMAL = re.compile(r"\d+(?:[.,]\d+)?")
_INT_CHAIN = re.compile(rf"\d+(?:{SEP}\d+)*")
_SEP_SPLIT = re.compile(SEP)
_SCALE_TEXT = re.compile(r"(\d+(?:[.,]\d+)?)\s*(nm|µm|μm|um|mm)(?![A-Za-z])", re.I)
_TEXT_FIELD = re.compile(r"[A-Za-z0-9][A-Za-z0-9 .+/-]{0,23}")


def _decimal(text: str) -> float | None:
    """The one decimal number in `text` (`20.00 kV`, `10,3 mm`), or None for none or several. A space is never
    part of a decimal, so `20.00 7 kV` is not 20.007."""
    found = _DECIMAL.findall(text)
    return float(re.sub(",", ".", found[0])) if len(found) == 1 else None


def _magnification(text: str) -> int | None:
    """The one whole number in `text` with its thousands grouping intact (`1 200 x`, `1 200 x`, `5,000 x`, `40×`).
    Thin, no-break and ordinary spaces (and commas) are thousands separators, so a stray extra number next to the
    value would merge with it; two or more numbers, or a group that is not exactly three digits (`5 1 200`), is not
    read at all."""
    chains = _INT_CHAIN.findall(text)
    if len(chains) != 1:
        return None
    groups = _SEP_SPLIT.split(chains[0])
    if len(groups) > 1 and not (
        len(groups[0]) <= 3 and all(len(g) == 3 for g in groups[1:])
    ):
        return None
    return int("".join(groups))


def _scale_label_um(text: str) -> float | None:
    """The scale-bar label (`100μm`, `3mm`) as micrometres, or None when it is not one number and a unit."""
    if len(_DECIMAL.findall(text)) != 1:
        return None
    m = _SCALE_TEXT.search(text)
    if m is None:
        return None
    return um_of(re.sub(",", ".", m.group(1)), m.group(2))


def _canvas_of(magnification: int, hfw_um: float) -> float | None:
    """The screen-width constant `magnification x hfw` equals within 2%, or None."""
    product = magnification * hfw_um * 1e-6
    for canvas in CANVAS_M:
        if abs(product - canvas) <= MAG_TOLERANCE * canvas:
            return canvas
    return None


def parse_bar(
    read: dict,
    *,
    image_width: int,
    scale_px: int | None,
    hfw_um: float | None = None,
) -> BarValues:
    """Values from what `read_bar` returned, with their ranges and cross-checks.

    kV, working distance and spot are decimals (`sem_meta.RANGES`); the magnification is a whole number whose
    grouping must be intact; the scale-bar label becomes `scale_bar_um`; detector and mode are short text. A value
    that does not parse is omitted with `flags[key] = "not_a_number"` (text: `"unparseable"`), one outside its range
    with `"out_of_range"`, the field name being the flag key. Then the checks: `magnification x hfw_um` (when the
    field width is known) must equal a screen-width constant within 2%, else the magnification is omitted with
    `"hfw_mismatch"`; the scale-bar label must match `scale_px` (the bar's pixel length in an image `image_width`
    wide) at that magnification within 5%, else `scale_bar_um` is omitted with `"length_mismatch"` and, unless the
    field width had already vouched for the magnification, so is the magnification (also `"length_mismatch"`: the
    label or the number is wrong and nothing says which, so neither is kept). When something was read and no check
    could vouch for it, `flags["check_this"] = True`."""
    out = BarValues()

    def keep(key: str, value, conf: float) -> None:
        out.values[key] = value
        out.confidence[key] = conf

    def drop(key: str, flag: str) -> None:
        del out.values[key], out.confidence[key]
        out.flags[key] = flag

    def numeric(cell: str, key: str, parse: Callable[[str], float | None]) -> None:
        if cell not in read:
            return
        text, conf = read[cell]
        value = parse(text)
        if value is None:
            out.flags[key] = "not_a_number"
            return
        if key in RANGES and not RANGES[key][0] <= value <= RANGES[key][1]:
            out.flags[key] = "out_of_range"
            return
        keep(key, value, conf)

    numeric("hv", "kv", _decimal)
    numeric("wd", "working_distance_mm", _decimal)
    numeric("spot", "spot", _decimal)
    numeric("mag", "magnification", _magnification)
    if "scale" in read:
        text, conf = read["scale"]
        label = _scale_label_um(text)
        if label is None:
            out.flags["scale_bar_um"] = "not_a_number"
        elif label <= 0:
            out.flags["scale_bar_um"] = "out_of_range"
        else:
            keep("scale_bar_um", label, conf)
    for cell, key in (("det", "detector"), ("mode", "mode")):
        if cell in read:
            text, conf = read[cell]
            # a trailing full stop is the recogniser's, not the instrument's ("None." read from a bar that says "None")
            text = " ".join(text.split()).rstrip(". ")
            if _TEXT_FIELD.fullmatch(text):
                keep(key, text, conf)
            else:
                out.flags[key] = "unparseable"

    confirmed = False
    canvas = None
    if "magnification" in out.values and hfw_um is not None and hfw_um > 0:
        canvas = _canvas_of(out.values["magnification"], hfw_um)
        if canvas is None:
            drop("magnification", "hfw_mismatch")
        else:
            confirmed = True
    if "scale_bar_um" in out.values and "magnification" in out.values:
        if scale_px and image_width > 0:
            # the screen width the field width identified, else the first constant (nothing says which applies)
            implied = (
                scale_px
                * (canvas or CANVAS_M[0])
                * 1e6
                / (out.values["magnification"] * image_width)
            )
            if abs(out.values["scale_bar_um"] - implied) <= SCALE_TOLERANCE * implied:
                confirmed = True
            else:
                # the field width (canvas) had vouched for the magnification: only the label goes
                for key in (
                    ["scale_bar_um"]
                    if canvas is not None
                    else ["scale_bar_um", "magnification"]
                ):
                    drop(key, "length_mismatch")
    if out.values and not confirmed:
        out.flags["check_this"] = True
    return out


# ---- the default recogniser -----------------------------------------------------------------

_CPU, _CUDA = "CPUExecutionProvider", "CUDAExecutionProvider"
# One recogniser per device and process (the models load once). A device whose rapidocr import failed holds that
# ImportError instead, so every later bar fails at once and the import is not retried for each image.
_READERS: dict[str, Recogniser | ImportError] = {}


def _on_cuda(recogniser) -> str:
    """Move RapidOCR's recogniser session to the GPU when onnxruntime offers it; the provider now in use.
    RapidOCR 1.2.3 ignores `rec_use_cuda` (the key is not mapped onto its config), so the session is rebuilt.
    A session that builds can still fail when it runs (a driver or cuDNN mismatch), which would fail every bar,
    so the new session must read a small blank crop first; if that raises or answers the wrong shape the CPU
    session is put back and one warning says so."""
    import onnxruntime

    if _CUDA not in onnxruntime.get_available_providers():
        raise RuntimeError("this onnxruntime has no CUDAExecutionProvider")
    holder = recogniser.session
    cpu_session = holder.session
    holder.session = onnxruntime.InferenceSession(
        cpu_session._model_path, providers=[_CUDA, _CPU]
    )
    try:
        results, _elapsed = recogniser([numpy.full((24, 96, 3), 255, numpy.uint8)])
        if len(results) != 1 or len(results[0]) != 2:
            raise RuntimeError(f"the test read answered {results!r}")
    except Exception as exc:  # noqa: BLE001 - whatever the GPU session does wrong, the CPU one is still there
        holder.session = cpu_session
        log.warning(
            "the CUDA session built but failed a test read (%s: %s): data-bar OCR stays on the CPU",
            type(exc).__name__,
            exc,
        )
        return _CPU
    return holder.session.get_providers()[0]


def default_bar_reader(device: str = "cpu") -> Recogniser:
    """The RapidOCR text recogniser as a `Recogniser`, built once per device and process. `device` is `cpu`
    (default), `cuda` or `auto` (the GPU when onnxruntime has it, logging the choice); a GPU that cannot be used
    falls back to the CPU with a log line. Raises ImportError when rapidocr is not installed. Only the recogniser
    is loaded: the text detector and angle classifier would be dead weight, and the detector ruins a bar."""
    device = (device or "cpu").strip().lower()
    if device not in ("auto", "cpu", "cuda"):
        log.warning("INBOX_OCR_DEVICE=%r is not auto, cpu or cuda: using cpu", device)
        device = "cpu"
    cached = _READERS.get(device)
    if isinstance(cached, ImportError):
        raise type(cached)(*cached.args)
    if cached is not None:
        return cached
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError as exc:
        _READERS[device] = exc
        raise

    recogniser = RapidOCR(use_text_det=False, use_angle_cls=False).text_recognizer
    provider = _CPU
    if device != "cpu":
        try:
            provider = _on_cuda(recogniser)
        except Exception as exc:  # noqa: BLE001 - any GPU trouble means the CPU, never a lost bar
            level = logging.WARNING if device == "cuda" else logging.INFO
            log.log(level, "data-bar OCR stays on the CPU (%s): %s", device, exc)
    log.info(
        "data-bar OCR: RapidOCR recogniser on %s (INBOX_OCR_DEVICE=%s)",
        provider,
        device,
    )

    def recognise(crops: list) -> list[tuple[str, float]]:
        if not crops:
            return []
        results, _elapsed = recogniser(crops)
        return [(str(text), float(conf)) for text, conf in results]

    _READERS[device] = recognise
    return recognise
