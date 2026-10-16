"""FEI/Thermo SEM metadata (TIFF tag 34682) and the instrument's UK clock (SEM reader spec section 2, tier 1).

A pure function of an in-memory `PIL.Image`: it opens nothing, writes nothing and calls nothing outside
Python's standard library. Tag 34682 holds an INI text written by the instrument software. A value is kept only
when it parses and passes its range; anything else is omitted and noted in `flags`, never guessed and never null.
"""

from __future__ import annotations

import configparser
import math
import re
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

FEI_TAG = 34682
MAX_META_CHARS = 20_000  # a longer tag is not the instrument's text
LONDON = ZoneInfo("Europe/London")  # the instrument clock (spec D5)

# Sanity ranges, inclusive; a value outside is omitted with flags[key] = "out_of_range". The OCR tier imports them.
RANGES: dict[str, tuple[float, float]] = {
    "kv": (0.1, 30),
    "working_distance_mm": (0.1, 50),
    "magnification": (5, 1_000_000),
    "spot": (1, 10),
}

# Micrometres per printed length unit (a scale-bar label), shared by the text parser and the bar reader. The key
# stored is `scale_bar_um`, a number, never the printed label.
UM_PER: dict[str, float] = {
    "nm": 0.001,
    "um": 1.0,
    "\u00b5m": 1.0,  # micro sign
    "\u03bcm": 1.0,  # Greek mu
    "mm": 1000.0,
}

_CREATED_FORMAT = "%d.%m.%Y %H:%M:%S"  # [PrivateFei] TimeOfCreation
_USER_DATE_FORMAT = "%m/%d/%Y"  # [User] Date
_USER_TIME = re.compile(r"\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?[Mm]?\s*$")


def _naive(text: str, fmt: str) -> datetime | None:
    try:
        return datetime.strptime(text.strip(), fmt)
    except ValueError:
        return None


def _to_london(naive: datetime) -> datetime | None:
    """`naive` read as Europe/London. The repeated autumn hour takes the first occurrence (fold=0); a local
    time that does not exist (the skipped spring hour) gives None."""
    dt = datetime(*naive.timetuple()[:6], tzinfo=LONDON, fold=0)
    back = dt.astimezone(UTC).astimezone(
        LONDON
    )  # a skipped local time comes back an hour later
    return dt if back.timetuple()[:6] == naive.timetuple()[:6] else None


def parse_london_time(text: str) -> datetime | None:
    """`DD.MM.YYYY HH:MM:SS` (the `[PrivateFei] TimeOfCreation` format) as Europe/London time, or None when
    it is not a time or the local time does not exist."""
    naive = _naive(text, _CREATED_FORMAT)
    return None if naive is None else _to_london(naive)


def _user_naive(date: str, time: str) -> datetime | None:
    """`[User] Date` (MM/DD/YYYY) and `Time` (hh:mm:ss AM/PM) as a naive local time. Parsed by hand: strptime's
    %p follows the locale."""
    day = _naive(date, _USER_DATE_FORMAT)
    m = _USER_TIME.match(time)
    if day is None or m is None:
        return None
    hour, minute, second = int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)
    meridiem = m.group(4)
    if meridiem:
        if not 1 <= hour <= 12:
            return None
        hour = hour % 12 + (12 if meridiem.lower() == "p" else 0)
    try:
        return datetime(day.year, day.month, day.day, hour, minute, second)
    except ValueError:
        return None


def _read_ini(img) -> dict[str, configparser.SectionProxy] | None:
    """The tag's sections (lower-cased names; option names are lower-cased by the parser), or None when the
    tag is absent, not text, too long or not INI."""
    try:
        tags = img.tag_v2  # TIFF only
    except AttributeError:
        return None
    val = tags.get(FEI_TAG)
    if isinstance(val, bytes):
        val = val.decode("latin-1", "ignore")
    if not isinstance(val, str) or len(val) > MAX_META_CHARS:
        return None
    cp = configparser.ConfigParser(strict=False, interpolation=None)
    try:
        cp.read_string(val.rstrip("\x00"))
    except configparser.Error:
        return None
    return {name.lower(): cp[name] for name in cp.sections()}


