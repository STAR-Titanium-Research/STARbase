"""scripts/file_fingerprints.py: the whole-file hash and the decoded-force-array hash (stage T0e).

Pure: no database. `.mat` fixtures are written into tmp_path, v5 with scipy and v7.3 with h5py
(HDF5 stores the MATLAB array transposed, behind a 512-byte header).
"""

import hashlib
import io
import struct
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest

h5py = pytest.importorskip("h5py")
scipy_io = pytest.importorskip("scipy.io")

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import file_fingerprints as ff  # noqa: E402


def write_v73(path, name, a, **extra):
    """A MATLAB-v7.3-shaped file: 512-byte header, then HDF5 holding each array transposed."""
    with h5py.File(path, "w", userblock_size=512) as f:
        f.create_dataset(name, data=np.asarray(a).T)
        for k, v in extra.items():
            f.create_dataset(k, data=np.asarray(v).T)
    with open(path, "r+b") as f:  # h5py leaves the userblock zeroed
        f.seek(0)
        f.write(b"MATLAB 7.3 MAT-file, Platform: test".ljust(512, b"\0"))


def reference(a):
    a = np.asarray(a)
    return hashlib.sha256(
        struct.pack("<QQ", a.shape[0], a.shape[1]) + a.astype("<f8").tobytes(order="F")
    ).hexdigest()


@pytest.fixture
def matrix():
    return np.random.default_rng(7).normal(size=(1000, 4))


def test_v5_and_v73_give_the_same_reference_hash(tmp_path, matrix):
    p5, p73 = tmp_path / "a5.mat", tmp_path / "a73.mat"
    scipy_io.savemat(p5, {"data": matrix})
    write_v73(p73, "data", matrix)
    h5_, var5, r5, c5 = ff.mat_data_sha256(p5)
    h73, var73, r73, c73 = ff.mat_data_sha256(p73)
    assert h5_ == h73 == reference(matrix)
    assert (var5, var73) == ("data", "data")
    assert (r5, c5) == (r73, c73) == (1000, 4)


def test_v73_signature_at_offset_zero_is_accepted(tmp_path, matrix):
    p = tmp_path / "plain.h5"
    with h5py.File(p, "w") as f:
        f.create_dataset("data", data=matrix.T)
    assert ff.mat_data_sha256(p)[0] == reference(matrix)


