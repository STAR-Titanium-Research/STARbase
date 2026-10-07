"""D1LC v2 trailer: parse -> serialise must not drop the named extra columns."""

import importlib.util
import struct
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.d1lc import MAGIC, parse, serialise  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
BACKEND_D1LC = REPO / "apps" / "force-app" / "backend" / "app" / "d1lc.py"


def build(n=100, extras=None, version=None):
    rng = np.random.default_rng(0)
    arrs = [rng.standard_normal(n).astype("<f4") for _ in range(6)]
    v = version if version is not None else (2 if extras else 1)
    head = struct.pack("<IIIfffff", MAGIC, v, n, 1000.0, 0.1, 10.0, 0.0, 1.0)
    buf = head + b"".join(a.tobytes() for a in arrs)
    if extras:
        buf += struct.pack("<I", len(extras))
        for name, arr in extras.items():
            buf += name.encode("ascii").ljust(8, b"\x00") + arr.astype("<f4").tobytes()
    return buf


def extras_of(n):
    rng = np.random.default_rng(7)
    return {k: rng.standard_normal(n).astype("<f4") for k in ("Mz", "X", "Y", "Z")}


def test_v1_roundtrip_is_byte_identical():
    buf = build(50)
    assert serialise(parse(buf)) == buf


def test_v2_trailer_is_parsed_and_roundtrips_byte_identically():
    ex = extras_of(80)
    buf = build(80, ex)
    c = parse(buf)
    assert list(c.extras) == ["Mz", "X", "Y", "Z"]
    for k, v in ex.items():
        np.testing.assert_array_equal(c.extras[k], v)
    assert serialise(c) == buf


def test_strided_serialise_strides_the_trailer_too():
    ex = extras_of(100)
    c = parse(build(100, ex))
    out = parse(serialise(c, stride=3))
    assert out.n == 34
    for k, v in ex.items():
        np.testing.assert_array_equal(out.extras[k], v[::3])
    np.testing.assert_array_equal(out.fx, c.fx[::3])


def test_unknown_trailer_names_are_preserved():
    ex = {"Mz": np.arange(10, dtype="<f4"), "FUTURE": np.ones(10, dtype="<f4")}
    buf = build(10, ex)
    assert serialise(parse(buf)) == buf


def test_truncated_trailer_keeps_complete_arrays_only():
    ex = extras_of(10)
    buf = build(10, ex)
    c = parse(buf[: -(10 * 4 + 5)])  # cut into the last array
    assert list(c.extras) == ["Mz", "X", "Y"]


def test_version2_header_with_no_trailer_is_ok():
    c = parse(build(10, version=2))
    assert c.extras == {}


def test_filtering_leaves_extras_untouched(monkeypatch):
    import app.main as m

    c = parse(build(2000, extras_of(2000)))
    fc, _ = m._filtered(c, {"lowpass": {"on": True, "cutoff_hz": 100, "order": 2}})
    assert not np.array_equal(fc.fz, c.fz)  # the chain did run
    for k in c.extras:
        np.testing.assert_array_equal(fc.extras[k], c.extras[k])
    assert parse(serialise(fc)).extras.keys() == c.extras.keys()


@pytest.mark.skipif(not BACKEND_D1LC.exists(), reason="backend reference not present")
def test_matches_the_backend_writer_byte_for_byte(tmp_path):
    spec = importlib.util.spec_from_file_location("backend_d1lc", BACKEND_D1LC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    n = 64
    rng = np.random.default_rng(3)
    cols = [rng.standard_normal(n).astype("<f4") for _ in range(6)]
    extras = extras_of(n)
    for ex in (None, extras):
        path = tmp_path / "w.d1lc"
        mod.write_d1lc(str(path), *cols, 1000.0, 0.1, 10.0, 0.0, 1.0, extras=ex)
        raw = path.read_bytes()
        assert serialise(parse(raw)) == raw
