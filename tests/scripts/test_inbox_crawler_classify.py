"""Classification of found files (spec section 7): surface scans by extension, SEM images by a profile.

Every image here is SYNTHETIC, generated in the test. No research image is ever committed.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

PIL = pytest.importorskip("PIL")
from inbox_crawler import classify_scan as cscan  # noqa: E402
from inbox_crawler import classify_sem as csem  # noqa: E402
from inbox_crawler import kinds  # noqa: E402
from PIL import Image, ImageDraw, ImageFont, PngImagePlugin  # noqa: E402

# ---- synthetic fixtures ------------------------------------------------------------------

BAR_TEXT = "15.0kV x5,000 5um WD 10.0mm"


def _font(px):
    try:
        return ImageFont.load_default(size=px)
    except TypeError:  # an old Pillow: the fixed bitmap font
        return ImageFont.load_default()


def make_sem(
    w=1280,
    h=960,
    bar_frac=0.09,
    text=True,
    line=True,
    bar=True,
    above=None,
    bar_at_top=False,
):
    """A grey noisy 'micrograph' with a black data bar (white text, a scale-bar line) along the bottom."""
    img = Image.effect_noise((w, h), 30).convert("L")
    if above is not None:  # a darker or brighter image area
        img = img.point(lambda v: max(0, min(255, v - 128 + above)))
    if bar:
        bar_h = int(h * bar_frac)
        y0 = 0 if bar_at_top else h - bar_h
        d = ImageDraw.Draw(img)
        d.rectangle((0, y0, w, y0 + bar_h), fill=0)
        if text:
            f = _font(max(10, int(bar_h * 0.4)))
            for i, x in enumerate((20, 360, 700, 960)):
                d.text(
                    (x, y0 + 6 + (i % 2) * int(bar_h * 0.45)),
                    BAR_TEXT[i * 6 : i * 6 + 14],
                    fill=255,
                    font=f,
                )
        if line:
            ly = y0 + bar_h // 2
            d.line((w - 330, ly, w - 200, ly), fill=255, width=3)
    return img


def encode(img, fmt="TIFF", **kw):
    b = io.BytesIO()
    img.save(b, fmt, **kw)
    b.seek(0)
    return b


def classify(img, fmt="TIFF", **kw):
    ck = {k: kw.pop(k) for k in ("ocr", "profiles", "ocr_func") if k in kw}
    return csem.classify_image(encode(img, fmt, **kw), **ck)


JEOL_TEXT = "JEOL JSM-7800F"


def encode_jeol(img, fmt="TIFF"):
    """A picture whose metadata names JEOL: the positive evidence a bar alone cannot give (TIFF description,
    or a PNG text chunk)."""
    if fmt == "PNG":
        info = PngImagePlugin.PngInfo()
        info.add_text("Description", JEOL_TEXT)
        return encode(img, fmt, pnginfo=info)
    return encode(img, fmt, description=JEOL_TEXT)


def classify_jeol(img, fmt="TIFF", **ck):
    return csem.classify_image(encode_jeol(img, fmt), **ck)


# ---- surface scans -----------------------------------------------------------------------


@pytest.mark.parametrize("name", ["scan.al3d", "SCAN.AL3D", "a b/c.Al3d"])
def test_an_al3d_file_is_a_surface_scan_by_extension(name):
    c = cscan.classify_scan(name)
    assert (c.kind, c.confidence, c.extracted) == ("surface_scan", 1.0, {})


@pytest.mark.parametrize("name", ["a.tif", "a.al3d.txt", "al3d", "a.pdf"])
def test_other_names_are_not_surface_scans(name):
    assert cscan.classify_scan(name) is None


def test_the_extension_list_is_configurable():
    assert cscan.classify_scan("a.xyz", extensions=(".xyz",)).kind == "surface_scan"
    assert cscan.classify_scan("a.al3d", extensions=(".xyz",)) is None


# ---- kinds by name -----------------------------------------------------------------------


@pytest.mark.parametrize("ext", [".pdf", ".docx", ".xlsx", ".csv", ".txt", ".pptx"])
def test_documents_are_documents(ext):
    c = kinds.kind_by_name("x" + ext)
    assert (c.kind, c.confidence, c.extracted) == ("document", None, {})


@pytest.mark.parametrize("ext", [".mat", ".m", ".nef", ".h5", ".dat", ""])
def test_everything_else_is_other(ext):
    assert kinds.kind_by_name("x" + ext).kind == "other"


@pytest.mark.parametrize("ext", [".tif", ".TIFF", ".jpg", ".jpeg", ".png", ".bmp"])
def test_an_image_by_name_is_just_an_image(ext):
    assert kinds.kind_by_name("x" + ext).kind == "image"


def test_al3d_by_name_is_a_surface_scan():
    assert kinds.kind_by_name("x.al3d").kind == "surface_scan"


# ---- the JEOL profile on synthetic data bars ---------------------------------------------


@pytest.mark.parametrize("fmt", ["TIFF", "PNG", "BMP", "JPEG"])
def test_a_jeol_like_data_bar_alone_is_no_longer_a_sem_image(fmt):
    c = classify(make_sem(), fmt)
    assert c.kind == "image", c.reason
    assert c.confidence is None and c.extracted == {}
    assert c.reason == "data-bar-like strip, no SEM evidence"


@pytest.mark.parametrize("fmt", ["TIFF", "PNG"])
def test_a_jeol_like_data_bar_with_jeol_metadata_makes_a_sem_image(fmt):
    c = classify_jeol(make_sem(), fmt)
    assert c.kind == "sem_image", c.reason
    assert c.confidence >= 0.9


def test_nothing_is_extracted_that_was_not_read():
    c = classify(make_sem())
    assert c.extracted == {}  # no metadata, OCR off: not even "instrument"
    assert classify_jeol(make_sem()).extracted == {
        "instrument": "JEOL"
    }  # only what the text says


def test_a_bar_without_a_scale_line_is_a_weaker_sem_guess():
    c = classify_jeol(make_sem(line=False))
    assert c.kind == "sem_image" and c.confidence == pytest.approx(0.7)


def bar_was_found(c):
    """With JEOL metadata a picture is a sem_image either way; only a found bar says "data bar with text"."""
    return c.kind == "sem_image" and c.reason.startswith("data bar with text")


def test_a_bar_works_on_a_large_and_on_a_small_image():
    assert bar_was_found(classify_jeol(make_sem(w=5120, h=3840)))
    assert bar_was_found(classify_jeol(make_sem(w=640, h=480)))


def test_a_dark_micrograph_above_the_bar_still_finds_the_bar():
    assert bar_was_found(classify_jeol(make_sem(above=45)))


@pytest.mark.parametrize(
    "img",
    [
        make_sem(bar=False),  # a plain noisy picture
        make_sem(text=False, line=False),  # a black strip with nothing in it
        make_sem(text=False),  # a black strip with only a line
        make_sem(bar_at_top=True),  # the bar is on the wrong edge
        Image.new("L", (1280, 960), 0),  # all black
        Image.new("L", (1280, 960), 255),  # all white
        Image.linear_gradient("L").resize((1280, 960)),  # a smooth gradient
        Image.new("L", (32, 32), 0),  # too small to judge
    ],
    ids=[
        "noise",
        "empty-strip",
        "line-only",
        "top-bar",
        "black",
        "white",
        "gradient",
        "tiny",
    ],
)
def test_pictures_without_a_data_bar_stay_plain_images(img):
    c = classify(img)
    assert c.kind == "image"
    assert c.confidence is None and c.extracted == {}


def test_a_white_page_of_text_is_not_a_sem_image():
    img = Image.new("L", (1280, 960), 255)
    d = ImageDraw.Draw(img)
    f = _font(20)
    for y in range(20, 940, 30):
        d.text((20, y), "Some lab notes about the sample " * 3, fill=0, font=f)
    assert classify(img).kind == "image"


def test_a_colour_image_works():
    c = classify_jeol(make_sem().convert("RGB"), "PNG")
    assert bar_was_found(c)


def test_a_corrupt_file_is_an_image_not_an_error():
    c = csem.classify_image(io.BytesIO(b"not an image at all"))
    assert c.kind == "image" and c.confidence is None
    assert "not decoded" in c.reason


def test_the_classifier_takes_a_handle_never_a_path(tmp_path):
    with pytest.raises(TypeError):
        csem.classify_image(str(tmp_path / "a.tif"))
    with pytest.raises(TypeError):
        csem.classify_image(tmp_path / "a.tif")


# ---- embedded metadata ---------------------------------------------------------------------


def tiff_with_description(img, text):
    b = io.BytesIO()
    img.save(b, "TIFF", description=text)
    b.seek(0)
    return b


def test_metadata_that_is_present_is_read():
    fh = tiff_with_description(make_sem(), "JEOL JSM-7800F  AccV 15.0kV  x5,000")
    c = csem.classify_image(fh)
    assert c.kind == "sem_image"
    assert c.extracted == {"instrument": "JEOL", "kv": 15.0, "magnification": 5000}
    assert c.confidence == pytest.approx(1.0)


def test_jeol_metadata_alone_is_a_sem_guess_but_only_reads_what_it_has():
    fh = tiff_with_description(make_sem(bar=False), "JEOL JSM-7800F")
    c = csem.classify_image(fh)
    assert c.kind == "sem_image" and c.confidence == pytest.approx(0.65)
    assert c.extracted == {"instrument": "JEOL"}


def test_metadata_from_another_instrument_does_not_claim_jeol():
    fh = tiff_with_description(make_sem(bar=False), "Nikon D90 15kV")
    assert csem.classify_image(fh).kind == "image"


# ---- OCR: off unless asked ---------------------------------------------------------------


def boom(_img):  # an OCR that must not be called
    raise AssertionError("OCR ran while switched off")


def test_ocr_is_off_by_default():
    c = classify_jeol(make_sem(), ocr_func=boom)
    assert c.kind == "sem_image" and c.extracted == {"instrument": "JEOL"}


def test_ocr_text_is_parsed_when_switched_on():
    seen = {}

    def fake(bar):
        seen["size"] = bar.size
        return "JSM-7800F 15.0kV x5,000 5µm WD 10.0mm"

    c = classify_jeol(make_sem(), ocr=True, ocr_func=fake)
    assert c.extracted == {
        "instrument": "JEOL",
        "kv": 15.0,
        "magnification": 5000,
        "working_distance_mm": 10.0,
        "scale_bar_um": 5.0,
    }
    assert seen["size"][1] < 960 * 0.2  # it was given the bar, not the picture


def test_a_failing_ocr_keeps_the_tag_and_invents_nothing():
    def broken(_bar):
        raise RuntimeError("tesseract missing")

    c = classify_jeol(make_sem(), ocr=True, ocr_func=broken)
    assert c.kind == "sem_image" and c.extracted == {"instrument": "JEOL"}


def test_ocr_without_the_package_installed_keeps_the_tag(monkeypatch):
    # INBOX_OCR=1 with no rapidocr in the image: the JEOL tag survives, and nothing is read
    monkeypatch.setitem(
        sys.modules, "rapidocr_onnxruntime", None
    )  # import raises ImportError
    c = classify_jeol(make_sem(), ocr=True)
    assert c.kind == "sem_image" and c.extracted == {"instrument": "JEOL"}


def test_jeol_ocr_runs_only_with_a_caller_supplied_function():
    # pytesseract was never installed or validated: there is no default text OCR any more
    assert not hasattr(csem, "default_ocr")
    c = classify_jeol(make_sem(), ocr=True)
    assert c.extracted == {"instrument": "JEOL"}


def test_a_bar_only_jeol_strip_is_not_worth_ocr():
    # capped below the claim threshold without JEOL metadata, so reading its text would be wasted work
    calls = []

    # boom() would be swallowed by the profile's own try/except, so record the call instead
    def spy(bar):
        calls.append(bar)
        return "15.0kV x5,000"

    c = classify(make_sem(), ocr=True, ocr_func=spy)
    assert c.kind == "image" and calls == []
    assert classify_jeol(make_sem(), ocr=True, ocr_func=spy).kind == "sem_image"
    assert len(calls) == 1  # with JEOL metadata the text is worth reading


@pytest.mark.parametrize(
    "text,expected",
    [
        (
            "15.0kV x5,000 5um WD 10.0mm",
            {
                "kv": 15.0,
                "magnification": 5000,
                "working_distance_mm": 10.0,
                "scale_bar_um": 5.0,
            },
        ),
        (
            "5.0 kV  x 250  100 nm",
            {"kv": 5.0, "magnification": 250, "scale_bar_um": 0.1},
        ),
        ("WD 8.5mm", {"working_distance_mm": 8.5}),
        ("garbage ~~ 1234", {}),
        ("", {}),
    ],
)
def test_parse_text_reads_only_what_is_stated(text, expected):
    assert csem.parse_text(text, scale_bar=True) == expected


def test_the_scale_bar_is_not_taken_from_metadata_text():
    assert "scale_bar_um" not in csem.parse_text("15kV x500 5um")


# ---- tolerant magnification text and the numeric scale bar (SEM reader, D2 and the keys rule) --


@pytest.mark.parametrize(
    "text,mag",
    [
        ("1 200 x", 1200),  # thin space (U+2009)
        ("1\u2009200 x", 1200),
        ("1\u00a0200 x", 1200),  # no-break space
        ("1\u202f200 x", 1200),  # narrow no-break space
        ("40×", 40),
        ("3 000 x", 3000),
        ("3 000×", 3000),
        ("12 000 X", 12000),
        ("20.00 kV | ETD | 9.2 mm | 3 000 x | SE | 3.0 | 40 µm", 3000),
        ("x5,000", 5000),  # the old forms still read
        ("x 250", 250),
        ("mag: 5000", 5000),
        ("5,000x", 5000),
    ],
)
def test_magnification_accepts_spaces_and_either_x(text, mag):
    assert csem.parse_text(text)["magnification"] == mag


@pytest.mark.parametrize(
    "text",
    [
        "1234",
        "3.0",
        "9.2 mm",
        "40 µm",
        "20 kV",
        "5 xyz",
        "2 x 3 mm",  # a size, not a magnification
        "Tilt 0 x",
        "Scan 2 x Integration",
        "Image 1 x Pixel 1024",
        "4 x",  # below the minimum of 5
        "x2,000,000",  # above the maximum of 1,000,000
    ],
)
def test_magnification_is_not_read_from_other_numbers(text):
    assert "magnification" not in csem.parse_text(text)


@pytest.mark.parametrize(
    "text,mag", [("1 200 x", 1200), ("40×", 40), ("5 x", 5), ("x1,000,000", 1000000)]
)
def test_magnification_inside_its_range_is_still_read(text, mag):
    assert csem.parse_text(text)["magnification"] == mag


@pytest.mark.parametrize(
    "text,key",
    [
        ("250 kV", "kv"),
        ("0 kV", "kv"),
        ("WD 0 mm", "working_distance_mm"),
        ("WD 80 mm", "working_distance_mm"),
    ],
)
def test_a_value_outside_its_range_is_omitted_not_null(text, key):
    out = csem.parse_text(text)
    assert key not in out and None not in out.values()


@pytest.mark.parametrize(
    "text,key,val", [("30 kV", "kv", 30.0), ("WD 0.1 mm", "working_distance_mm", 0.1)]
)
def test_range_limits_are_inclusive(text, key, val):
    assert csem.parse_text(text)[key] == val


@pytest.mark.parametrize(
    "text,um",
    [
        ("500 µm", 500.0),
        ("3 mm", 3000.0),
        ("200 nm", 0.2),
        ("100μm", 100.0),  # Greek mu (U+03BC)
        ("100µm", 100.0),  # micro sign (U+00B5)
        ("5um", 5.0),
        ("2.5 µm", 2.5),
    ],
)
def test_the_scale_bar_is_a_number_of_micrometres(text, um):
    out = csem.parse_text(text, scale_bar=True)
    assert out["scale_bar_um"] == um and isinstance(out["scale_bar_um"], float)
    assert "scale_bar" not in out  # the old string key is gone


@pytest.mark.parametrize(
    "text",
    [
        "9" * 20_000,
        "1 " * 10_000,
        "123 456 " * 2_500,
        "1 000 " * 3_000 + "y",
        "1.5" * 6_000,
    ],
)
def test_parse_text_stays_fast_on_a_long_run_of_digits(text):
    import time

    t0 = time.perf_counter()
    csem.parse_text(
        text, scale_bar=True
    )  # a tag is up to 20,000 characters of anything
    assert time.perf_counter() - t0 < 0.5


# ---- pluggable profiles --------------------------------------------------------------------


class FixedProfile:
    def __init__(self, name, conf, extracted=None):
        self.name, self.conf, self.extracted = name, conf, extracted or {}

    def inspect(self, img, ocr, ocr_func, bar_reader=None):
        return csem.ProfileResult(self.conf, self.extracted, self.name)


class BrokenProfile:
    name = "broken"

    def inspect(self, img, ocr, ocr_func, bar_reader=None):
        raise ValueError("bug in a profile")


def test_the_default_profile_list_is_jeol_then_fei():
    assert [p.name for p in csem.PROFILES] == ["JEOL", "FEI"]


def test_another_profile_can_claim_an_image():
    plain = Image.new("L", (200, 200), 100)
    c = classify(plain, profiles=[FixedProfile("Zeiss", 0.8, {"instrument": "Zeiss"})])
    assert (c.kind, c.confidence, c.extracted, c.reason) == (
        "sem_image",
        0.8,
        {"instrument": "Zeiss"},
        "Zeiss",
    )


def test_the_most_confident_profile_wins_and_a_weak_one_does_not_count():
    plain = Image.new("L", (200, 200), 100)
    c = classify(plain, profiles=[FixedProfile("a", 0.7), FixedProfile("b", 0.9)])
    assert c.reason == "b"
    assert classify(plain, profiles=[FixedProfile("a", 0.4)]).kind == "image"


def test_a_broken_profile_does_not_stop_the_others():
    plain = Image.new("L", (200, 200), 100)
    c = classify(plain, profiles=[BrokenProfile(), FixedProfile("ok", 0.9)])
    assert c.kind == "sem_image"
    assert classify(plain, profiles=[BrokenProfile()]).kind == "image"
