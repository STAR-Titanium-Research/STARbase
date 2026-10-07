import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "scripts"))

SPR = 256


def synthetic_cut(n_rev=40, spr=SPR, anomaly_rev=25.0, anomaly_span=0.05):
    """A clean spiral with one implanted force anomaly at a known revolution.

    Seeded (default_rng(7)) so the golden reference is reproducible. Identical to the
    fixture test_pipeline.py used privately before this was extracted.
    """
    n = n_rev * spr
    revs = np.arange(n, dtype=np.float64) / spr
    fs = 25_000.0
    t = revs * 60.0 / 1200.0
    phase = 2 * np.pi * revs
    fz = 120.0 + 4.0 * np.sin(phase) + 1.5 * np.sin(3 * phase)
    rng = np.random.default_rng(7)
    fz = fz + rng.normal(scale=0.4, size=n)
    hit = np.abs(revs - anomaly_rev) < anomaly_span
    fz[hit] += 30.0
    fx = np.zeros(n)
    fy = np.zeros(n)
    rpm = np.full(n, 1200.0)
    rho = 40.0 - 0.05 * revs
    x, y = rho * np.cos(phase), rho * np.sin(phase)
    return t, fx, fy, fz, rpm, revs, x, y, fs, hit


def cache_of(t, fx, fy, fz, rpm, revs, fs):
    return {
        "n": t.size,
        "fs": fs,
        "feed": 0.05,
        "diam": 80.0,
        "cs_sec": 0.0,
        "ce_sec": float(t[-1]),
        "t": t,
        "fx": fx,
        "fy": fy,
        "fz": fz,
        "rpm": rpm,
        "revs": revs,
    }


@pytest.fixture
def standard_cut():
    """(cache, x, y) for the 40-revolution reference cut."""
    t, fx, fy, fz, rpm, revs, x, y, fs, _ = synthetic_cut()
    return cache_of(t, fx, fy, fz, rpm, revs, fs), x, y


# --- Equivalence gate: shared golden comparison ------------------------------
#
# The two golden .npz fixtures were captured from pipeline.analyse() BEFORE the registry
# existed (see the plan's Task 1). They compare the new recipe pipeline against the old
# one's recorded behaviour, not against itself. Exact equality, never allclose: this is a
# refactor, so any numerical difference at all is a defect.
#
# PORTABILITY CAVEAT: the fixtures are bit-valid on the machine that captured them only.
# Cross-machine BLAS differences, thread-reduction ordering, and numpy/scipy version drift
# can perturb the low bits of the float results. A failure of these tests on different
# hardware or a different dependency set should first be diagnosed as an environment
# difference, NOT assumed to be a code regression. Do not regenerate the fixtures to make a
# failure go green -- they are the only evidence the refactor is safe. Note also that
# conftest.synthetic_cut is a co-dependency of BOTH fixtures: it defines the exact input
# they were captured from, so editing it breaks all four equivalence gates at once in a way
# that reads as a pipeline regression rather than a fixture-input change.
#
# PROVENANCE
#   original  captured from analyse() before the registry existed (plan Task 1)
#   v9        RECAPTURED, 2026-09-04. _op_hdbscan switched from spatial.assign_from_grid to
#             spatial.assign_by_neighbours to stop cluster boundaries being quantized to the
#             reduction grid. Exactly two columns moved -- cluster_id (107/9984, 1.07%, same
#             label set {-1,0,1,2}) and glosh (8245/9984, now an interpolated weighted mean
#             rather than piecewise-constant per cell). Every other column and the
#             __metrics__ blob were byte-identical across the recapture, which is the
#             evidence that the change is confined to the op that was edited.
#   v11       RECAPTURED, 2026-10-04 (review finding 7.12). spatial.knn_deterministic replaced the
#             raw cKDTree.query in getis_ord_gi_star and assign_by_neighbours: on this gridded
#             input the 30th (and 4th) neighbour is tied, and the KD-tree picked among the tied
#             points in a scipy-build-dependent way, so the old goldens only matched the
#             machine that froze them. Moved: gi_star (1145/9984, 11.47%, max |delta| 0.77),
#             gi_sig (3/9984), glosh (103/9984), cluster_id (22/9984, same label set) and the
#             __metrics__ blob, in both fixtures. Ties now break by (distance, index), so gi_star
#             is identical on numpy 1.26/scipy 1.11 and numpy 2.4/scipy 1.17 as well as the
#             plugin pin. Remaining dependency: cluster_id/glosh come from sklearn's HDBSCAN,
#             which differs between sklearn 1.3 and 1.5 on identical input; the goldens are
#             valid for the plugin-pinned scikit-learn 1.5.*. The metrics blob is compared to
#             a relative 1e-9 (FFT low bits differ between numpy/scipy builds).
#
# Recapture is only ever legitimate alongside a deliberate algorithm change and its
# DIAG_VERSION bump, and it goes through the committed, reviewable script rather than an
# ad-hoc session:
#     py -3 tests/scripts/diag/regenerate_goldens.py --diff     # what would move, and why
#     py -3 tests/scripts/diag/regenerate_goldens.py --write    # only once --diff is explained
# Record the moved-column list here and in the commit message. A column that moves which the
# change does not explain is a regression, not a recapture.
#
# A recaptured fixture can only prove the pipeline reproduces ITSELF, so the properties the
# v9 change actually claims are pinned independently, in test_assign_by_neighbours.py's
# pipeline-level cases -- those survive any future recapture.

_FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
GOLDEN_DEFAULT = os.path.join(_FIXTURES, "golden_default_recipe.npz")
GOLDEN_ENVELOPE = os.path.join(_FIXTURES, "golden_envelope.npz")


def assert_columns_match_golden(cols, metrics, golden_path, nondegenerate=()):
    """Assert (cols, metrics) reproduce the frozen golden reference byte-for-byte.

    `nondegenerate` names columns whose golden side MUST contain a nonzero value -- the
    canary that catches a fixture regenerated from a broken pipeline emitting zeros, which
    would otherwise let a zeros-vs-zeros comparison pass while verifying nothing. The
    assertion is on the GOLDEN side deliberately: the claim is "this fixture is
    non-degenerate", not "this run is".
    """
    golden = np.load(golden_path, allow_pickle=False)
    expected = {k: golden[k] for k in golden.files if not k.startswith("__")}
    for name in nondegenerate:
        assert (
            np.count_nonzero(golden[name]) > 0
        ), f"golden {name!r} is degenerate -- fixture regenerated from a broken pipeline?"
    # The frozen fixture predates every column a step OFF the default recipe still
    # contributes at its neutral default (segment_id, Phase F; inverted/grid_fill/
    # grid_support/gmm_id/gmm_prob, Phase H slice 2 -- see runner.py::PUBLIC_COLUMNS). Every
    # column the fixture DOES contain must still be present and byte-identical; a column the
    # run adds beyond the fixture is allowed only if it is one of these, at its documented
    # neutral value.
    missing = set(expected) - set(cols)
    assert not missing, f"columns dropped vs the frozen reference: {missing}"
    neutral_extra = {
        "segment_id": -1.0,
        "gmm_id": -1.0,
        "inverted": 0.0,
        "grid_fill": 0.0,
        "grid_support": 0.0,
        "gmm_prob": 0.0,
    }
    extra = set(cols) - set(expected)
    assert extra <= set(
        neutral_extra
    ), f"unexpected columns beyond the reference: {extra}"
    for name in extra:
        assert np.all(
            cols[name] == neutral_extra[name]
        ), f"default-path {name!r} must be all {neutral_extra[name]}"
    for name, want in expected.items():
        got = cols[name]
        assert got.dtype == want.dtype, f"column {name!r} dtype drifted"
        np.testing.assert_array_equal(
            got, want, err_msg=f"column {name!r} differs from the golden reference"
        )
    # The metrics blob is frozen too: analyse() emits columns AND a JSON-serialisable
    # metrics dict, and the runner must reproduce both. Stored as repr(sorted(items())).
    assert metrics_match(
        metrics, str(golden["__metrics__"])
    ), "metrics payload differs from the golden reference"


def _close(a, b, rtol=1e-9):
    """Structural equality; floats compare to a relative 1e-9 (the Welch spectrum in the
    metrics moves in its last digits between FFT builds; the columns do not)."""
    if isinstance(a, float) or isinstance(b, float):
        return bool(np.isclose(a, b, rtol=rtol, atol=0.0, equal_nan=True))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_close(a[k], b[k]) for k in a)
    if isinstance(a, list | tuple) and isinstance(b, list | tuple):
        return len(a) == len(b) and all(_close(x, y) for x, y in zip(a, b, strict=True))
    return a == b


def metrics_match(metrics, golden_repr: str) -> bool:
    import ast

    return _close(sorted(metrics.items()), ast.literal_eval(golden_repr))
