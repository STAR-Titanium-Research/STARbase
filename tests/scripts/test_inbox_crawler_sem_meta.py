"""FEI/Thermo TIFF metadata (tag 34682) and the instrument's UK clock (SEM reader spec section 2, tier 1).

The metadata text below holds only the values of a real sample (Isaac_004); no research image is committed.
Images are synthetic, generated here.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

PIL = pytest.importorskip("PIL")
from inbox_crawler import sem_meta  # noqa: E402
from PIL import Image, TiffImagePlugin  # noqa: E402

FEI_TEXT = """[System]
Type=SEM
SystemType=Inspect F
Dnumber=9923499

[Beam]
HV=2000
Spot=3.5

[EBeam]
HFW=0.00745157
WD=0.0159235

[Scan]
PixelWidth=7.27692e-006

[Image]
ScreenMagCanvasRealWidth=0.29840

[Detectors]
Name=ETD
Mode=SE

[PrivateFei]
DatabarHeight=59
TimeOfCreation=07.08.2025 14:59:45
"""


def tiff_with_tag(text, *, size=(64, 64)):
    """A small synthetic TIFF whose tag 34682 holds `text`; returns the re-opened image."""
    ifd = TiffImagePlugin.ImageFileDirectory_v2()
    if text is not None:
        ifd[34682] = text
    buf = io.BytesIO()
    Image.new("L", size, 90).save(buf, format="TIFF", tiffinfo=ifd)
    buf.seek(0)
    return Image.open(buf)


def meta(text):
    return sem_meta.fei_metadata(tiff_with_tag(text))


# ---- the real sample's values ----------------------------------------------------------------


def test_fei_metadata_reads_every_field():
    m = meta(FEI_TEXT)
    assert m["kv"] == 2.0
    assert m["spot"] == 3.5
    assert m["working_distance_mm"] == 15.92
    assert m["magnification"] == 40
    assert m["hfw_um"] == pytest.approx(7451.57)
    assert m["pixel_size_nm"] == pytest.approx(7276.92)
    assert m["detector"] == "ETD"
    assert m["mode"] == "SE"
    assert m["instrument"] == "Inspect F (9923499)"
    assert m["acquired_at"].isoformat() == "2025-08-07T14:59:45+01:00"
    assert m["bar_height_px"] == 59
    assert m["sources"]["magnification"] == "derived"
    assert m["flags"] == {}


def test_every_source_is_metadata_but_the_derived_magnification():
    m = meta(FEI_TEXT)
    keys = set(m) - {"sources", "flags", "bar_height_px"}
    assert set(m["sources"]) == keys
    assert {k: v for k, v in m["sources"].items() if v != "metadata"} == {
        "magnification": "derived"
    }


def test_the_ranges_are_published_for_the_ocr_tier():
    assert sem_meta.RANGES == {
        "kv": (0.1, 30),
        "working_distance_mm": (0.1, 50),
        "magnification": (5, 1_000_000),
        "spot": (1, 10),
    }


def test_no_value_is_ever_null():
    text = FEI_TEXT.replace("HV=2000", "HV=0")
    assert None not in meta(text).values()


# ---- UK time -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text,offset",
    [
        ("07.08.2025 14:59:45", "+01:00"),  # summer
        ("15.01.2026 09:00:00", "+00:00"),  # winter
        ("26.10.2025 01:30:00", "+01:00"),  # the repeated autumn hour: first occurrence
    ],
)
def test_parse_london_time(text, offset):
    dt = sem_meta.parse_london_time(text)
    assert dt.isoformat().endswith(offset)
    assert dt.strftime("%d.%m.%Y %H:%M:%S") == text


def test_the_skipped_spring_hour_does_not_exist():
    assert sem_meta.parse_london_time("30.03.2025 01:30:00") is None


@pytest.mark.parametrize("text", ["", "garbage", "31.02.2025 10:00:00", "2025-08-07"])
def test_parse_london_time_rejects_what_is_not_a_time(text):
    assert sem_meta.parse_london_time(text) is None


def test_the_skipped_hour_is_omitted_with_a_flag():
    m = meta(FEI_TEXT.replace("07.08.2025 14:59:45", "30.03.2025 01:30:00"))
    assert "acquired_at" not in m and "acquired_at" not in m["sources"]
    assert m["flags"]["acquired_at"] == "invalid_local_time"


def test_user_date_and_time_are_the_fallback_for_a_missing_creation_time():
    text = FEI_TEXT.replace("TimeOfCreation=07.08.2025 14:59:45\n", "")
    text += "\n[User]\nDate=08/07/2025\nTime=02:59:45 PM\n"
    m = meta(text)
    assert m["acquired_at"].isoformat() == "2025-08-07T14:59:45+01:00"
    assert m["sources"]["acquired_at"] == "metadata"
    assert m["flags"] == {}


# ---- pathological metadata (no exception, no guess) ---------------------------------------------


def test_zero_hfw_omits_magnification():
    m = meta(FEI_TEXT.replace("HFW=0.00745157", "HFW=0"))
    assert "magnification" not in m and "magnification" not in m["sources"]
    assert m["flags"]["magnification"] == "no_hfw"
    assert "hfw_um" not in m
    assert m["kv"] == 2.0  # everything else still reads


def test_zero_hv_omits_kv():
    m = meta(FEI_TEXT.replace("HV=2000", "HV=0"))
    assert "kv" not in m
    assert m["flags"]["kv"] == "out_of_range"
    assert m["spot"] == 3.5


@pytest.mark.parametrize(
    "old,new,key",
    [
        ("HV=2000", "HV=40000", "kv"),
        ("WD=0.0159235", "WD=0.2", "working_distance_mm"),
        ("WD=0.0159235", "WD=0", "working_distance_mm"),
        ("Spot=3.5", "Spot=11", "spot"),
        ("Spot=3.5", "Spot=0.5", "spot"),
        (
            "ScreenMagCanvasRealWidth=0.29840",
            "ScreenMagCanvasRealWidth=10000",
            "magnification",
        ),
    ],
)
def test_out_of_range_values_are_omitted_with_a_flag(old, new, key):
    m = meta(FEI_TEXT.replace(old, new))
    assert key not in m and key not in m["sources"]
    assert m["flags"][key] == "out_of_range"


@pytest.mark.parametrize("bad", ["abc", "nan", "inf", ""])
def test_a_non_number_is_omitted_with_a_flag(bad):
    m = meta(FEI_TEXT.replace("HV=2000", f"HV={bad}"))
    assert "kv" not in m
    assert m["flags"]["kv"] == "not_a_number"


def test_bad_date_omits_acquired_at():
    m = meta(FEI_TEXT.replace("07.08.2025 14:59:45", "garbage"))
    assert "acquired_at" not in m
    assert m["flags"]["acquired_at"] == "unparseable"
    assert m["kv"] == 2.0 and m["instrument"] == "Inspect F (9923499)"


def test_a_line_without_equals_keeps_what_parsed_and_flags_the_metadata():
    """M1 (spec section 8): one bad line in a real tag (configparser raises ParsingError after it has read the
    rest) costs that line, not the whole tag: the fields before and after it are kept and `metadata_error` says so."""
    text = FEI_TEXT.replace(
        "[Beam]\nHV=2000", "[Beam]\nthis line has no equals sign\nHV=2000"
    )
    text = text.replace(
        "[Detectors]\nName=ETD", "[Detectors]\nanother stray line\nName=ETD"
    )
    m = meta(text)
    assert m is not None
    assert m["kv"] == 2.0 and m["spot"] == 3.5  # the section with the bad line is kept
    assert m["detector"] == "ETD" and m["mode"] == "SE"
    assert m["magnification"] == 40 and m["acquired_at"].year == 2025
    assert m["flags"]["metadata_error"] == "unparseable_lines"
    assert m["sources"]["kv"] == "metadata"


def test_a_clean_tag_has_no_metadata_error_flag():
    assert "metadata_error" not in meta(FEI_TEXT)["flags"]


def test_garbage_tag_is_not_a_claim():
    assert meta("this is not ini text, at all. " * 900) is None  # 25,000+ characters
    assert meta("not ini text") is None


def test_an_oversized_but_valid_tag_is_not_a_claim():
    assert meta(FEI_TEXT + "; " + "x" * 20_000 + "\n") is None


def test_missing_private_fei_is_not_a_claim():
    text = FEI_TEXT.split("[PrivateFei]")[0]
    assert meta(text) is None


@pytest.mark.parametrize("type_line", ["Type=TEM", "Type=", "SystemType=Inspect F"])
def test_a_system_that_is_not_an_sem_is_not_a_claim(type_line):
    text = FEI_TEXT.replace("Type=SEM", type_line, 1)
    assert meta(text) is None


def test_no_tag_is_not_a_claim():
    assert meta(None) is None


def test_a_non_tiff_has_no_metadata():
    buf = io.BytesIO()
    Image.new("L", (64, 64), 0).save(buf, format="PNG")
    buf.seek(0)
    assert sem_meta.fei_metadata(Image.open(buf)) is None


def test_missing_optional_sections_still_give_a_claim():
    m = meta("[System]\nType=SEM\n[PrivateFei]\n")
    assert m["sources"] == {} and "bar_height_px" not in m
