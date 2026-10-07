"""plot_overview must recover the stride strided_read used (review nit, plotter.py:449)."""

import pytest

from app.lib.parser import parse_header, strided_read
from app.lib.plotter import plot_overview, sample_stride
from tests.generate_test_file import write_d1f


@pytest.mark.parametrize(
    ("n_samples", "target"),
    [(20_001, 10_000), (25_000, 10_000), (29_999, 10_000), (10_001, 10_000)]
    + [(20_000, 10_000), (1_000_000, 10_000), (5_000, 10_000)],
)
def test_sample_stride_matches_strided_read(tmp_path, n_samples, target):
    path = str(tmp_path / "f.d1f")
    write_d1f(path, n_samples, 10_000.0, n_channels=2)
    with open(path, "rb") as fh:
        header = parse_header(fh)
    data = strided_read(path, header, target_points=target)
    expected = max(1, n_samples // target)
    assert sample_stride(n_samples, data.shape[0]) == expected


def test_20001_samples_stride_is_2_not_1():
    """Old code: 20001 // 10001 == 1 -> the time axis ended at ~1 s instead of ~2 s."""
    assert 20_001 // 10_001 == 1  # the buggy formula
    assert sample_stride(20_001, 10_001) == 2


def test_plot_overview_runs_on_20001_samples(tmp_path):
    path = str(tmp_path / "f.d1f")
    write_d1f(path, 20_001, 10_000.0, n_channels=1)
    with open(path, "rb") as fh:
        header = parse_header(fh)
    data = strided_read(path, header, target_points=10_000)
    assert plot_overview(data, header).lstrip().startswith(b"<?xml")
