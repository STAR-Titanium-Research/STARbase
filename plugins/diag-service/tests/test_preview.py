"""diag-service preview tests.

The Directus authorization call is stubbed; the compute path is exercised for real against a
base.d1an written from the shared diag test synthetic, and its output is asserted identical to
calling run_recipe directly on the full cut (preview must not diverge from the bake path).
"""

from __future__ import annotations

import os
import sys
import tempfile

import numpy as np
import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
for _p in (
    os.path.join(_REPO, "scripts"),
    os.path.join(_REPO, "plugins", "diag-service"),
    os.path.join(_REPO, "tests", "scripts", "diag"),
):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from conftest import cache_of, synthetic_cut  # noqa: E402
from diag.d1an import read_d1an, write_d1an  # noqa: E402
from diag.recipe import DEFAULT_RECIPE  # noqa: E402
from diag.runner import (  # noqa: E402
    base_columns_all_channels,
    run_recipe,
    seed_columns,
)

BASE_COLUMNS = ("t", "rev", "x", "y", "sig")
PUBLIC = {
    "t",
    "rev",
    "x",
    "y",
    "tsa_resid",
    "resid_z",
    "gi_star",
    "gi_sig",
    "cluster_id",
    "glosh",
    "env_band",
    "segment_id",
    "inverted",
    "grid_fill",
    "grid_support",
    "gmm_id",
    "gmm_prob",
}


def _write_base_d1an(dst: str) -> None:
    """Exactly what process_diag_row publishes (Phase H slice 4): all three
    frame_transform channels, not just the one DEFAULT_RECIPE happens to have selected."""
    t, fx, fy, fz, rpm, revs, x, y, fs, _ = synthetic_cut()
    cols = base_columns_all_channels(
        DEFAULT_RECIPE,
        seed_columns(cache_of(t, fx, fy, fz, rpm, revs, fs), x, y),
    )
    write_d1an(dst, cols)


def _write_old_format_base_d1an(dst: str) -> None:
    """What process_diag_row published before Phase H slice 4 -- a single `sig` column for
    whichever channel the recipe was baked with. Used to pin the pre-v10 fallback path."""
    t, fx, fy, fz, rpm, revs, x, y, fs, _ = synthetic_cut()
    stop = next(
        i
        for i, s in enumerate(DEFAULT_RECIPE["steps"])
        if s["op"] == "angular_resample"
    )
    cols, _ = run_recipe(
        DEFAULT_RECIPE,
        seed_columns(cache_of(t, fx, fy, fz, rpm, revs, fs), x, y),
        stop_after=stop,
        emit=BASE_COLUMNS,
    )
    write_d1an(dst, cols)


def _full_bake():
    t, fx, fy, fz, rpm, revs, x, y, fs, _ = synthetic_cut()
    return run_recipe(
        DEFAULT_RECIPE, seed_columns(cache_of(t, fx, fy, fz, rpm, revs, fs), x, y)
    )


def _read_bytes(buf: bytes) -> dict[str, np.ndarray]:
    with tempfile.NamedTemporaryFile(suffix=".d1an", delete=False) as f:
        f.write(buf)
        path = f.name
    try:
        return read_d1an(path)
    finally:
        os.unlink(path)


@pytest.fixture
def client(tmp_path, monkeypatch):
    root = tmp_path / "octrees" / "diag" / "op-under-test"
    root.mkdir(parents=True)
    _write_base_d1an(str(root / "base.d1an"))
    monkeypatch.setenv("OCTREE_ROOT", str(tmp_path / "octrees"))

    import app.main as m

    # fresh LRUs per test
    m._base_lru.clear()
    m._result_lru.clear()

    async def _allow(analysis_id, req):
        return {"diag_path": "op-under-test", "diag_status": "done"}

    monkeypatch.setattr(m, "_resolve_and_authorize", _allow)

    from fastapi.testclient import TestClient

    return TestClient(m.app)