def test_hdf5_streaming_in_many_blocks_gives_the_same_hash(tmp_path, matrix):
    p = tmp_path / "a73.mat"
    write_v73(p, "data", matrix)
    seen = []

    class Rec(ff.Throttle):
        def consume(self, n):
            seen.append(n)

    h, _, _, _ = ff.mat_data_sha256(p, block_bytes=24, throttle=Rec(None))
    assert h == reference(matrix)
    assert max(seen) == 24 and len(seen) == 4 * (1000 // 3 + 1)
    assert sum(seen) == matrix.size * 8


def test_int16_hashes_as_float64(tmp_path):
    ints = np.arange(40, dtype=np.int16).reshape(10, 4) - 20
    p5, p73 = tmp_path / "i5.mat", tmp_path / "i73.mat"
    scipy_io.savemat(p5, {"data": ints})
    write_v73(p73, "data", ints)
    want = reference(ints.astype(float))
    assert ff.mat_data_sha256(p5)[0] == want
    assert ff.mat_data_sha256(p73)[0] == want


@pytest.mark.parametrize("writer", ["v5", "v73"])
def test_data_is_preferred_over_DATA_and_DATA_is_the_fallback(tmp_path, writer):
    lower, upper = np.ones((5, 2)), np.full((5, 2), 2.0)

    def make(path, **arrays):
        if writer == "v5":
            scipy_io.savemat(path, arrays)
        else:
            (n0, a0), *rest = arrays.items()
            write_v73(path, n0, a0, **dict(rest))

    both, only = tmp_path / "both.mat", tmp_path / "only.mat"
    make(both, data=lower, DATA=upper)
    make(only, DATA=upper)
    h, var, _, _ = ff.mat_data_sha256(both)
    assert (h, var) == (reference(lower), "data")
    h, var, _, _ = ff.mat_data_sha256(only)
    assert (h, var) == (reference(upper), "DATA")


@pytest.mark.parametrize("writer", ["v5", "v73"])
def test_no_force_array_raises(tmp_path, writer):
    p = tmp_path / "none.mat"
    if writer == "v5":
        scipy_io.savemat(p, {"other": np.ones((3, 3))})
    else:
        write_v73(p, "other", np.ones((3, 3)))
    with pytest.raises(ff.NoForceArray):
        ff.mat_data_sha256(p)


@pytest.mark.parametrize("writer", ["v5", "v73"])
def test_three_dimensional_array_raises(tmp_path, writer):
    p = tmp_path / "3d.mat"
    cube = np.ones((3, 4, 2))
    if writer == "v5":
        scipy_io.savemat(p, {"data": cube})
    else:
        write_v73(p, "data", cube)
    with pytest.raises(ff.BadForceArray):
        ff.mat_data_sha256(p)


def test_non_numeric_array_raises(tmp_path):
    p5, p73 = tmp_path / "s5.mat", tmp_path / "s73.mat"
    scipy_io.savemat(p5, {"data": np.array([["a", "b"], ["c", "d"]])})
    with h5py.File(p73, "w", userblock_size=512) as f:
        f.create_dataset("data", data=np.array([[b"a", b"b"], [b"c", b"d"]]))
    for p in (p5, p73):
        with pytest.raises(ff.BadForceArray):
            ff.mat_data_sha256(p)


def test_text_file_named_mat_is_unreadable(tmp_path):
    p = tmp_path / "notes.mat"
    p.write_text("this is not a MATLAB file\n" * 50)
    with pytest.raises(ff.UnreadableMat):
        ff.mat_data_sha256(p)


def test_corrupt_hdf5_is_unreadable(tmp_path, matrix):
    p = tmp_path / "bad73.mat"
    write_v73(p, "data", matrix)
    raw = p.read_bytes()
    p.write_bytes(raw[:600])  # signature intact, superblock/data cut off
    with pytest.raises(ff.UnreadableMat):
        ff.mat_data_sha256(p)


def test_missing_file_is_an_oserror_not_unreadable(tmp_path):
    with pytest.raises(OSError):
        ff.mat_data_sha256(tmp_path / "gone.mat")


def test_metadata_only_change_keeps_data_hash_but_not_content_hash(tmp_path, matrix):
    a, b = tmp_path / "a.mat", tmp_path / "b.mat"
    scipy_io.savemat(a, {"data": matrix})
    scipy_io.savemat(b, {"data": matrix, "info": np.array([1.0, 2.0])})
    assert ff.mat_data_sha256(a)[0] == ff.mat_data_sha256(b)[0]
    assert ff.content_sha256(a)[0] != ff.content_sha256(b)[0]


def test_content_sha256_path_and_stream(tmp_path):
    payload = bytes(range(256)) * 1000
    p = tmp_path / "blob.bin"
    p.write_bytes(payload)
    want = hashlib.sha256(payload).hexdigest()
    assert ff.content_sha256(p) == (want, len(payload))
    assert ff.content_sha256(str(p), chunk=1000) == (want, len(payload))
    assert ff.content_sha256(io.BytesIO(payload), chunk=4096) == (want, len(payload))


def test_content_sha256_uses_the_throttle(tmp_path):
    p = tmp_path / "blob.bin"
    p.write_bytes(b"x" * 2500)
    seen = []

    class Rec(ff.Throttle):
        def consume(self, n):
            seen.append(n)

    ff.content_sha256(p, chunk=1000, throttle=Rec(None))
    assert seen == [1000, 1000, 500]


def test_unlimited_throttle_never_sleeps(monkeypatch):
    monkeypatch.setattr(time, "sleep", lambda s: pytest.fail("slept"))
    t = ff.Throttle(None)
    for _ in range(100):
        t.consume(10**9)


def test_throttle_caps_the_rate_across_threads():
    t = ff.Throttle(1000)  # bytes per second
    t0 = time.monotonic()
    threads = [threading.Thread(target=t.consume, args=(1500,)) for _ in range(2)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    took = time.monotonic() - t0
    assert 1.8 <= took < 5  # 3000 bytes at 1000 B/s: each caller waits out its own bytes: 1.5 s, then 3 s
