"""Cache key choice: the crawler's content hash when it has one, else a provisional key from stat."""

import pytest

from app.lib.cache_key import cache_key, object_keys

FILE = "5d1d6a52-2f3a-4c0e-bd0b-7a1a4f0f9c01"
SHA = "ab" * 32


def test_a_done_fingerprint_gives_the_content_hash():
    assert cache_key(FILE, {"status": "done", "content_sha256": SHA}, 1000, 1.7e9) == SHA


def test_the_hash_is_the_key_whatever_the_size_and_mtime():
    fp = {"status": "done", "content_sha256": SHA, "size_bytes": 1000}
    assert cache_key(FILE, fp, 1000, 1) == cache_key(FILE, fp, 1000, 2)


def test_no_fingerprint_gives_the_provisional_key():
    assert cache_key(FILE, None, 1234, 1700000000.9) == f"p-{FILE}-1234-1700000000"


@pytest.mark.parametrize("status", ["error", "missing"])
def test_a_fingerprint_that_is_not_done_is_ignored(status):
    fp = {"status": status, "content_sha256": SHA}
    assert cache_key(FILE, fp, 5, 6) == f"p-{FILE}-5-6"


@pytest.mark.parametrize("sha", [None, "", "XYZ", "AB" * 32, "ab" * 31])
def test_a_done_fingerprint_with_no_valid_hash_is_ignored(sha):
    assert cache_key(FILE, {"status": "done", "content_sha256": sha}, 5, 6) == f"p-{FILE}-5-6"


def test_a_fingerprint_for_a_different_size_is_stale():
    fp = {"status": "done", "content_sha256": SHA, "size_bytes": 999}
    assert cache_key(FILE, fp, 1000, 6) == f"p-{FILE}-1000-6"


def test_a_fingerprint_without_a_recorded_size_is_trusted():
    assert cache_key(FILE, {"status": "done", "content_sha256": SHA, "size_bytes": None}, 1000, 6) == SHA


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
