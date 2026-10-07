"""/captures/browse runs in the threadpool: pruning its cache must survive concurrent inserts."""

from __future__ import annotations

import threading

import pytest

from app import main


@pytest.fixture(autouse=True)
def _clean(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    main._BROWSE_CACHE.clear()
    yield
    main._BROWSE_CACHE.clear()


def test_prune_drops_only_stale_entries_of_this_root(tmp_path):
    root = str(tmp_path)
    keep, gone = f"{root}/keep", f"{root}/gone"
    elsewhere = "/somewhere/else/x"
    for k in (keep, gone, elsewhere):
        main._BROWSE_CACHE[k] = ((1, 2, 3), {})
    main._prune_browse_cache({keep})
    assert set(main._BROWSE_CACHE) == {keep, elsewhere}


def test_prune_survives_concurrent_inserts(tmp_path):
    root = str(tmp_path)
    stop = threading.Event()

    def writer() -> None:
        # What a concurrent /captures/browse request does: add entries as it scans.
        n = 0
        while not stop.is_set():
            with main._BROWSE_CACHE_LOCK:
                main._BROWSE_CACHE[f"{root}/new-{n}"] = ((1, 2, 3), {})
            n += 1

    t = threading.Thread(target=writer)
    t.start()
    errors: list[BaseException] = []
    try:
        for _ in range(40):
            try:
                with main._BROWSE_CACHE_LOCK:
                    for i in range(20_000):  # real work for each pass to iterate
                        main._BROWSE_CACHE.setdefault(f"{root}/stale-{i}", ((1, 2, 3), {}))
                main._prune_browse_cache(set())
            except RuntimeError as e:  # "dictionary changed size during iteration"
                errors.append(e)
                break
    finally:
        stop.set()
        t.join()
    assert not errors, errors
