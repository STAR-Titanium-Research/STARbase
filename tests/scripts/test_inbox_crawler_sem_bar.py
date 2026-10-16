"""The cell-split data-bar reader (SEM reader spec section 2, tier 2).

Every bar here is SYNTHETIC, drawn in the test, and the recogniser is a scripted fake: this file proves the
geometry (cells), the mapping by header text, the parsing, the ranges and the cross-checks. It cannot prove
accuracy on the real instrument font; that is the physical-test backlog (SEM1, SEM2) and the d1-server spike
harness. No research image is ever committed.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

np = pytest.importorskip("numpy")
PIL = pytest.importorskip("PIL")
from inbox_crawler import sem_bar  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402
from test_inbox_crawler_classify import _font  # noqa: E402

W, H = 1024, 59  # the real FEI layout: a 59-row bar under a 1024-px image
HEADERS6 = ["HV", "det", "WD", "mag", "mode", "spot"]
VALUES6 = ["20.00 kV", "ETD", "10.3 mm", "1 200 x", "SE", "3.0"]


def make_bar(
    labels,
    values,
    scale_len=None,
    *,
    w=W,
    h=H,
    white=255,
    scale_row=None,
    mid_row=False,
    tight=False,
):
    """A grey-scale FEI-like bar: a white top row, white 1-px vertical dividers between equal cells, the header
    text on the upper half and the value text on the lower half of each cell, no horizontal line between them,
    and (when `scale_len`) a horizontal scale-bar line of that many pixels in the right cell. `white` lowers
    every white (a contrast-edited export has about 207). `mid_row` adds a full-width row across the middle. `tight` is the real geometry: big text whose header ink
    (rows 8 to 23) and value ink (rows 27 to 41) leave a gap of only three dark rows (24 to 26), so the
    header/value split can only fall there (at row 25)."""
    n = len(labels)
    img = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(img)
    d.line((0, 0, w, 0), fill=white)
    edges = [round(i * w / n) for i in range(n + 1)]
    for x in edges[1:-1]:
        d.line((x, 0, x, h - 1), fill=white)
    f = _font(22 if tight else 14)
    head_y, value_y = (2, 20) if tight else (4, h // 2 + 3)
    for i, (label, value) in enumerate(zip(labels, values)):
        d.text((edges[i] + 6, head_y), label, fill=white, font=f)
        d.text((edges[i] + 6, value_y), value, fill=white, font=f)
    if scale_len:
        y = h - 12 if scale_row is None else scale_row
        x1 = w - 12
        d.line((x1 - scale_len + 1, y, x1, y), fill=white)
    if mid_row:
        d.line((0, h // 2, w, h // 2), fill=white)
    return img


class Scripted:
    """A fake recogniser: returns the scripted `(text, confidence)` pairs, in order, and keeps what it was given."""

    def __init__(self, results):
        self.results = list(results)
        self.calls = []

    def __call__(self, crops):
        self.calls.append(crops)
        assert len(crops) == len(self.results), (len(crops), len(self.results))
        return list(self.results)


def interleave(headers, values, conf=0.8):
    """The recogniser's answer for cells in order: header, value, header, value ..."""
    out = []
    for h, v in zip(headers, values):
        out += [(h, conf), (v, conf)]
    return out


# ---- cut_cells ----------------------------------------------------------------------------


def test_cut_cells_finds_every_cell():
    cells = sem_bar.cut_cells(make_bar(HEADERS6, VALUES6))
    assert len(cells) == 6
    for c in cells:
        assert c.header.size[0] > 0 and c.header.size[1] > 0
        assert c.value.size[0] > 0 and c.value.size[1] > 0
        assert c.x0 < c.x1
    assert [c.x0 for c in cells] == sorted(c.x0 for c in cells)


def test_cut_cells_header_and_value_hold_their_own_text():
    cells = sem_bar.cut_cells(make_bar(HEADERS6, VALUES6))
    for c in cells:
        # the text is white on black: each half has some bright pixels, and the split fell in the gap
        assert c.header.getextrema()[1] > 100
        assert c.value.getextrema()[1] > 100


