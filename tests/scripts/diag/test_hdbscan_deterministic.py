"""spatial.cluster_hdbscan must not depend on how the CPU's argsort orders tied values.

scikit-learn's HDBSCAN sorts MST edges with a bare np.argsort; NumPy's AVX-512 and non-AVX-512
sorts order exact ties differently, which flipped cluster_id/glosh for 22/9984 golden elements
between GitHub runners with identical package versions. These tests stand in for "another CPU"
by scrambling the order of tied values inside np.argsort.
"""

import numpy as np
from diag.spatial import cluster_hdbscan


def _tied_points():
    rng = np.random.default_rng(7)
    gx, gy = np.meshgrid(np.arange(30, dtype=float), np.arange(30, dtype=float))
    x, y = gx.ravel(), gy.ravel()
    # Two plateaus plus a coarse step in v, so many mutual-reachability distances tie exactly.
    v = np.where(x < 15, 0.0, 1.0) + np.round(rng.normal(0, 0.4, x.size))
    return x, y, v


def _scrambling_argsort(seed, calls):
    real = np.argsort

    def argsort(a, *args, **kwargs):
        a = np.asarray(a)
        if a.ndim == 1 and a.dtype.kind == "f" and "kind" not in kwargs and not args:
            calls.append(a.size)
            tiebreak = np.random.default_rng(seed).permutation(a.size)
            return np.lexsort((tiebreak, a))
        return real(a, *args, **kwargs)

    return argsort


def test_labels_do_not_depend_on_argsort_tie_order(monkeypatch):
    x, y, v = _tied_points()
    ref_labels, ref_glosh = cluster_hdbscan(x, y, v)
    assert (
        len(set(ref_labels)) > 1
    )  # non-trivial clustering, or the test proves nothing
    for seed in (1, 2, 3):
        calls: list[int] = []
        with monkeypatch.context() as m:
            m.setattr(np, "argsort", _scrambling_argsort(seed, calls))
            labels, glosh = cluster_hdbscan(x, y, v)
        assert np.array_equal(labels, ref_labels), f"seed {seed}"
        assert np.array_equal(glosh, ref_glosh), f"seed {seed}"
