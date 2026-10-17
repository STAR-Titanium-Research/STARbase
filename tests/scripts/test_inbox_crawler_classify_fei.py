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


# ---- the data bar read by OCR (SEM reader spec section 2, tier 2) --------------------------------------
#
# The recogniser is a scripted fake (the real one needs rapidocr); the bars are drawn by the sem_bar tests'
# `make_bar`, imported lazily because that module needs numpy and this one does not.


def _kit():
    pytest.importorskip("numpy")
    import test_inbox_crawler_sem_bar as kit

    return kit


def make_cell_image(kit, headers=None, values=None, *, scale_len=None, white=255):
    """A noisy 'micrograph' with a header/value cell bar under it (the bar `make_bar` draws)."""
    headers = kit.HEADERS6 if headers is None else headers
    values = kit.VALUES6 if values is None else values
    bar = kit.make_bar(headers, values, scale_len, w=W, h=BAR_H, white=white)
    img = Image.new("L", (W, IMG_H + BAR_H))
    img.paste(Image.effect_noise((W, IMG_H), 30).convert("L"), (0, 0))
    img.paste(bar, (0, IMG_H))
    return img


def encode_cell(img, fmt="PNG", *, text=None, model=None) -> io.BytesIO:
    ifd = TiffImagePlugin.ImageFileDirectory_v2()
    if text is not None:
        ifd[34682] = text
    if model is not None:
        ifd[272] = model
    b = io.BytesIO()
    if fmt == "TIFF":
        img.save(b, format="TIFF", tiffinfo=ifd)
    else:
        img.save(b, format=fmt)
    b.seek(0)
    return b


def reader_for(kit, headers=None, values=None, conf=0.8):
    return kit.Scripted(
        kit.interleave(
            kit.HEADERS6 if headers is None else headers,
            kit.VALUES6 if values is None else values,
            conf,
        )
    )


def forbidden_reader(_crops):
    raise AssertionError("the bar reader ran")


def test_png_bar_with_two_labels_is_sem_image_when_ocr_on():
    kit = _kit()
    c = classify(
        encode_cell(make_cell_image(kit)), ocr=True, bar_reader=reader_for(kit)
    )
    assert c.kind == "sem_image", c.reason
    assert c.confidence == pytest.approx(0.8)
    assert c.extracted["kv"] == 20.0
    assert c.extracted["sources"]["kv"] == "ocr"
    assert c.extracted["working_distance_mm"] == 10.3
    assert c.extracted["magnification"] == 1200
    assert c.extracted["spot"] == 3.0
    assert c.extracted["detector"] == "ETD" and c.extracted["mode"] == "SE"
    assert set(c.extracted["sources"].values()) == {"ocr"}
    assert c.extracted["flags"] == {
        "check_this": True
    }  # nothing could vouch for a bar alone
    assert c.classified_by == "sem-2"
    assert json.loads(json.dumps(c.extracted)) == c.extracted


def test_png_bar_ocr_off_stays_image():
    kit = _kit()
    c = classify(encode_cell(make_cell_image(kit)), bar_reader=forbidden_reader)
    assert c.kind == "image" and c.extracted == {}
    assert c.reason == "data-bar-like strip, no SEM evidence"


def test_one_label_is_not_enough():
    kit = _kit()
    only_hv = kit.Scripted(
        kit.interleave(["HV", "", "", "", "", ""], kit.VALUES6)
    )  # every other header unreadable
    c = classify(encode_cell(make_cell_image(kit)), ocr=True, bar_reader=only_hv)
    assert c.kind == "image" and c.extracted == {} and c.confidence is None


def test_two_labels_are_enough_even_if_a_value_is_garbage():
    kit = _kit()
    values = ["~~", "", "", "", "", ""]
    got = reader_for(kit, ["HV", "WD", "", "", "", ""], values)
    c = classify(encode_cell(make_cell_image(kit)), ocr=True, bar_reader=got)
    assert c.kind == "sem_image" and c.confidence == pytest.approx(0.8)
    assert "kv" not in c.extracted and c.extracted["flags"]["kv"] == "not_a_number"