def _lined_and_plain():
    # the real geometry: a three-row gap between header and value ink, and the scale-bar line drawn IN that gap
    # (row 26, its last row) in the right cell
    labels, values = HEADERS6 + ["100μm"], VALUES6 + [""]
    plain = sem_bar.cut_cells(make_bar(labels, values, tight=True))
    lined = sem_bar.cut_cells(
        make_bar(labels, values, scale_len=100, scale_row=26, tight=True)
    )
    return plain, lined


def test_cut_cells_ignores_scale_bar_line():
    plain, lined = _lined_and_plain()
    assert len(plain) == len(lined) == 7
    assert [(c.x0, c.x1) for c in lined] == [(c.x0, c.x1) for c in plain]
    assert [c.header.size for c in lined] == [c.header.size for c in plain]
    assert [c.value.size for c in lined] == [c.value.size for c in plain]
    assert (
        plain[0].header.size[1] == 23
    )  # split at row 25, the middle of the gap (rows 24 to 26)


def test_a_full_width_row_mean_would_be_fooled_by_the_scale_bar_line(monkeypatch):
    # the regression guard has teeth: judge the split on the whole width (spec section 2's named mistake) and the
    # line in the gap moves it, so the lined bar is cut differently from the plain one
    monkeypatch.setattr(sem_bar, "SPLIT_LEFT", 1.0)
    plain, lined = _lined_and_plain()
    assert [c.header.size for c in lined] != [c.header.size for c in plain]


def test_cut_cells_on_contrast_edited_bar():
    normal = sem_bar.cut_cells(make_bar(HEADERS6, VALUES6))
    edited = sem_bar.cut_cells(make_bar(HEADERS6, VALUES6, white=207))
    assert len(edited) == 6
    assert [(c.x0, c.x1) for c in edited] == [(c.x0, c.x1) for c in normal]


def test_cut_cells_follows_the_dividers_not_a_layout():
    seven = sem_bar.cut_cells(make_bar(HEADERS6 + ["x"], VALUES6 + [""]))
    assert len(seven) == 7
    four = sem_bar.cut_cells(make_bar(HEADERS6[:4], VALUES6[:4]))
    assert len(four) == 4


def test_cut_cells_is_empty_below_three_cells():
    assert sem_bar.cut_cells(make_bar(HEADERS6[:2], VALUES6[:2])) == []
    assert sem_bar.cut_cells(Image.new("L", (W, H), 0)) == []  # nothing there at all
    assert sem_bar.cut_cells(Image.new("L", (W, H), 255)) == []  # one solid block


def test_cut_cells_tolerates_a_tiny_bar():
    assert sem_bar.cut_cells(Image.new("L", (5, 5), 255)) == []


# ---- read_bar -----------------------------------------------------------------------------


def test_read_bar_maps_by_header_text():
    bar = make_bar(HEADERS6, VALUES6)
    fake = Scripted(interleave(["HV", "det", "WD", "mag", "mode", "spot"], VALUES6))
    got = sem_bar.read_bar(bar, fake)
    assert got == {
        "hv": ("20.00 kV", 0.8),
        "det": ("ETD", 0.8),
        "wd": ("10.3 mm", 0.8),
        "mag": ("1 200 x", 0.8),
        "mode": ("SE", 0.8),
        "spot": ("3.0", 0.8),
    }
    assert len(fake.calls) == 1  # one call for every crop of the bar
    assert len(fake.calls[0]) == 12  # a header and a value per cell


def test_read_bar_maps_the_other_layout_the_same_way():
    # `mode | HV | spot | WD | mag` (no det): the field comes from the header text, never the position
    headers = ["mode", "HV", "spot", "WD", "mag"]
    values = ["SE", "20.00 kV", "3.0", "10.3 mm", "1 200 x"]
    got = sem_bar.read_bar(
        make_bar(headers, values), Scripted(interleave(headers, values))
    )
    assert {k: v[0] for k, v in got.items()} == {
        "mode": "SE",
        "hv": "20.00 kV",
        "spot": "3.0",
        "wd": "10.3 mm",
        "mag": "1 200 x",
    }


