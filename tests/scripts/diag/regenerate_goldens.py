"""Recapture the two frozen golden fixtures from the CURRENT pipeline.

Run this ONLY when an algorithm change is intentional and the DIAG_VERSION bump that goes
with it has been decided. The fixtures are the equivalence gate between pipeline.analyse()
and the recipe runner; regenerating them to make an unexplained failure go green destroys
the only evidence a refactor was safe. See the comment block in conftest.py.

Before regenerating, run the diff mode to see exactly which columns move:

    py -3 tests/scripts/diag/regenerate_goldens.py --diff

and record that list in the commit message and in conftest.py's provenance note. If a column
moves that the change does not explain, stop -- that is a regression, not a recapture.

    py -3 tests/scripts/diag/regenerate_goldens.py --write
"""

from __future__ import annotations

import argparse
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "scripts"))
sys.path.insert(0, os.path.dirname(__file__))

from conftest import (  # noqa: E402
    GOLDEN_DEFAULT,
    GOLDEN_ENVELOPE,
    SPR,
    cache_of,
    metrics_match,
    synthetic_cut,
)
from diag.pipeline import analyse  # noqa: E402

# The exact call each golden was captured from. Keep in step with the tests that consume
# them: test_pipeline.py::test_analyse_default_reproduces_the_frozen_golden_exactly and
# ::test_analyse_with_fn_hz_reproduces_the_frozen_envelope_golden_exactly.
CAPTURES = (
    (GOLDEN_DEFAULT, {"samples_per_rev": SPR}),
    (GOLDEN_ENVELOPE, {"samples_per_rev": SPR, "fn_hz": 1000.0}),
)


def _run(kwargs: dict):
    t, fx, fy, fz, rpm, revs, x, y, fs, _hit = synthetic_cut()
    return analyse(cache_of(t, fx, fy, fz, rpm, revs, fs), x, y, **kwargs)


def diff() -> int:
    moved_any = False
    for path, kwargs in CAPTURES:
        print("=" * 72)
        print(f"{os.path.basename(path)}  {kwargs}")
        golden = np.load(path, allow_pickle=False)
        cols, metrics = _run(kwargs)
        moved = False
        for name in sorted(k for k in golden.files if not k.startswith("__")):
            want, got = golden[name], cols[name]
            if np.array_equal(got, want):
                continue
            moved = moved_any = True
            n = int(np.count_nonzero(got != want))
            print(
                f"  {name:12s} {n:6d}/{want.size} differ ({100 * n / want.size:.2f}%)"
            )
            if name == "cluster_id":
                print(f"      labels before={sorted(set(want.tolist()))}")
                print(f"      labels after ={sorted(set(got.tolist()))}")
            else:
                d = np.abs(got.astype(np.float64) - want.astype(np.float64))
                print(f"      max|delta|={np.nanmax(d):.6g}")
        if not metrics_match(metrics, str(golden["__metrics__"])):
            moved = moved_any = True
            print("  __metrics__  differs")
        if not moved:
            print("  (every column and the metrics blob are byte-identical)")
    return 1 if moved_any else 0


def write() -> int:
    for path, kwargs in CAPTURES:
        cols, metrics = _run(kwargs)
        payload = dict(cols)
        payload["__metrics__"] = np.array(repr(sorted(metrics.items())))
        np.savez_compressed(path, **payload)
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--diff", action="store_true", help="report what would change")
    ap.add_argument("--write", action="store_true", help="overwrite the fixtures")
    args = ap.parse_args()
    if args.write:
        raise SystemExit(write())
    raise SystemExit(diff())
