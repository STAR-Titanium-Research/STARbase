"""Reading a synthetic .al3d with SurfaceTopography: orientation, units, no-data, refusals."""

import numpy as np
import pytest

from app.lib import archive, grid, topography
from app.lib.archive import RenderRefused

from .synthetic import ramp, write_al3d


def test_heights_come_out_in_micrometres_top_row_first(tmp_path):
    # 5 rows x 7 cols; row r, col c is (r * 7 + c) micrometres
    path = write_al3d(tmp_path / "a.al3d", ramp(5, 7, scale_m=1e-6), 2e-6, 3e-6)
    scan = topography.read_scan(path)
    assert (scan.height, scan.width) == (5, 7)
    assert scan.source_format == "al3d"
    np.testing.assert_allclose(scan.heights_um[0, :3], [0.0, 1.0, 2.0], atol=1e-4)  # first row of the file
    np.testing.assert_allclose(scan.heights_um[1, 0], 7.0, atol=1e-4)  # row 1 is below row 0
    np.testing.assert_allclose(scan.heights_um[4, 6], 34.0, atol=1e-4)


def test_pixel_pitch_is_in_micrometres_per_axis(tmp_path):
    path = write_al3d(tmp_path / "a.al3d", ramp(4, 6), pixel_size_x_m=2e-6, pixel_size_y_m=3.5e-6)
    scan = topography.read_scan(path)
    assert scan.pixel_pitch_x_um == pytest.approx(2.0)
    assert scan.pixel_pitch_y_um == pytest.approx(3.5)


def test_nan_and_the_files_invalid_marker_both_become_no_data(tmp_path):
    heights = ramp(4, 5)
    heights[1, 2] = np.nan
    heights[2, 3] = -1e30  # the file's InvalidPixelValue
    path = write_al3d(tmp_path / "a.al3d", heights, invalid_value=-1e30)
    scan = topography.read_scan(path)
    mask = np.ma.getmaskarray(scan.heights_um)
    assert mask.sum() == 2
    assert mask[1, 2] and mask[2, 3]
    cells, factor = grid.decimate(scan.heights_um)
    assert factor == 1
    assert np.isnan(cells[1, 2]) and np.isnan(cells[2, 3])
    assert np.isfinite(cells[0, 0])


def test_row_padding_in_the_file_is_cropped(tmp_path):
    # 3 columns: rows are padded from 12 to 16 bytes in the file
    path = write_al3d(tmp_path / "a.al3d", ramp(3, 3))
    scan = topography.read_scan(path)
    assert scan.heights_um.shape == (3, 3)
    np.testing.assert_allclose(scan.heights_um[2, 2], 8.0, atol=1e-4)


def test_end_to_end_grid_for_a_large_scan(tmp_path):
    heights = ramp(1200, 2500, scale_m=1e-9)
    path = write_al3d(tmp_path / "big.al3d", heights, 1e-6, 1e-6)
    scan = topography.read_scan(path)
    cells, factor = grid.decimate(scan.heights_um)
    assert factor == 3
    assert cells.shape == (400, 834)
    assert scan.width == 2500 and scan.height == 1200


def test_a_file_that_is_not_what_its_extension_says_is_refused(tmp_path):
    bogus = tmp_path / "fake.al3d"
    bogus.write_bytes(b"this is not an alicona file at all" * 10)
    with pytest.raises(RenderRefused, match="could not be read"):
        topography.read_scan(bogus)


def test_a_truncated_file_is_refused(tmp_path):
    path = write_al3d(tmp_path / "a.al3d", ramp(20, 20))
    path.write_bytes(path.read_bytes()[:300])
    with pytest.raises(RenderRefused):
        topography.read_scan(path)


def test_a_document_extension_is_never_opened(tmp_path, monkeypatch):
    doc = tmp_path / "report.pdf"
    doc.write_bytes(b"%PDF-1.7")
    opened = []
    monkeypatch.setattr(archive, "open_readonly", lambda p: opened.append(p))
    with pytest.raises(RenderRefused, match="topography"):
        topography.read_scan(doc)
    assert opened == []


def test_a_height_map_without_a_unit_is_refused():
    class Fake:
        dim = 2
        is_uniform = True
        unit = None

    with pytest.raises(RenderRefused, match="unit"):
        topography._to_scan(Fake(), "al3d")


def test_a_line_scan_is_refused():
    class Fake:
        dim = 1
        is_uniform = True
        unit = "m"

    with pytest.raises(RenderRefused, match="2D"):
        topography._to_scan(Fake(), "al3d")