def test_read_bar_matches_headers_by_their_start_and_ignores_others():
    headers = ["HV", "Mag", "Curr", "Pressure", "WD", "Tilt"]
    values = ["5.00 kV", "250 x", "1.2 nA", "1e-5", "8.0 mm", "0"]
    got = sem_bar.read_bar(
        make_bar(headers, values), Scripted(interleave(headers, values))
    )
    assert set(got) == {"hv", "mag", "wd"}


def test_read_bar_hands_the_recogniser_rgb_arrays():
    fake = Scripted(interleave(HEADERS6, VALUES6))
    sem_bar.read_bar(make_bar(HEADERS6, VALUES6), fake)
    for crop in fake.calls[0]:
        assert isinstance(crop, np.ndarray)
        assert crop.dtype == np.uint8 and crop.ndim == 3 and crop.shape[2] == 3
        assert (
            crop.shape[0] > 12 and crop.shape[1] > 12
        )  # scaled 2x and padded 6 px each side
        assert crop[0, 0].tolist() == [255, 255, 255]  # black text on a white border


def test_read_bar_scale_cell_label_on_top_row():
    headers = HEADERS6 + ["100μm"]
    values = VALUES6 + [""]
    got = sem_bar.read_bar(
        make_bar(headers, values, scale_len=120),
        Scripted(interleave(headers, values, conf=0.6)),
    )
    assert got["scale"] == ("100μm", 0.6)
    assert set(got) == {"hv", "det", "wd", "mag", "mode", "spot", "scale"}


@pytest.mark.parametrize("label", ["40 µm", "40µm", "3mm", "500 nm", "100 μm"])
def test_read_bar_scale_label_forms(label):
    headers = HEADERS6[:3] + [label]
    values = VALUES6[:3] + [""]
    got = sem_bar.read_bar(
        make_bar(headers, values), Scripted(interleave(headers, values))
    )
    assert got["scale"][0] == label


def test_read_bar_without_cells_never_calls_the_recogniser():
    fake = Scripted([])
    assert sem_bar.read_bar(Image.new("L", (W, H), 0), fake) == {}
    assert fake.calls == []


def test_read_bar_a_recogniser_that_loses_crops_gives_nothing():
    bar = make_bar(HEADERS6, VALUES6)
    assert sem_bar.read_bar(bar, lambda crops: [("HV", 0.9)]) == {}


# ---- parse_bar ----------------------------------------------------------------------------


def read_of(**cells):
    """A `read_bar` result from `key=text` (confidence 0.8)."""
    return {k: (v, 0.8) for k, v in cells.items()}


def parse(read, *, image_width=W, scale_px=None, hfw_um=None):
    return sem_bar.parse_bar(
        read, image_width=image_width, scale_px=scale_px, hfw_um=hfw_um
    )


def test_parse_bar_values():
    r = parse(
        read_of(hv="20.00 kV", wd="10.3 mm", mag="1 200 x", scale="100μm"),
    )
    assert r.values["kv"] == 20.0
    assert r.values["working_distance_mm"] == 10.3
    assert r.values["magnification"] == 1200
    assert r.values["scale_bar_um"] == 100.0
    assert set(r.sources.values()) == {"ocr"}
    assert set(r.sources) == set(r.values)


@pytest.mark.parametrize(
    "text,expected",
    [
        ("1 200 x", 1200),
        ("1\u2009200 x", 1200),  # thin space
        ("1\u00a0200\u00a0\u00d7", 1200),  # no-break spaces, the multiplication sign
        ("1\u202f200 x", 1200),  # narrow no-break space
        ("40×", 40),
        ("3 000 x", 3000),
        ("5,000 x", 5000),
        ("250x", 250),
        ("12 345 x", 12345),
        ("120 000 x", 120000),
    ],
)
def test_parse_bar_magnification_forms(text, expected):
    assert parse(read_of(mag=text)).values["magnification"] == expected


@pytest.mark.parametrize(
    "text,unit,expected",
    [("100μm", "scale_bar_um", 100.0), ("100 µm", "scale_bar_um", 100.0)]
    + [("3mm", "scale_bar_um", 3000.0), ("500 nm", "scale_bar_um", 0.5)]
    + [("40um", "scale_bar_um", 40.0), ("1.5 µm", "scale_bar_um", 1.5)],
)
def test_parse_bar_scale_label_is_a_number_of_micrometres(text, unit, expected):
    assert parse(read_of(scale=text)).values[unit] == pytest.approx(expected)


