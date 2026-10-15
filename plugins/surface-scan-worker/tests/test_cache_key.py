"""Cache key choice: the crawler's content hash when it is current, else a provisional key from stat."""

from datetime import UTC, datetime

import pytest

from app.lib.cache_key import MTIME_TOLERANCE_SECONDS, cache_key, object_keys

FILE = "5d1d6a52-2f3a-4c0e-bd0b-7a1a4f0f9c01"
SHA = "ab" * 32
MTIME = 1_760_000_000.0  # the file's mtime on disk


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, UTC).isoformat()


def _fp(**overrides):
    fp = {
        "status": "done",
        "content_sha256": SHA,
        "size_bytes": 1000,
        "source_mtime": _iso(MTIME),
    }
    fp.update(overrides)
    return fp


def test_a_current_done_fingerprint_gives_the_content_hash():
    assert cache_key(FILE, _fp(), 1000, MTIME) == SHA


def test_the_crawlers_z_suffixed_and_offset_timestamps_are_understood():
    assert cache_key(FILE, _fp(source_mtime="2025-10-09T08:53:20Z"), 1000, MTIME) == SHA
    assert (
        cache_key(FILE, _fp(source_mtime="2025-10-09T09:53:20+01:00"), 1000, MTIME)
        == SHA
    )


def test_a_naive_timestamp_is_read_as_utc():
    assert cache_key(FILE, _fp(source_mtime="2025-10-09T08:53:20"), 1000, MTIME) == SHA


def test_a_file_re_exported_in_place_with_the_same_size_does_not_reuse_the_hash():
    """Same size, new mtime: the old hash describes the old surface."""
    fp = _fp()
    new_mtime = MTIME + 3600
    key = cache_key(FILE, fp, 1000, new_mtime)
    assert key == f"p-{FILE}-1000-{int(new_mtime)}"
    assert key != SHA


def test_mtime_slack_covers_coarse_share_timestamps_but_not_a_real_change():
    assert cache_key(FILE, _fp(), 1000, MTIME + 1.9) == SHA
    assert cache_key(FILE, _fp(), 1000, MTIME - 1.9) == SHA
    assert MTIME_TOLERANCE_SECONDS < 3
    assert cache_key(FILE, _fp(), 1000, MTIME + 5).startswith("p-")


@pytest.mark.parametrize("bad", [None, "", "not a date", 12345])
def test_a_fingerprint_without_a_usable_source_mtime_is_not_trusted(bad):
    assert cache_key(FILE, _fp(source_mtime=bad), 1000, MTIME) == (
        f"p-{FILE}-1000-{int(MTIME)}"
    )


def test_no_fingerprint_gives_the_provisional_key():
    assert cache_key(FILE, None, 1234, 1700000000.9) == f"p-{FILE}-1234-1700000000"


@pytest.mark.parametrize("status", ["error", "missing"])
def test_a_fingerprint_that_is_not_done_is_ignored(status):
    assert cache_key(FILE, _fp(status=status), 1000, MTIME).startswith("p-")


@pytest.mark.parametrize("sha", [None, "", "XYZ", "AB" * 32, "ab" * 31])
def test_a_done_fingerprint_with_no_valid_hash_is_ignored(sha):
    assert cache_key(FILE, _fp(content_sha256=sha), 1000, MTIME).startswith("p-")


def test_a_fingerprint_for_a_different_size_is_stale():
    assert cache_key(FILE, _fp(size_bytes=999), 1000, MTIME) == (
        f"p-{FILE}-1000-{int(MTIME)}"
    )


def test_a_fingerprint_without_a_recorded_size_is_not_trusted():
    assert cache_key(FILE, _fp(size_bytes=None), 1000, MTIME).startswith("p-")


def test_the_provisional_key_changes_when_the_file_is_overwritten_in_place():
    a = cache_key(FILE, None, 1000, 100)
    assert a != cache_key(FILE, None, 1001, 100)
    assert a != cache_key(FILE, None, 1000, 101)


def test_object_keys_layout():
    assert object_keys(SHA) == {
        "grid": f"surface-scans/{SHA}/grid.bin",
        "meta": f"surface-scans/{SHA}/meta.json",
        "thumb": f"surface-scans/{SHA}/thumb.png",
    }
