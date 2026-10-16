"""The FEI profile, positive and negative evidence, and the demoted JEOL bar-only claim (SEM reader spec section 1).

Every image here is SYNTHETIC, generated in the test; the metadata text holds only values. No research image is
ever committed.
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

PIL = pytest.importorskip("PIL")
from inbox_crawler import classify_sem as csem  # noqa: E402
from inbox_crawler import kinds  # noqa: E402
from PIL import Image, ImageDraw, TiffImagePlugin  # noqa: E402
from test_inbox_crawler_classify import _font, make_sem  # noqa: E402
from test_inbox_crawler_sem_meta import FEI_TEXT  # noqa: E402

W, IMG_H, BAR_H = (
    1024,
    884,
    59,
)  # the real FEI layout: an 884-row image plus a 59-row bar
BAR_TEXT = ("20.00 kV", "ETD", "9.2 mm", "3 000 x", "SE", "3.0", "40 µm")


def make_fei_image(
    *,
    white=255,
    step=150,
    divider_w=1,
    mid_row=True,
    bar=True,
    w=W,
    img_h=IMG_H,
    bar_h=BAR_H,
):
    """A noisy grey 'micrograph' with an FEI-like bar: a white top row, white vertical dividers every `step`
    pixels, a full-width white row across the middle (as the real bars have: the JEOL finder rejects any bar
    with a bright row), text in the cells. `white` lowers every white (a contrast-edited export has about 207)."""
    h = img_h + (bar_h if bar else 0)
    img = Image.effect_noise((w, h), 30).convert("L")
    if not bar:
        return img
    y0 = img_h
    d = ImageDraw.Draw(img)
    d.rectangle((0, y0, w, h), fill=0)
    d.rectangle((0, y0, w, y0), fill=white)  # the full-width top row
    if mid_row:
        d.line((0, y0 + (bar_h + 1) // 2, w, y0 + (bar_h + 1) // 2), fill=white)
    for x in range(step, w, step):
        d.rectangle((x, y0, x + divider_w - 1, h), fill=white)
    f = _font(max(10, bar_h // 4))
    for i, text in enumerate(BAR_TEXT):
        d.text(
            (8 + i * step, y0 + 6 + (i % 2) * (bar_h // 2)), text, fill=white, font=f
        )
    return img


def make_fei_tiff(meta=True, model=None, make=None, text=FEI_TEXT, **kw) -> io.BytesIO:
    """make_fei_image as a TIFF, optionally with tag 34682 (the FEI text) and tags 272 (Model), 271 (Make)."""
    ifd = TiffImagePlugin.ImageFileDirectory_v2()
    if meta:
        ifd[34682] = text
    if model is not None:
        ifd[272] = model
    if make is not None:
        ifd[271] = make
    b = io.BytesIO()
    make_fei_image(**kw).save(b, format="TIFF", tiffinfo=ifd)
    b.seek(0)
    return b


def classify(fh, **kw):
    return csem.classify_image(fh, **kw)


# ---- positive evidence: FEI metadata ----------------------------------------------------------


def test_fei_metadata_tiff_is_sem_image():
    c = classify(make_fei_tiff())
    assert c.kind == "sem_image", c.reason
    assert c.confidence == pytest.approx(0.95)
    assert c.extracted["kv"] == 2.0
    assert c.extracted["sources"]["magnification"] == "derived"
    assert c.classified_by == "sem-2"


def test_the_extracted_values_are_plain_json_with_iso_time():
    e = classify(make_fei_tiff()).extracted
    assert e["acquired_at"] == "2025-08-07T14:59:45+01:00"
    assert "bar_height_px" not in e
    assert json.loads(json.dumps(e)) == e


def test_fei_metadata_without_bar_is_still_sem_image():
    c = classify(make_fei_tiff(bar=False))
    assert c.kind == "sem_image"
    assert c.confidence == pytest.approx(0.9)
    assert c.extracted["magnification"] == 40


def test_databar_height_places_a_bar_whose_top_row_is_dim():
    # every white is only 40: no row mean passes 150, so find_fei_bar finds nothing, and DatabarHeight=59 places the bar
    img = Image.open(make_fei_tiff(white=40))
    assert csem.find_fei_bar(csem._gray(img)) is None
    c = classify(make_fei_tiff(white=40))
    assert c.kind == "sem_image" and c.confidence == pytest.approx(0.95)


def test_garbage_tag_is_not_a_claim():
    c = classify(make_fei_tiff(text="not ini text " * 2000))
    assert c.kind == "image" and c.extracted == {}


def test_an_instrument_without_private_fei_is_not_a_claim():
    c = classify(make_fei_tiff(text="[System]\nType=SEM\n[Beam]\nHV=2000\n"))
    assert c.kind == "image"


# ---- negative evidence --------------------------------------------------------------------------


def test_optical_microscope_tiff_stays_image():
    fh = make_fei_tiff(
        meta=False, model="Microscope x20", make="DirectShow input device"
    )
    c = classify(fh)
    assert c.kind == "image"
    assert "optical" in c.reason
    assert c.confidence is None and c.extracted == {}


def test_a_negative_caps_even_a_claim_with_fei_metadata():
    c = classify(make_fei_tiff(model="Microscope x5"))
    assert c.kind == "image" and "optical" in c.reason


@pytest.mark.parametrize(
    "model", ["Microscope x5", "microscope X10", "Microscope x20 "]
)
def test_microscope_model_is_a_negative_signal(model):
    img = Image.open(make_fei_tiff(meta=False, model=model))
    assert "optical" in csem.negative_signal(img)


@pytest.mark.parametrize("tag", ["make", "model"])
def test_directshow_device_stays_image(tag):
    kw = {tag: "DirectShow input device"}
    c = classify(make_fei_tiff(**kw))
    assert c.kind == "image"
    assert "DirectShow" in c.reason
    assert "DirectShow" in csem.negative_signal(Image.open(make_fei_tiff(**kw)))


@pytest.mark.parametrize("model", [None, "Inspect F", "Microscope", "Microscope xray"])
def test_other_models_are_not_negative(model):
    assert csem.negative_signal(Image.open(make_fei_tiff(model=model))) is None


def test_a_non_tiff_has_no_negative_signal():
    b = io.BytesIO()
    Image.new("L", (64, 64)).save(b, "PNG")
    b.seek(0)
    assert csem.negative_signal(Image.open(b)) is None


def test_the_negative_cap_is_055():
    assert csem.NEGATIVE_CAP == 0.55 < csem.SEM_MIN_CONFIDENCE


# ---- a bar alone is not evidence ------------------------------------------------------------------


def test_bar_only_is_image_even_with_divider_rows():
    c = classify(make_fei_tiff(meta=False), ocr=False)
    assert c.kind == "image"
    assert c.reason == "data-bar-like strip, no SEM evidence"
    assert c.confidence is None and c.extracted == {}


def test_a_plain_picture_has_no_bar_reason():
    c = classify(make_fei_tiff(meta=False, bar=False))
    assert c.kind == "image" and c.reason == "no SEM profile matched"


def test_jeol_bar_only_no_longer_claims():
    b = io.BytesIO()
    make_sem().save(b, "TIFF")
    b.seek(0)
    c = classify(b)
    assert c.kind == "image" and c.confidence is None and c.extracted == {}
    assert c.reason == "data-bar-like strip, no SEM evidence"


def test_jeol_metadata_still_claims():
    b = io.BytesIO()
    make_sem().save(b, "TIFF", description="JEOL JSM-7800F")
    b.seek(0)
    c = classify(b)
    assert c.kind == "sem_image"
    assert c.extracted["instrument"] == "JEOL"
    assert c.classified_by == "sem-2"


# ---- finding the bar --------------------------------------------------------------------------------


def gray_of(**kw):
    return csem._gray(make_fei_image(**kw))


def test_find_fei_bar_accepts_divider_rows():
    gray = gray_of()
    assert csem.find_fei_bar(gray) == IMG_H
    assert csem.find_data_bar(gray) is None  # the JEOL finder rejects any bright row


def test_the_bar_is_found_at_twice_the_size():
    gray = gray_of(w=2048, img_h=1768, bar_h=119, step=300, divider_w=2)
    assert csem.find_fei_bar(gray) == 1768
    assert csem.bar_structure(gray, 1768) == 6


def test_a_bright_picture_is_not_a_bar_body():
    noise = Image.effect_noise((W, 943), 30).convert("L")
    assert csem.bar_structure(noise, IMG_H) is None


def test_bar_structure_counts_dividers():
    assert csem.bar_structure(gray_of(), IMG_H) == 6  # x = 150, 300, ..., 900


def test_a_wide_divider_counts_once():
    assert csem.bar_structure(gray_of(divider_w=3), IMG_H) == 6


@pytest.mark.parametrize("mid_row", [True, False])
def test_a_full_width_middle_row_is_not_a_divider(mid_row):
    gray = gray_of(mid_row=mid_row)
    assert csem.find_fei_bar(gray) == IMG_H
    assert csem.bar_structure(gray, IMG_H) == 6


def test_contrast_edited_bar_is_found():
    plain, edited = gray_of(), gray_of(white=207)
    assert csem.find_fei_bar(edited) == csem.find_fei_bar(plain) == IMG_H
    assert csem.bar_structure(edited, IMG_H) == csem.bar_structure(plain, IMG_H) == 6


def test_fewer_than_three_dividers_is_no_structure():
    assert csem.bar_structure(gray_of(step=400), IMG_H) is None  # x = 400, 800


@pytest.mark.parametrize(
    "img",
    [
        Image.effect_noise((W, 943), 30).convert("L"),
        Image.new("L", (W, 943), 0),
        Image.new("L", (W, 943), 255),
        Image.linear_gradient("L").resize((W, 943)),
        Image.new("L", (32, 32), 0),
    ],
    ids=["noise", "black", "white", "gradient", "tiny"],
)
def test_find_fei_bar_ignores_pictures_without_a_bar(img):
    assert csem.find_fei_bar(img) is None


# ---- the version stamp --------------------------------------------------------------------------------


def test_classified_by_on_plain_image():
    b = io.BytesIO()
    Image.effect_noise((200, 200), 30).convert("L").save(b, "PNG")
    c = classify(io.BytesIO(b.getvalue()))
    assert c.kind == "image" and c.classified_by == "sem-2" == csem.CLASSIFIER_VERSION


def test_classified_by_on_images_that_were_not_decoded():
    assert classify(io.BytesIO(b"not an image")).classified_by == "sem-2"


def test_classified_by_defaults_to_empty_for_a_name_only_kind():
    assert kinds.kind_by_name("x.tif").classified_by == ""
    assert kinds.Classification("sem_image", 0.9, {"kv": 15.0}).classified_by == ""


def test_the_default_profiles_are_jeol_then_fei():
    assert [p.name for p in csem.PROFILES] == ["JEOL", "FEI"]