def test_parse_bar_spot_detector_and_mode():
    r = parse(read_of(spot="3.0", det="ETD", mode="SE"))
    assert r.values == {"spot": 3.0, "detector": "ETD", "mode": "SE"}
    assert set(r.sources.values()) == {"ocr"}


def test_parse_bar_decimal_comma():
    assert parse(read_of(wd="10,3 mm")).values["working_distance_mm"] == 10.3


def test_low_confidence_is_not_a_filter():
    r = parse({"hv": ("20.00 kV", 0.60), "wd": ("10.3 mm", 0.01)})
    assert r.values["kv"] == 20.0
    assert r.values["working_distance_mm"] == 10.3
    assert r.confidence == {"kv": 0.60, "working_distance_mm": 0.01}


def test_magnification_cross_check_passes():
    r = parse(read_of(mag="1 200 x"), hfw_um=248.67)  # 0.2984 / 1200 = 248.67e-6
    assert r.values["magnification"] == 1200
    assert "magnification" not in r.flags
    assert "check_this" not in r.flags


def test_magnification_cross_check_accepts_the_second_screen_width():
    # 0.858 of the canvas: mag 1200 with a field width of 0.2984 * 0.858 / 1200
    r = parse(read_of(mag="1 200 x"), hfw_um=0.2984 * 0.858 / 1200 * 1e6)
    assert r.values["magnification"] == 1200 and "check_this" not in r.flags


def test_magnification_cross_check_tolerates_a_rounded_printed_value():
    # the bar prints 40x for a true 40.05
    r = parse(read_of(mag="40×"), hfw_um=0.2981 / 40.05 * 1e6)
    assert r.values["magnification"] == 40 and "magnification" not in r.flags


def test_blurred_magnification_is_omitted_not_guessed():
    r = parse(read_of(mag="200", hv="20.00 kV"), hfw_um=248.67)
    assert "magnification" not in r.values
    assert r.flags["magnification"] == "hfw_mismatch"
    assert r.values["kv"] == 20.0  # the other fields are not dragged down


def test_a_stray_number_in_the_magnification_cell_is_not_read_as_one_value():
    # an ordinary space is a thousands separator, so "5 1 200" must not become 51 200
    r = parse(read_of(mag="5 1 200 x"))
    assert "magnification" not in r.values
    assert r.flags["magnification"] == "not_a_number"


def test_a_stray_number_in_the_magnification_cell_fails_the_cross_check_too():
    # a well-formed merge ("3 500" for "500") has the right shape but the wrong product
    r = parse(read_of(mag="3 500 x"), hfw_um=0.2984 / 500 * 1e6)
    assert "magnification" not in r.values
    assert r.flags["magnification"] == "hfw_mismatch"


@pytest.mark.parametrize(
    "key,text,field",
    [
        ("hv", "20.00 7 kV", "kv"),
        ("wd", "10.3 4 mm", "working_distance_mm"),
        ("spot", "3 5", "spot"),
    ],
)
def test_a_stray_number_in_a_decimal_cell_is_not_merged(key, text, field):
    r = parse(read_of(**{key: text}))
    assert field not in r.values
    assert r.flags[field] == "not_a_number"


def scale_px_for(label_um, mag, width=W, canvas=0.2984):
    return round(label_um * mag * width / (canvas * 1e6))


def test_scale_bar_cross_check():
    px = scale_px_for(100, 1200)
    implied = px * 0.2984e6 / (1200 * W)
    assert abs(implied - 100) < 5
    r = parse(read_of(mag="1 200 x", scale="100μm"), scale_px=px)
    assert r.values["scale_bar_um"] == 100.0
    assert "scale_bar_um" not in r.flags
    assert "check_this" not in r.flags  # the scale bar confirmed the magnification
    # 20% off
    r = parse(read_of(mag="1 200 x", scale="100μm"), scale_px=round(px * 0.8))
    assert "scale_bar_um" not in r.values
    assert r.flags["scale_bar_um"] == "length_mismatch"
    r = parse(read_of(mag="1 200 x", scale="100μm"), scale_px=round(px * 1.2))
    assert r.flags["scale_bar_um"] == "length_mismatch"