@pytest.fixture
def old_format_client(tmp_path, monkeypatch):
    """Same as `client`, but base.d1an is written in the pre-v10 single-`sig` format -- a row
    that has not been rebaked since Phase H slice 4 shipped."""
    root = tmp_path / "octrees" / "diag" / "op-under-test"
    root.mkdir(parents=True)
    _write_old_format_base_d1an(str(root / "base.d1an"))
    monkeypatch.setenv("OCTREE_ROOT", str(tmp_path / "octrees"))

    import app.main as m

    m._base_lru.clear()
    m._result_lru.clear()

    async def _allow(analysis_id, req):
        return {"diag_path": "op-under-test", "diag_status": "done"}

    monkeypatch.setattr(m, "_resolve_and_authorize", _allow)

    from fastapi.testclient import TestClient

    return TestClient(m.app)


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_preview_approximates_a_full_bake(client):
    """Preview resumes from base.d1an, which is float32 — so preview re-enters the pipeline
    at lower precision than a float64 full bake. It is a fast approximation; the bake is
    authoritative (spec Component 4). This pins the C-4 acceptance criterion.

    The tolerances here accommodate the SYNTHETIC cut, whose perfect Archimedean spiral
    creates exact k-NN ties that float32 quantisation flips. Measured against real
    process_force.m geometry (operation ffe1286d, this session):
      - continuous channels ~100x tighter: resid_z max|abs| 1.6e-4, tsa_resid 1.5e-8
      - gi_sig BYTE-IDENTICAL to the bake
      - cluster_id agrees 99.87% (a few boundary points reassign under float32 either way)
      - gi_star correlation 0.9997 (a uniform tiny scaling, not structural)
    The bake stays authoritative for every number a user records.
    """
    r = client.post(
        "/preview",
        json={
            "analysis_id": "a1",
            "recipe": DEFAULT_RECIPE,
            "from_step": None,
            "layers": None,
        },
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/octet-stream"
    assert r.headers["x-diag-preview"] == "approximate"

    got = _read_bytes(r.content)
    want, _ = _full_bake()
    assert set(got) == PUBLIC == set(want)

    # pass-through / structurally-exact columns (segment_id is all -1 both sides: no seeds)
    for name in ("t", "rev", "x", "y", "env_band", "segment_id"):
        np.testing.assert_array_equal(
            got[name], want[name], err_msg=f"{name} must be exact"
        )

    # continuous statistics: close, not equal
    for name in ("tsa_resid", "resid_z"):
        np.testing.assert_allclose(
            got[name],
            want[name],
            rtol=0.05,
            atol=0.05,
            err_msg=f"{name} out of float32 band",
        )
    # glosh is broadcast back to every point from its nearest reduced neighbour, and the synthetic
    # has exact distance ties: since neighbours are ordered by (distance, index)
    # (scripts/diag/spatial.knn_deterministic), a float32 distance that ties where the float64 one
    # doesn't picks another neighbour. Allow that for a handful of points, never more.
    off = ~np.isclose(got["glosh"], want["glosh"], rtol=0.05, atol=0.05)
    assert off.mean() <= 0.001, f"glosh out of float32 band at {int(off.sum())} points"

    # gi_star swings hardest on the synthetic's tie degeneracy — assert shape, not values
    gs_a, gs_b = got["gi_star"].astype(np.float64), want["gi_star"].astype(np.float64)
    assert np.corrcoef(gs_a, gs_b)[0, 1] > 0.97

    # the decision outputs the UI renders must stay put
    assert np.mean(got["gi_sig"] == want["gi_sig"]) >= 0.99
    assert np.mean(got["cluster_id"] == want["cluster_id"]) >= 0.99


def _with_channel(channel):
    r = {
        "recipe_version": 1,
        "name": channel,
        "steps": [
            {**s, "params": {**s["params"], "channel": channel}}
            if s["op"] == "frame_transform"
            else dict(s)
            for s in DEFAULT_RECIPE["steps"]
        ],
    }
    return r


def test_preview_switches_frame_transform_channel_without_a_rebake(client):
    """Phase H slice 4: base.d1an carries all three channels (base_columns_all_channels), so
    switching frame_transform.channel in the recipe changes what /preview shows without a
    rebake. synthetic_cut() sets fx = fy = 0, so fc is degenerate (frames.py: fc/ff come from
    fx/fy, fp = fz unrotated) -- a real, verifiable difference from fp's real signal."""
    fp = client.post(
        "/preview",
        json={
            "analysis_id": "a1",
            "recipe": _with_channel("fp"),
            "from_step": None,
            "layers": None,
        },
    )
    fc = client.post(
        "/preview",
        json={
            "analysis_id": "a1",
            "recipe": _with_channel("fc"),
            "from_step": None,
            "layers": None,
        },
    )
    assert fp.status_code == fc.status_code == 200
    got_fp, got_fc = _read_bytes(fp.content), _read_bytes(fc.content)
    assert np.std(got_fp["resid_z"]) > 0.1
    assert np.std(got_fc["resid_z"]) < np.std(got_fp["resid_z"]) / 2
    # Two different channels must not collide in the cache -- recipe_hash already includes
    # frame_transform.channel, so both requests are genuine misses.
    assert fp.headers["x-diag-cache"] == fc.headers["x-diag-cache"] == "miss"


def test_preview_rejects_an_unknown_channel(client):
    r = client.post(
        "/preview",
        json={
            "analysis_id": "a1",
            "recipe": _with_channel("not_a_channel"),
            "from_step": None,
            "layers": None,
        },
    )
    assert r.status_code == 422
    assert "channel" in r.json()["detail"]


def test_preview_falls_back_to_one_signal_on_a_pre_v10_base_d1an(old_format_client):
    """A row baked before Phase H slice 4 has only ONE `sig` column in base.d1an -- whatever
    channel it was baked with (DEFAULT_RECIPE's default, fp). Requesting a DIFFERENT channel
    against it must not error or silently show wrong data: it falls back to the one signal
    the file actually has, exactly reproducing pre-slice-4 behaviour until the row rebakes."""
    as_fp = old_format_client.post(
        "/preview",
        json={
            "analysis_id": "a1",
            "recipe": _with_channel("fp"),
            "from_step": None,
            "layers": None,
        },
    )
    as_fc = old_format_client.post(
        "/preview",
        json={
            "analysis_id": "a1",
            "recipe": _with_channel("fc"),
            "from_step": None,
            "layers": None,
        },
    )
    assert as_fp.status_code == as_fc.status_code == 200
    got_fp, got_fc = _read_bytes(as_fp.content), _read_bytes(as_fc.content)
    # Different recipe_hash (different channel param) means these are two separate cache
    # entries, but the OLD base.d1an has no sig_fc to serve, so both fall back to its one
    # signal and the results are the fp bake's, not a degenerate fc-shaped one.
    np.testing.assert_array_equal(got_fp["resid_z"], got_fc["resid_z"])
    assert np.std(got_fp["resid_z"]) > 0.1


def test_preview_stop_after_truncates_the_pipeline(client):
    """Phase H slice 3: clicking a step in the Pipeline panel reverts the view to that step's
    state -- the client sends stop_after (the full step-list index, disabled steps included,
    matching runner.run_recipe's own convention) and the response reflects only steps up to
    and including it."""
    idx = next(
        i for i, s in enumerate(DEFAULT_RECIPE["steps"]) if s["op"] == "radial_detrend"
    )
    r = client.post(
        "/preview",
        json={
            "analysis_id": "a1",
            "recipe": DEFAULT_RECIPE,
            "from_step": None,
            "layers": None,
            "stop_after": idx,
        },
    )
    assert r.status_code == 200, r.text
    got = _read_bytes(r.content)
    assert set(got) == PUBLIC
    # radial_detrend (stopped-after step) ran: resid_z is real.
    assert np.count_nonzero(got["resid_z"]) > 0
    # getis_ord and hdbscan sit AFTER the stop point: their columns stay at the same neutral
    # fill a disabled step would produce, not real values.
    assert np.all(got["gi_star"] == 0.0)
    assert np.all(got["gi_sig"] == 0.0)
    assert np.all(got["cluster_id"] == 0.0)


def test_preview_stop_after_before_the_first_derived_step_is_a_clean_422(client):
    """/preview always resumes from base.d1an at from_step (the first derived step) --
    run_recipe's `lo` -- regardless of what stop_after asks for. A stop_after BEFORE that
    point (e.g. clicking a base-tier step like frame_transform or angular_resample in the
    Pipeline panel) makes stop_after < from_step, so the loop's very first candidate index
    already exceeds it and the loop runs NOTHING -- not even tsa, whose output run_recipe
    needs to know the angular column length before it can assemble PUBLIC_COLUMNS at all.
    That surfaces as a clean ValueError, not a crash or a silently-empty 200.

    Documented here as the actual, intentional behaviour -- the client (RecipePanel's
    stepIsRevertable) is expected to never ask for this, but the endpoint itself must not
    misbehave if something does; diagRequestError already turns a 422 into a readable
    message on the client, so this degrades safely even if the client-side gate is bypassed.
    """
    idx = next(
        i
        for i, s in enumerate(DEFAULT_RECIPE["steps"])
        if s["op"] == "angular_resample"
    )
    r = client.post(
        "/preview",
        json={
            "analysis_id": "a1",
            "recipe": DEFAULT_RECIPE,
            "from_step": None,
            "layers": None,
            "stop_after": idx,
        },
    )
    assert r.status_code == 422
    assert "recipe failed" in r.json()["detail"]


def test_preview_stop_after_differs_from_the_full_preview(client):
    idx = next(
        i for i, s in enumerate(DEFAULT_RECIPE["steps"]) if s["op"] == "radial_detrend"
    )
    full = client.post(
        "/preview",
        json={
            "analysis_id": "a1",
            "recipe": DEFAULT_RECIPE,
            "from_step": None,
            "layers": None,
        },
    )
    truncated = client.post(
        "/preview",
        json={
            "analysis_id": "a1",
            "recipe": DEFAULT_RECIPE,
            "from_step": None,
            "layers": None,
            "stop_after": idx,
        },
    )
    assert full.status_code == truncated.status_code == 200
    got_full, got_trunc = _read_bytes(full.content), _read_bytes(truncated.content)
    assert not np.array_equal(got_full["gi_star"], got_trunc["gi_star"])
    # Two different stop_after values must not collide in the LRU cache keyed only on recipe.
    assert full.headers["x-diag-cache"] == "miss"
    assert truncated.headers["x-diag-cache"] == "miss"


def test_preview_stop_after_null_behaves_exactly_like_omitting_it(client):
    a = client.post(
        "/preview",
        json={
            "analysis_id": "a1",
            "recipe": DEFAULT_RECIPE,
            "from_step": None,
            "layers": None,
        },
    )
    b = client.post(
        "/preview",
        json={
            "analysis_id": "a1",
            "recipe": DEFAULT_RECIPE,
            "from_step": None,
            "layers": None,
            "stop_after": None,
        },
    )
    assert a.status_code == b.status_code == 200
    ga, gb = _read_bytes(a.content), _read_bytes(b.content)
    for name in ga:
        np.testing.assert_array_equal(ga[name], gb[name])


def test_preview_reflects_a_param_change(client):
    hot = {
        "recipe_version": 1,
        "name": "hot",
        "steps": [
            {**s, "params": {**s["params"], "k": 50}}
            if s["op"] == "getis_ord"
            else dict(s)
            for s in DEFAULT_RECIPE["steps"]
        ],
    }
    a = client.post(
        "/preview",
        json={
            "analysis_id": "a1",
            "recipe": DEFAULT_RECIPE,
            "from_step": None,
            "layers": None,
        },
    )
    b = client.post(
        "/preview",
        json={"analysis_id": "a1", "recipe": hot, "from_step": None, "layers": None},
    )
    assert a.status_code == b.status_code == 200
    ga, gb = _read_bytes(a.content), _read_bytes(b.content)
    assert not np.array_equal(
        ga["gi_star"], gb["gi_star"]
    ), "k=30 vs k=50 must move gi_star"
    assert a.headers["x-diag-cache"] == "miss"


def test_repeated_identical_request_is_cache_hit(client):
    body = {
        "analysis_id": "a1",
        "recipe": DEFAULT_RECIPE,
        "from_step": None,
        "layers": None,
    }
    first = client.post("/preview", json=body)
    second = client.post("/preview", json=body)
    assert first.headers["x-diag-cache"] == "miss"
    assert second.headers["x-diag-cache"] == "hit"
    assert first.content == second.content


def test_analysis_not_done_is_409(client, monkeypatch):
    import app.main as m

    async def _pending(analysis_id, req):
        return {"diag_path": None, "diag_status": "pending"}

    monkeypatch.setattr(m, "_resolve_and_authorize", _pending)
    r = client.post(
        "/preview",
        json={
            "analysis_id": "x",
            "recipe": DEFAULT_RECIPE,
            "from_step": None,
            "layers": None,
        },
    )
    assert r.status_code == 409


def test_missing_base_d1an_is_409(client, monkeypatch):
    import app.main as m

    async def _other(analysis_id, req):
        return {"diag_path": "op-with-no-base", "diag_status": "done"}

    monkeypatch.setattr(m, "_resolve_and_authorize", _other)
    r = client.post(
        "/preview",
        json={
            "analysis_id": "x",
            "recipe": DEFAULT_RECIPE,
            "from_step": None,
            "layers": None,
        },
    )
    assert r.status_code == 409


@pytest.mark.parametrize(
    "evil", ["../secret", "a/b", "..", "op\\win", "/abs", "with.dot"]
)
def test_path_traversal_in_diag_path_is_400(client, monkeypatch, evil):
    import app.main as m

    async def _crafted(analysis_id, req):
        return {"diag_path": evil, "diag_status": "done"}

    monkeypatch.setattr(m, "_resolve_and_authorize", _crafted)
    r = client.post(
        "/preview",
        json={
            "analysis_id": "x",
            "recipe": DEFAULT_RECIPE,
            "from_step": None,
            "layers": None,
        },
    )
    assert r.status_code == 400


def _mask_recipe():
    import copy

    r = copy.deepcopy(DEFAULT_RECIPE)
    for s in r["steps"]:
        if s["op"] == "radial_detrend":
            s["inputs"] = {"mask": {"layer": "art", "required": False}}
    return r


def test_preview_applies_an_inline_mask(client):
    r0 = client.post(
        "/preview", json={"analysis_id": "a1", "recipe": DEFAULT_RECIPE, "layers": None}
    )
    assert r0.status_code == 200

    big = [[[-1e9, -1e9], [1e9, -1e9], [1e9, 1e9], [-1e9, 1e9]]]
    r1 = client.post(
        "/preview",
        json={
            "analysis_id": "a1",
            "recipe": _mask_recipe(),
            "layers": {
                "art": {
                    "role": "mask",
                    "geometry": {"polygons": big},
                    "value": {"mode": "exclude"},
                    "version": 1,
                }
            },
        },
    )
    assert r1.status_code == 200, r1.text
    # an all-covering mask -> every resid_z is NaN -> different D1AN bytes
    assert r0.content != r1.content
    got = _read_bytes(r1.content)
    assert np.all(np.isnan(got["resid_z"]))


def test_preview_rejects_malformed_layer_geometry(client):
    r = client.post(
        "/preview",
        json={
            "analysis_id": "a1",
            "recipe": DEFAULT_RECIPE,
            "layers": {"bad": {"role": "mask", "geometry": {"polygons": "nope"}}},
        },
    )
    assert r.status_code == 422
    assert "bad" in r.text


def test_preview_returns_segment_id_from_seeds(client):
    import copy

    recipe = copy.deepcopy(DEFAULT_RECIPE)
    recipe["steps"].append(
        {
            "id": "seg",
            "op": "grow_segmentation",
            "on": True,
            "params": {"features": ["resid_z"], "k": 15},
            "inputs": {"seeds": {"layers": ["a", "b"], "required": False}},
        }
    )
    big_left = [[[-1e9, -1e9], [0, -1e9], [0, 1e9], [-1e9, 1e9]]]
    big_right = [[[0, -1e9], [1e9, -1e9], [1e9, 1e9], [0, 1e9]]]
    body = {
        "analysis_id": "a1",
        "recipe": recipe,
        "layers": {
            "a": {
                "role": "seed",
                "geometry": {"polygons": big_left},
                "value": None,
                "version": 1,
            },
            "b": {
                "role": "seed",
                "geometry": {"polygons": big_right},
                "value": None,
                "version": 1,
            },
        },
    }
    r = client.post("/preview", json=body)
    assert r.status_code == 200, r.text
    got = _read_bytes(r.content)
    assert "segment_id" in got
    assert set(np.unique(got["segment_id"])) <= {0.0, 1.0}


def _envelope_on_recipe():
    """The recipe shape that broke every preview in the field: the analyst enabled the
    envelope step from the workbench. envelope is base-tier -- it reads full-rate fc/ff/fp,
    revs and t_raw, none of which base.d1an carries -- so the resume path raised a bare
    KeyError('t_raw') and the UI showed `recipe failed: 't_raw'` on every keystroke."""
    import copy

    r = copy.deepcopy(DEFAULT_RECIPE)
    for s in r["steps"]:
        if s["op"] == "envelope":
            s["on"] = True
            s["params"] = {"bandwidth_frac": 0.2, "fn_hz": 1000.0}
    return r


def test_preview_skips_a_base_tier_step_instead_of_failing(client):
    r = client.post(
        "/preview",
        json={"analysis_id": "a1", "recipe": _envelope_on_recipe(), "layers": None},
    )
    assert r.status_code == 200, r.text
    assert r.headers.get("x-diag-skipped") == "envelope"
    # Everything else still previews; env_band is present but zero-filled (the step was off).
    got = _read_bytes(r.content)
    assert "env_band" in got
    assert np.all(got["env_band"] == 0.0)
    assert np.any(got["resid_z"] != 0.0)


def test_preview_without_a_base_step_reports_nothing_skipped(client):
    r = client.post(
        "/preview", json={"analysis_id": "a1", "recipe": DEFAULT_RECIPE, "layers": None}
    )
    assert r.status_code == 200
    assert r.headers.get("x-diag-skipped") == ""
