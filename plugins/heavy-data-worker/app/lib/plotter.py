"""Overview plot generator for D1F force files."""

import io

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np

CHANNEL_LABELS = ["Fx", "Fy", "Fz", "Mx", "My", "Mz"]
CHANNEL_UNITS = ["N", "N", "N", "Nm", "Nm", "Nm"]


def sample_stride(n_samples: int, n_points: int) -> int:
    """The stride strided_read used to produce *n_points* rows from *n_samples*.

    strided_read steps by ``n_samples // target_points`` and returns
    ``ceil(n_samples / stride)`` rows, which is a little MORE than target_points, so
    ``n_samples // n_points`` rounds down to a smaller stride (20001 samples, target 10000:
    stride 2, 10001 rows, 20001 // 10001 == 1) and halves the time axis. Rounding the true
    ratio recovers the stride.
    """
    return max(1, round(n_samples / max(1, n_points)))


def plot_overview(data: np.ndarray, header: dict, title: str = "") -> bytes:
    """Return SVG bytes for a multi-channel force/moment overview plot.

    Args:
        data: shape (n_points, n_channels), already downsampled via strided_read
        header: D1F file header dict (needs sample_rate_hz, n_samples)
        title: optional plot title (e.g. the MinIO object key)
    """
    n_points, n_ch = data.shape
    stride = sample_stride(header["n_samples"], n_points)
    t = np.arange(n_points) * stride / header["sample_rate_hz"]

    fig, axes = plt.subplots(n_ch, 1, figsize=(12, 2 * n_ch), sharex=True)
    if n_ch == 1:
        axes = [axes]

    for i, ax in enumerate(axes):
        label = CHANNEL_LABELS[i] if i < len(CHANNEL_LABELS) else f"Ch{i}"
        unit = CHANNEL_UNITS[i] if i < len(CHANNEL_UNITS) else ""
        ax.plot(t, data[:, i], linewidth=0.5)
        ax.set_ylabel(f"{label} ({unit})" if unit else label)
        ax.grid(alpha=0.3)

    axes[-1].set_xlabel("Time (s)")
    if title:
        fig.suptitle(title, fontsize=10)
    fig.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format="svg", bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return buf.read()