def test_scale_bar_cross_check_edges():
    px = scale_px_for(100, 1200)
    for factor, ok in ((0.96, True), (1.04, True), (0.9, False), (1.1, False)):
        r = parse(read_of(mag="1 200 x", scale="100μm"), scale_px=round(px * factor))
        assert ("scale_bar_um" in r.values) is ok, factor


def test_scale_bar_cross_check_uses_the_screen_width_the_field_width_identified():
    px = scale_px_for(100, 1200, canvas=0.2984 * 0.858)
    hfw = (
        0.2984 * 0.858 / 1200 * 1e6
    )  # the metadata's field width says this image has the narrower canvas
    r = parse(read_of(mag="1 200 x", scale="100μm"), scale_px=px, hfw_um=hfw)
    assert r.values["scale_bar_um"] == 100.0 and "check_this" not in r.flags
    # without a field width nothing says which canvas applies: the first constant, so this length is off. A bar-only
    # export from a 0.858-canvas instrument therefore loses its magnification (the safe direction; SEM2 counts these)
    r = parse(read_of(mag="1 200 x", scale="100μm"), scale_px=px)
    assert "scale_bar_um" not in r.values and "magnification" not in r.values
    assert r.flags["scale_bar_um"] == r.flags["magnification"] == "length_mismatch"


def test_a_failed_scale_check_omits_the_magnification_too():
    # bar only (no hfw_um, as for every PNG/JPEG/BMP export): the label or the number is wrong and nothing says
    # which, so neither is kept
    px = scale_px_for(100, 1200)
    r = parse(
        read_of(mag="1 200 x", scale="100μm", hv="20.00 kV"), scale_px=round(px * 0.8)
    )
    assert "magnification" not in r.values and "scale_bar_um" not in r.values
    assert r.flags["magnification"] == "length_mismatch"
    assert r.flags["scale_bar_um"] == "length_mismatch"
    assert r.values["kv"] == 20.0  # the other fields are not dragged down
    assert r.flags["check_this"] is True
    assert "magnification" not in r.sources and "magnification" not in r.confidence


def test_a_misread_magnification_over_a_true_scale_bar_is_omitted():
    # the true value is 1 200 x (the scale bar is drawn for it); the recogniser read 200
    px = scale_px_for(100, 1200)
    r = parse(read_of(mag="200 x", scale="100μm", hv="20.00 kV"), scale_px=px)
    assert "magnification" not in r.values
    assert r.flags["magnification"] == "length_mismatch"
    assert r.values["kv"] == 20.0


def test_a_merged_magnification_over_a_true_scale_bar_is_omitted():
    # "40 100 x" is a well-formed grouping (40 100) with the wrong value: the bar is drawn for 100 x
    px = scale_px_for(100, 100)
    ok = parse(read_of(mag="100 x", scale="100μm"), scale_px=px)
    assert ok.values["magnification"] == 100 and "check_this" not in ok.flags
    r = parse(read_of(mag="40 100 x", scale="100μm"), scale_px=px)
    assert "magnification" not in r.values
    assert r.flags["magnification"] == "length_mismatch"


def test_the_field_width_keeps_a_magnification_the_scale_bar_contradicts():
    # the metadata's field width vouches for the number, so only the label is dropped
    px = round(scale_px_for(100, 1200) * 0.8)
    r = parse(read_of(mag="1 200 x", scale="100μm"), scale_px=px, hfw_um=248.67)
    assert r.values["magnification"] == 1200 and "magnification" not in r.flags
    assert "scale_bar_um" not in r.values
    assert r.flags["scale_bar_um"] == "length_mismatch"
    assert "check_this" not in r.flags


def test_scale_bar_check_needs_a_magnification():
    # the magnification failed its own check, so the scale bar has nothing to be compared with
    r = parse(read_of(mag="200", scale="100μm"), scale_px=400, hfw_um=248.67)
    assert "magnification" not in r.values
    assert r.values["scale_bar_um"] == 100.0
    assert r.flags["check_this"] is True


