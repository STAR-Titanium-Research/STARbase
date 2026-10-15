"""Decimation, the grid.bin / meta.json layout and the thumbnail."""

import io
import json
import struct

import numpy as np
import pytest
from PIL import Image

from app.lib import grid


def test_factor_is_the_smallest_that_fits():
    assert grid.decimation_factor(100, 200) == 1
    assert grid.decimation_factor(1024, 1024) == 1
    assert grid.decimation_factor(1024, 1025) == 2
    assert grid.decimation_factor(3000, 10000) == 10  # longer side 10000 -> 1000 cells
    assert grid.decimation_factor(1, 1) == 1


@pytest.mark.parametrize("rows,cols", [(1500, 4000), (4000, 1500), (5000, 5000), (1025, 7), (1023, 1024)])
def test_decimated_grid_is_at_most_1024_on_the_longer_side_and_keeps_aspect(rows, cols):
    source = np.zeros((rows, cols), dtype=np.float32)
    cells, factor = grid.decimate(source)
    assert max(cells.shape) <= 1024
    assert cells.shape == (-(-rows // factor), -(-cols // factor))
    # one block size for both axes, so the aspect is kept: the cells tile the source to within one block
    assert (cells.shape[0] - 1) * factor < rows <= cells.shape[0] * factor
    assert (cells.shape[1] - 1) * factor < cols <= cells.shape[1] * factor


def test_a_small_scan_is_not_resampled():
    source = np.arange(12, dtype=np.float64).reshape(3, 4)
    cells, factor = grid.decimate(source)
    assert factor == 1
    assert cells.dtype == np.float32
    np.testing.assert_array_equal(cells, source.astype(np.float32))


def test_block_mean_averages_each_block():
    source = np.arange(16, dtype=np.float64).reshape(4, 4)
    out = grid.block_mean(source, 2)
    np.testing.assert_allclose(out, [[2.5, 4.5], [10.5, 12.5]])


def test_block_mean_ignores_nan_and_masked_cells():
    source = np.ma.masked_invalid(
        np.array([[1.0, np.nan, 5.0, 7.0], [3.0, 5.0, np.nan, np.nan]])
    )
    source[0, 2] = np.ma.masked  # masked as well as NaN
    out = grid.block_mean(source, 2)
    # block 1: 1, 3, 5 -> 3 (the NaN is skipped, not zeroed); block 2: only 7 is valid
    np.testing.assert_allclose(out, [[3.0, 7.0]])


def test_a_block_with_no_valid_cell_is_nan():
    source = np.full((4, 4), np.nan)
    source[:2, :2] = 1.0
    out = grid.block_mean(source, 2)
    assert out[0, 0] == 1.0
    assert np.isnan(out[0, 1]) and np.isnan(out[1, 0]) and np.isnan(out[1, 1])


def test_infinite_values_count_as_no_data():
    out = grid.block_mean(np.array([[1.0, np.inf], [3.0, -np.inf]]), 2)
    np.testing.assert_allclose(out, [[2.0]])


def test_edge_blocks_average_the_cells_they_have():
    source = np.arange(15, dtype=np.float64).reshape(3, 5)
    out = grid.block_mean(source, 2)
    assert out.shape == (2, 3)
    # bottom-right block is the single cell (2, 4) = 14; top-right is cells (0..1, 4) = 4, 9
    assert out[1, 2] == 14.0
    assert out[0, 2] == 6.5


def test_strips_give_the_same_result_as_one_pass(monkeypatch):
    rng = np.random.default_rng(0)
    source = rng.normal(size=(61, 47))
    source[rng.random(source.shape) < 0.2] = np.nan
    whole = grid.block_mean(source, 4)
    monkeypatch.setattr(grid, "_STRIP_CELLS", 4 * 47 * 2)  # two block rows per strip
    np.testing.assert_array_equal(grid.block_mean(source, 4), whole)


def test_grid_bin_is_float32_little_endian_row_major_top_row_first():
    cells = np.array([[1.0, 2.0, 3.0], [4.0, np.nan, 6.0]], dtype=np.float32)
    raw = grid.grid_bytes(cells)
    assert len(raw) == 2 * 3 * 4
    back = np.frombuffer(raw, dtype="<f4").reshape(2, 3)
    np.testing.assert_array_equal(back[0], [1.0, 2.0, 3.0])  # first row of the array is first on disk
    assert np.isnan(back[1, 1])
    assert raw[:4] == struct.pack("<f", 1.0)  # little-endian on any host
    assert raw[12:16] == struct.pack("<f", 4.0)  # row 1 follows row 0


def test_grid_bytes_of_a_non_contiguous_or_float64_array():
    cells = np.arange(12, dtype=np.float64).reshape(3, 4).T  # a transposed view
    back = np.frombuffer(grid.grid_bytes(cells), dtype="<f4").reshape(4, 3)
    np.testing.assert_array_equal(back, cells)


def test_meta_json_layout():
    cells = np.array([[1.0, np.nan], [3.0, 9.0]], dtype=np.float32)
    meta = json.loads(
        grid.meta_bytes(
            grid=cells,
            factor=4,
            pitch_x_um=0.5,
            pitch_y_um=0.25,
            source_width=8,
            source_height=7,
            source_format="al3d",
        )
    )
    assert meta == {
        "width": 2,
        "height": 2,
        "pixel_pitch_x_um": 2.0,  # the grid's pitch: source pitch x block size
        "pixel_pitch_y_um": 1.0,
        "z_min_um": 1.0,
        "z_max_um": 9.0,
        "source_width": 8,
        "source_height": 7,
        "source_format": "al3d",
        "decimation": {"method": "block-mean-nan-aware", "factor": 4},
    }


def test_meta_of_an_all_nan_grid_is_refused():
    with pytest.raises(ValueError):
        grid.meta_bytes(
            grid=np.full((2, 2), np.nan, dtype=np.float32),
            factor=1,
            pitch_x_um=1,
            pitch_y_um=1,
            source_width=2,
            source_height=2,
            source_format="al3d",
        )


def _png(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img.load()
    return img


def test_thumbnail_is_a_png_at_most_320_px_with_aspect_kept():
    cells = np.linspace(0, 10, 1000 * 500, dtype=np.float32).reshape(500, 1000)
    img = _png(grid.thumbnail_png(cells))
    assert img.format == "PNG"
    assert img.mode == "RGBA"
    assert max(img.size) <= 320
    assert abs(img.size[0] / img.size[1] - 2.0) < 0.1


def test_thumbnail_nan_cells_are_transparent_and_data_is_opaque_and_coloured():
    cells = np.linspace(0, 1, 64, dtype=np.float32).reshape(8, 8)
    cells[0, 0] = np.nan
    img = np.asarray(_png(grid.thumbnail_png(cells)))
    assert img[0, 0, 3] == 0
    assert (img[1:, :, 3] == 255).all()
    low, high = img[1, 0, :3], img[7, 7, :3]
    assert not np.array_equal(low, high)  # the ramp actually varies with height


def test_thumbnail_of_a_flat_scan_does_not_divide_by_zero():
    img = _png(grid.thumbnail_png(np.full((4, 4), 2.0, dtype=np.float32)))
    assert img.size == (4, 4)