class _Reader:
    """Numbers out of the INI, with a note for each one that is present but unusable."""

    def __init__(self, sections, flags: dict[str, str]):
        self.sections, self.flags = sections, flags

    def _raw(self, section: str, key: str) -> str | None:
        sec = self.sections.get(section)
        val = sec.get(key) if sec is not None else None
        return None if val is None else val.strip()

    def text(self, section: str, key: str) -> str | None:
        return self._raw(section, key) or None

    def number(self, section: str, key: str, flag: str) -> float | None:
        """A finite float, or None. An unreadable (or empty) value is noted under `flag`; a missing key is not."""
        raw = self._raw(section, key)
        if raw is None:
            return None
        try:
            val = float(raw)
        except ValueError:
            val = math.nan
        if not math.isfinite(val):
            self.flags[flag] = "not_a_number"
            return None
        return val

    def ranged(self, name: str, value: float | None) -> float | None:
        """`value` if it is inside RANGES[name], else None with a note."""
        if value is None:
            return None
        lo, hi = RANGES[name]
        if not lo <= value <= hi:
            self.flags[name] = "out_of_range"
            return None
        return value


def fei_metadata(img) -> dict | None:
    """The imaging settings a FEI/Thermo TIFF states, or None when it is not one.

    None when tag 34682 is absent, not text, longer than 20,000 characters, not INI, or lacks `[System]
    Type=SEM` and a `[PrivateFei]` section. Otherwise a dict of the keys the file states (numeric, unit in the
    key, absent when unknown), plus `bar_height_px` when `DatabarHeight` exists, `sources` (every key
    `metadata`, `magnification` `derived`) and `flags` (why a present value was left out). `acquired_at` is an
    aware `datetime`; the caller turns it into ISO text.
    """
    sections = _read_ini(img)
    if sections is None or "privatefei" not in sections:
        return None
    sys_sec = sections.get("system")
    if sys_sec is None or sys_sec.get("type", "").strip().upper() != "SEM":
        return None

    flags: dict[str, str] = {}
    rd = _Reader(sections, flags)
    out: dict = {}

    kv = rd.number("beam", "hv", "kv")
    kv = rd.ranged("kv", None if kv is None else round(kv / 1000, 3))
    if kv is not None:
        out["kv"] = kv
    spot = rd.ranged("spot", rd.number("beam", "spot", "spot"))
    if spot is not None:
        out["spot"] = spot
    wd = rd.number("ebeam", "wd", "working_distance_mm")
    wd = rd.ranged("working_distance_mm", None if wd is None else round(wd * 1000, 2))
    if wd is not None:
        out["working_distance_mm"] = wd

    hfw = rd.number("ebeam", "hfw", "hfw_um")
    canvas = rd.number("image", "screenmagcanvasrealwidth", "magnification")
    if hfw is not None and hfw <= 0:
        flags["hfw_um"] = "out_of_range"
    if (
        hfw is None or hfw <= 0
    ):  # no field width: no magnification (and no division by zero)
        flags["magnification"] = "no_hfw"
    else:
        out["hfw_um"] = round(hfw * 1e6, 4)
        if canvas is None:
            flags.setdefault("magnification", "no_screen_width")
        else:
            mag = rd.ranged("magnification", float(round(canvas / hfw)))
            if mag is not None:
                out["magnification"] = int(mag)

    pixel = rd.number("scan", "pixelwidth", "pixel_size_nm")
    if pixel is not None:
        if pixel > 0:
            out["pixel_size_nm"] = round(pixel * 1e9, 4)
        else:
            flags["pixel_size_nm"] = "out_of_range"

    for key, section, name in (
        ("detector", "detectors", "name"),
        ("mode", "detectors", "mode"),
    ):
        val = rd.text(section, name)
        if val is not None:
            out[key] = val
    system_type, dnumber = rd.text("system", "systemtype"), rd.text("system", "dnumber")
    if system_type and dnumber:
        out["instrument"] = f"{system_type} ({dnumber})"
    elif system_type or dnumber:
        out["instrument"] = system_type or dnumber

    created = rd.text("privatefei", "timeofcreation")
    if created is not None:
        naive = _naive(created, _CREATED_FORMAT)
    else:  # no TimeOfCreation: fall back to [User] Date and Time
        date, time = rd.text("user", "date"), rd.text("user", "time")
        created = (date or "") + (" " + time if time else "") or None
        naive = _user_naive(date, time) if date and time else None
    if created is not None:
        when = None if naive is None else _to_london(naive)
        if when is not None:
            out["acquired_at"] = when
        else:
            flags["acquired_at"] = (
                "unparseable" if naive is None else "invalid_local_time"
            )

    sources = {k: "metadata" for k in out}
    if "magnification" in out:
        sources["magnification"] = "derived"
    bar = rd.text("privatefei", "databarheight")
    if bar is not None and bar.isdigit() and int(bar) > 0:
        out["bar_height_px"] = int(bar)
    out["sources"] = sources
    out["flags"] = flags
    return out