def test_no_cross_check_flags_check_this():
    r = parse(read_of(hv="20.00 kV", mag="1 200 x", scale="100μm"))
    assert r.values["kv"] == 20.0 and r.values["magnification"] == 1200
    assert r.flags["check_this"] is True


def test_nothing_read_flags_nothing():
    r = parse({})
    assert (r.values, r.sources, r.flags) == ({}, {}, {})


def test_out_of_range_kv_omitted():
    r = parse(read_of(hv="250 kV"))
    assert "kv" not in r.values
    assert r.flags["kv"] == "out_of_range"


@pytest.mark.parametrize(
    "key,text,field",
    [
        ("hv", "0 kV", "kv"),
        ("wd", "99 mm", "working_distance_mm"),
        ("mag", "2 x", "magnification"),
        ("mag", "2 000 000 x", "magnification"),
        ("spot", "30", "spot"),
        ("spot", "0.0", "spot"),
    ],
)
def test_out_of_range_values_are_omitted_with_a_flag(key, text, field):
    r = parse(read_of(**{key: text}))
    assert field not in r.values and r.flags[field] == "out_of_range"


def test_garbage_cell_gives_no_value():
    r = parse(read_of(wd="", hv="~~ kV", spot="#"))
    assert r.values == {}
    assert r.flags["working_distance_mm"] == "not_a_number"
    assert r.flags["kv"] == "not_a_number"
    assert r.flags["spot"] == "not_a_number"


def test_garbage_detector_text_is_not_stored():
    r = parse(read_of(det="", mode="!!!"))
    assert r.values == {}
    assert r.flags["detector"] == "unparseable" and r.flags["mode"] == "unparseable"


def test_a_scale_label_without_a_unit_is_not_a_scale_bar():
    r = parse(read_of(scale="100"))
    assert "scale_bar_um" not in r.values and r.flags["scale_bar_um"] == "not_a_number"


def test_no_screen_width_is_a_division_by_zero_guard():
    r = parse(read_of(mag="1 200 x", scale="100μm"), image_width=0, scale_px=400)
    assert "scale_bar_um" in r.values  # nothing to check against: kept, unconfirmed
    assert r.flags["check_this"] is True


def test_zero_hfw_does_not_divide_or_mismatch():
    r = parse(read_of(mag="1 200 x"), hfw_um=0.0)
    assert r.values["magnification"] == 1200 and r.flags["check_this"] is True


def test_the_output_is_plain_json():
    import json

    r = parse(read_of(hv="20.00 kV", mag="1 200 x", spot="3.0", det="ETD"))
    json.dumps([r.values, r.sources, r.flags])


# ---- scale_bar_length_px ------------------------------------------------------------------


def test_scale_bar_length_px_measures_the_line():
    bar = make_bar(HEADERS6 + ["100μm"], VALUES6 + [""], scale_len=120)
    assert sem_bar.scale_bar_length_px(bar) == 120


def test_scale_bar_length_px_on_contrast_edited_bar():
    bar = make_bar(HEADERS6 + ["100μm"], VALUES6 + [""], scale_len=120, white=207)
    assert sem_bar.scale_bar_length_px(bar) == 120


def test_scale_bar_length_px_none_without_a_line():
    assert (
        sem_bar.scale_bar_length_px(make_bar(HEADERS6 + ["x"], VALUES6 + [""])) is None
    )


def test_scale_bar_length_px_ignores_short_runs():
    bar = make_bar(HEADERS6 + ["x"], VALUES6 + [""], scale_len=15)
    assert sem_bar.scale_bar_length_px(bar) is None


def test_scale_bar_length_px_ignores_a_full_width_row_and_the_top_row():
    bar = make_bar(HEADERS6 + ["x"], VALUES6 + [""], mid_row=True)
    assert sem_bar.scale_bar_length_px(bar) is None


def test_scale_bar_length_px_none_when_there_are_no_cells():
    assert sem_bar.scale_bar_length_px(Image.new("L", (W, H), 0)) is None


def test_canvas_constants():
    assert sem_bar.CANVAS_M == (0.2984, 0.2984 * 0.858)