def test_the_scale_label_alone_is_not_a_label():
    kit = _kit()
    # one header label (HV) and the scale-bar cell: the scale label is not one of the two labels a claim needs
    headers = ["HV", "", "", "", "", "", "100μm"]
    values = ["20.00 kV", "", "", "", "", "", ""]
    img = make_cell_image(kit, ["x"] * 7, values)
    c = classify(
        encode_cell(img), ocr=True, bar_reader=reader_for(kit, headers, values)
    )
    assert c.kind == "image"


def test_png_bar_checks_the_scale_bar_length():
    kit = _kit()
    headers = kit.HEADERS6 + ["10μm"]
    values = ["20.00 kV", "ETD", "10.3 mm", "3 000 x", "SE", "3.0", ""]
    px = round(10 * 3000 * W / (0.2984 * 1e6))  # a 10 µm bar at 3 000 x
    img = make_cell_image(kit, headers, values, scale_len=px)
    c = classify(
        encode_cell(img), ocr=True, bar_reader=reader_for(kit, headers, values)
    )
    assert c.kind == "sem_image"
    assert c.extracted["scale_bar_um"] == 10.0
    assert c.extracted["magnification"] == 3000
    assert "check_this" not in c.extracted["flags"]
    # the same label over a bar of the wrong length: the label is dropped and noted
    img = make_cell_image(kit, headers, values, scale_len=px // 2)
    c = classify(
        encode_cell(img), ocr=True, bar_reader=reader_for(kit, headers, values)
    )
    assert c.kind == "sem_image"
    assert "scale_bar_um" not in c.extracted and "magnification" not in c.extracted
    assert c.extracted["flags"]["scale_bar_um"] == "length_mismatch"
    assert c.extracted["flags"]["magnification"] == "length_mismatch"


def test_contrast_edited_png_is_read_the_same():
    kit = _kit()
    c = classify(
        encode_cell(make_cell_image(kit, white=207)),
        ocr=True,
        bar_reader=reader_for(kit),
    )
    assert c.kind == "sem_image" and c.extracted["kv"] == 20.0


def test_optical_microscope_with_a_readable_bar_stays_image():
    kit = _kit()
    fh = encode_cell(make_cell_image(kit), "TIFF", model="Microscope x20")
    c = classify(fh, ocr=True, bar_reader=reader_for(kit))
    assert c.kind == "image" and "optical" in c.reason and c.extracted == {}


def test_a_picture_without_a_bar_never_reaches_the_reader():
    c = classify(
        encode_cell(make_fei_image(bar=False), "PNG"),
        ocr=True,
        bar_reader=forbidden_reader,
    )
    assert c.kind == "image"


def test_metadata_wins_over_bar_and_mismatch_is_noted():
    kit = _kit()
    # FEI_TEXT says 2.0 kV, 15.9 mm, spot 3.5, ETD/SE, and a field width that gives 40x
    values = ["20.00 kV", "ETD", "15.9 mm", "40×", "SE", "3.5"]
    c = classify(
        encode_cell(make_cell_image(kit, values=values), "TIFF", text=FEI_TEXT),
        ocr=True,
        bar_reader=reader_for(kit, values=values),
    )
    assert c.kind == "sem_image"
    assert c.confidence == pytest.approx(0.95)  # metadata plus bar structure
    assert c.extracted["kv"] == 2.0 and c.extracted["sources"]["kv"] == "metadata"
    assert c.extracted["flags"]["kv"] == "bar_mismatch"
    # what agrees is not flagged and is not overwritten
    assert c.extracted["working_distance_mm"] == 15.92
    assert c.extracted["magnification"] == 40
    assert c.extracted["spot"] == 3.5
    assert set(c.extracted["flags"]) == {"kv"}


def test_a_bar_that_agrees_with_the_metadata_adds_no_flag():
    kit = _kit()
    values = ["2.00 kV", "ETD", "15.9 mm", "40×", "SE", "3.5"]
    c = classify(
        encode_cell(make_cell_image(kit, values=values), "TIFF", text=FEI_TEXT),
        ocr=True,
        bar_reader=reader_for(kit, values=values),
    )
    assert c.extracted["kv"] == 2.0 and c.extracted["flags"] == {}
    assert set(c.extracted["sources"].values()) <= {"metadata", "derived"}


def test_a_bar_magnification_that_contradicts_the_field_width_is_a_mismatch():
    kit = _kit()
    values = ["2.00 kV", "ETD", "15.9 mm", "200 x", "SE", "3.5"]
    c = classify(
        encode_cell(make_cell_image(kit, values=values), "TIFF", text=FEI_TEXT),
        ocr=True,
        bar_reader=reader_for(kit, values=values),
    )
    assert c.extracted["magnification"] == 40  # the metadata's, derived
    assert c.extracted["sources"]["magnification"] == "derived"
    assert c.extracted["flags"]["magnification"] == "bar_mismatch"


def test_detector_mismatch_is_noted():
    kit = _kit()
    values = ["2.00 kV", "CDEM", "15.9 mm", "40×", "SE", "3.5"]
    c = classify(
        encode_cell(make_cell_image(kit, values=values), "TIFF", text=FEI_TEXT),
        ocr=True,
        bar_reader=reader_for(kit, values=values),
    )
    assert c.extracted["detector"] == "ETD"
    assert c.extracted["flags"]["detector"] == "bar_mismatch"


def test_the_bar_fills_what_the_metadata_does_not_state():
    kit = _kit()
    headers = kit.HEADERS6 + ["10μm"]
    values = ["2.00 kV", "ETD", "15.9 mm", "3 000 x", "SE", "3.5", ""]
    text = FEI_TEXT.replace("HFW=0.00745157", "HFW=0.0000994667")  # 0.2984 / 3 000 x
    px = round(10 * 3000 * W / (0.2984 * 1e6))
    img = make_cell_image(kit, headers, values, scale_len=px)
    c = classify(
        encode_cell(img, "TIFF", text=text),
        ocr=True,
        bar_reader=reader_for(kit, headers, values),
    )
    assert c.extracted["magnification"] == 3000
    assert c.extracted["scale_bar_um"] == 10.0
    assert c.extracted["sources"]["scale_bar_um"] == "ocr"
    assert c.extracted["sources"]["kv"] == "metadata"


def test_metadata_tiff_with_ocr_off_does_not_run_the_reader():
    kit = _kit()
    c = classify(
        encode_cell(make_cell_image(kit), "TIFF", text=FEI_TEXT),
        bar_reader=forbidden_reader,
    )
    assert c.kind == "sem_image" and c.extracted["flags"] == {}


def test_reader_exception_does_not_lose_the_image():
    kit = _kit()

    def broken(_crops):
        raise RuntimeError("onnxruntime exploded")

    tiff = encode_cell(make_cell_image(kit), "TIFF", text=FEI_TEXT)
    c = classify(tiff, ocr=True, bar_reader=broken)
    assert c.kind == "sem_image" and c.extracted["kv"] == 2.0  # still from metadata
    assert c.extracted["flags"] == {}
    c = classify(encode_cell(make_cell_image(kit)), ocr=True, bar_reader=broken)
    assert c.kind == "image" and c.extracted == {}  # no metadata: a plain image


def test_a_recogniser_with_the_wrong_answer_count_reads_nothing():
    kit = _kit()
    c = classify(
        encode_cell(make_cell_image(kit)),
        ocr=True,
        bar_reader=lambda crops: [("HV", 0.9), ("20 kV", 0.9)],
    )
    assert c.kind == "image"


def test_the_default_reader_is_built_from_the_device_variable(monkeypatch):
    kit = _kit()
    from inbox_crawler import sem_bar

    seen = []

    def fake_default(device="cpu"):
        seen.append(device)
        return reader_for(kit)

    monkeypatch.setattr(sem_bar, "default_bar_reader", fake_default)
    monkeypatch.setenv("INBOX_OCR_DEVICE", "auto")
    c = classify(encode_cell(make_cell_image(kit)), ocr=True)
    assert c.kind == "sem_image" and seen == ["auto"]
    monkeypatch.delenv("INBOX_OCR_DEVICE")
    classify(encode_cell(make_cell_image(kit)), ocr=True)
    assert seen == ["auto", "cpu"]


def test_an_explicit_reader_means_no_default_reader(monkeypatch):
    kit = _kit()
    from inbox_crawler import sem_bar

    def boom(device="cpu"):
        raise AssertionError("the default reader was built")

    monkeypatch.setattr(sem_bar, "default_bar_reader", boom)
    c = classify(
        encode_cell(make_cell_image(kit)), ocr=True, bar_reader=reader_for(kit)
    )
    assert c.kind == "sem_image"


def test_ocr_on_without_rapidocr_keeps_the_metadata_image(monkeypatch):
    kit = _kit()
    from inbox_crawler import sem_bar

    monkeypatch.setattr(sem_bar, "_READERS", {})
    monkeypatch.setitem(sys.modules, "rapidocr_onnxruntime", None)  # the import fails
    tiff = encode_cell(make_cell_image(kit), "TIFF", text=FEI_TEXT)
    c = classify(tiff, ocr=True)
    assert c.kind == "sem_image" and c.extracted["kv"] == 2.0
    c = classify(encode_cell(make_cell_image(kit)), ocr=True)
    assert c.kind == "image"


def test_the_default_recogniser_wraps_rapidocr(monkeypatch):
    kit = _kit()
    from inbox_crawler import sem_bar

    built = []

    class FakeRecogniser:
        def __call__(self, crops):
            return [("20.00 kV", 0.91)] * len(crops), 0.01

    class FakeRapidOCR:
        def __init__(self, **kw):
            built.append(kw)
            self.text_recognizer = FakeRecogniser()

    fake_module = type(sys)("rapidocr_onnxruntime")
    fake_module.RapidOCR = FakeRapidOCR
    monkeypatch.setitem(sys.modules, "rapidocr_onnxruntime", fake_module)
    monkeypatch.setattr(sem_bar, "_READERS", {})
    reader = sem_bar.default_bar_reader("cpu")
    assert sem_bar.default_bar_reader("CPU") is reader  # built once per process
    assert len(built) == 1
    assert reader([object(), object()]) == [("20.00 kV", 0.91)] * 2
    assert reader([]) == []
    assert kit  # numpy is there (the module under test imports it)


def test_an_unknown_device_means_cpu(monkeypatch):
    _kit()
    from inbox_crawler import sem_bar

    class FakeRapidOCR:
        def __init__(self, **kw):
            self.text_recognizer = lambda crops: ([], 0)

    fake_module = type(sys)("rapidocr_onnxruntime")
    fake_module.RapidOCR = FakeRapidOCR
    monkeypatch.setitem(sys.modules, "rapidocr_onnxruntime", fake_module)
    monkeypatch.setattr(sem_bar, "_READERS", {})
    assert sem_bar.default_bar_reader("tpu") is sem_bar.default_bar_reader("cpu")


def test_cuda_without_a_gpu_falls_back_to_cpu(monkeypatch):
    _kit()
    from inbox_crawler import sem_bar

    class FakeRapidOCR:
        def __init__(self, **kw):
            self.text_recognizer = lambda crops: ([("x", 0.5)] * len(crops), 0)

    fake_module = type(sys)("rapidocr_onnxruntime")
    fake_module.RapidOCR = FakeRapidOCR
    fake_ort = type(sys)("onnxruntime")
    fake_ort.get_available_providers = lambda: ["CPUExecutionProvider"]
    monkeypatch.setitem(sys.modules, "rapidocr_onnxruntime", fake_module)
    monkeypatch.setitem(sys.modules, "onnxruntime", fake_ort)
    monkeypatch.setattr(sem_bar, "_READERS", {})
    for device in ("cuda", "auto"):
        assert sem_bar.default_bar_reader(device)([1]) == [("x", 0.5)]


# ---- OCR confidence is recorded in extracted (coordinator ruling R10), never a threshold --------------------


def test_a_bar_only_claim_carries_the_ocr_confidence():
    kit = _kit()
    got = kit.Scripted(
        [
            ("HV", 0.9),
            ("20.00 kV", 0.734),
            ("det", 0.9),
            ("ETD", 0.6),
            ("WD", 0.9),
            ("10.3 mm", 0.605),
            ("mag", 0.9),
            ("1 200 x", 0.99),
            ("mode", 0.9),
            ("SE", 0.5),
            ("spot", 0.9),
            ("3.0", 0.999),
        ]
    )
    c = classify(encode_cell(make_cell_image(kit)), ocr=True, bar_reader=got)
    assert c.kind == "sem_image"
    conf = c.extracted["ocr_confidence"]
    assert conf["kv"] == 0.73
    assert conf == {
        "kv": 0.73,
        "detector": 0.6,
        "working_distance_mm": 0.6,  # 0.605 rounds half to even
        "magnification": 0.99,
        "mode": 0.5,
        "spot": 1.0,
    }
    assert set(conf) == set(c.extracted["sources"])  # exactly the fields read by OCR
    assert (
        json.loads(json.dumps(c.extracted)) == c.extracted
    )  # survives a JSON round trip


def test_a_low_confidence_value_is_kept_and_recorded():
    kit = _kit()
    c = classify(
        encode_cell(make_cell_image(kit)),
        ocr=True,
        bar_reader=reader_for(kit, conf=0.51),
    )
    assert c.extracted["kv"] == 20.0 and c.extracted["ocr_confidence"]["kv"] == 0.51


def test_a_metadata_claim_has_no_ocr_confidence():
    kit = _kit()
    assert "ocr_confidence" not in classify(make_fei_tiff()).extracted
    # OCR on, and the bar agrees: nothing came from the bar, so nothing to record
    values = ["2.00 kV", "ETD", "15.9 mm", "40×", "SE", "3.5"]
    c = classify(
        encode_cell(make_cell_image(kit, values=values), "TIFF", text=FEI_TEXT),
        ocr=True,
        bar_reader=reader_for(kit, values=values, conf=0.7),
    )
    assert c.extracted["kv"] == 2.0 and "ocr_confidence" not in c.extracted


def test_a_value_the_bar_adds_to_metadata_has_its_confidence_recorded():
    kit = _kit()
    headers = kit.HEADERS6 + ["10μm"]
    values = ["2.00 kV", "ETD", "15.9 mm", "3 000 x", "SE", "3.5", ""]
    text = FEI_TEXT.replace("HFW=0.00745157", "HFW=0.0000994667")
    px = round(10 * 3000 * W / (0.2984 * 1e6))
    c = classify(
        encode_cell(
            make_cell_image(kit, headers, values, scale_len=px), "TIFF", text=text
        ),
        ocr=True,
        bar_reader=reader_for(kit, headers, values, conf=0.876),
    )
    assert c.extracted["scale_bar_um"] == 10.0
    assert c.extracted["ocr_confidence"] == {"scale_bar_um": 0.88}
    assert json.loads(json.dumps(c.extracted)) == c.extracted


def test_a_claim_with_no_value_read_has_no_ocr_confidence():
    kit = _kit()
    got = reader_for(kit, ["HV", "WD", "", "", "", ""], ["~~", "", "", "", "", ""])
    c = classify(encode_cell(make_cell_image(kit)), ocr=True, bar_reader=got)
    assert c.kind == "sem_image" and "ocr_confidence" not in c.extracted
