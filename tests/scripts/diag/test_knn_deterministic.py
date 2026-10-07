"""spatial.knn_deterministic: ties at the k-th neighbour are broken by index, not by the
KD-tree traversal (review finding 7.12)."""

import numpy as np
from diag.spatial import getis_ord_gi_star, knn_deterministic
from scipy.spatial import cKDTree


def _lattice(n=24):
    gx, gy = np.meshgrid(np.arange(n, dtype=float), np.arange(n, dtype=float))
    return np.column_stack([gx.ravel(), gy.ravel()])


def _brute(pts, query, k, self_first=False):
    out = []
    for qi, q in enumerate(query):
        d = np.hypot(*(pts - q).T)
        order = sorted(range(len(pts)), key=lambda j: (round(d[j], 9), j))
        if self_first:
            order.remove(qi)
            order.insert(0, qi)
        out.append(order[:k])
    return np.array(out)


def test_matches_brute_force_distance_then_index_on_a_tied_lattice():
    pts = _lattice(12)
    tree = cKDTree(pts)
    for k in (5, 9, 30):
        _, idx = knn_deterministic(tree, pts, k, self_first=True)
        assert np.array_equal(idx, _brute(pts, pts, k, self_first=True))


def test_independent_of_the_kd_tree_layout():
    pts = _lattice(20)
    a = knn_deterministic(cKDTree(pts, leafsize=1), pts, 30, self_first=True)
    b = knn_deterministic(cKDTree(pts, leafsize=64), pts, 30, self_first=True)
    assert np.array_equal(a[1], b[1])
    assert np.allclose(a[0], b[0])


def test_ties_wider_than_the_initial_window_are_still_resolved():
    # 40 points on a circle around the origin, all exactly equidistant from the query
    ang = np.linspace(0, 2 * np.pi, 40, endpoint=False)
    pts = np.column_stack([np.cos(ang), np.sin(ang)])
    tree = cKDTree(pts)
    _, idx = knn_deterministic(tree, np.zeros((1, 2)), 3)
    assert idx[0].tolist() == [0, 1, 2]


def test_self_is_first_even_among_coincident_duplicates():
    pts = np.zeros((6, 2))
    _, idx = knn_deterministic(cKDTree(pts), pts, 3, self_first=True)
    assert idx[:, 0].tolist() == list(range(6))


def test_k_larger_than_the_point_count_is_clamped():
    pts = _lattice(3)
    d, idx = knn_deterministic(cKDTree(pts), pts, 50)
    assert idx.shape == (9, 9) and d.shape == (9, 9)


def test_gi_star_does_not_depend_on_the_kd_tree_layout(monkeypatch):
    """Gridded points tie at the 30th neighbour; the statistic must not depend on which of
    the tied points the tree happens to return."""
    from diag import spatial

    pts = _lattice(40)
    v = np.random.default_rng(3).normal(size=len(pts))
    real = spatial.cKDTree
    results = []
    for leafsize in (1, 7, 64):
        monkeypatch.setattr(
            spatial, "cKDTree", lambda p, leafsize=leafsize: real(p, leafsize=leafsize)
        )
        g, _ = getis_ord_gi_star(pts[:, 0], pts[:, 1], v, k=30)
        results.append(g)
    assert np.array_equal(results[0], results[1])
    assert np.array_equal(results[0], results[2])
