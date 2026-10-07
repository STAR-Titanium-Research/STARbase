#!/usr/bin/env python3
"""Inspect one force-app capture folder (or every folder under a captures root) and report what
state it is in and anything inconsistent. Read-only, stdlib only.

Usage: inspect_capture.py <capture_dir | captures_root> [--json]

Checks: raw.d1raw header + row count from file size, summary.json fields, live_cache.bin (D1LC)
header, capture.mat presence vs summary.mat_written, sample-count agreement between raw, summary
and cache, tacho, clipping, and the incomplete (no summary) state the recovery banner offers.
"""

import json
import os
import struct
import sys

D1RW_HDR = struct.Struct(
    "<4sIIfd"
)  # magic, version, n_cols, rate, start_unix (+8 pad = 32 B)
D1LC_MAGIC = 0x44314C43


def inspect(d):
    r = {
        "capture": os.path.basename(d.rstrip("/")),
        "path": d,
        "files": {},
        "issues": [],
        "state": "?",
    }
    for f in (
        "raw.d1raw",
        "manifest.json",
        "summary.json",
        "live_cache.bin",
        "capture.mat",
    ):
        p = os.path.join(d, f)
        if os.path.isfile(p):
            r["files"][f] = os.path.getsize(p)

    raw_rows = None
    if "raw.d1raw" in r["files"]:
        with open(os.path.join(d, "raw.d1raw"), "rb") as fh:
            head = fh.read(32)
        if len(head) < 32:
            r["issues"].append("raw.d1raw is shorter than its 32-byte header")
        else:
            magic, ver, ncols, rate, start = D1RW_HDR.unpack_from(head)
            body = r["files"]["raw.d1raw"] - 32
            raw_rows, rem = divmod(body, 4 * ncols) if ncols else (0, body)
            r["raw"] = {
                "magic_ok": magic == b"D1RW",
                "version": ver,
                "n_cols": ncols,
                "rate": rate,
                "start_unix": start,
                "rows": raw_rows,
                "seconds": raw_rows / rate if rate else None,
            }
            if magic != b"D1RW":
                r["issues"].append(f"raw.d1raw magic is {magic!r}, not b'D1RW'")
            if rem:
                r["issues"].append(
                    f"raw.d1raw ends mid-row ({rem} stray bytes): writer died mid-chunk"
                )
    else:
        r["issues"].append("no raw.d1raw: the source of truth is missing")

    if "manifest.json" in r["files"]:
        try:
            with open(os.path.join(d, "manifest.json"), encoding="utf-8") as fh:
                m = json.load(fh)
            r["manifest"] = {
                k: m.get(k) for k in ("state", "error", "updated_iso") if k in m
            }
        except (OSError, json.JSONDecodeError) as e:
            r["issues"].append(f"manifest.json unreadable: {e}")

    s = None
    if "summary.json" in r["files"]:
        try:
            with open(os.path.join(d, "summary.json"), encoding="utf-8") as fh:
                s = json.load(fh)
        except (OSError, json.JSONDecodeError) as e:
            r["issues"].append(f"summary.json unreadable: {e}")
    if s is None:
        r["state"] = (
            "incomplete (never finalized): live, or crashed; recovery can rebuild it from raw.d1raw"
        )
    else:
        r["state"] = "finalized"
        r["summary"] = {
            k: s.get(k)
            for k in (
                "sample_name",
                "fs",
                "n",
                "duration_sec",
                "peaks",
                "cut_window_sec",
                "tacho_measured",
                "mat_written",
                "mat_skip_reason",
                "drift_comp",
            )
        }
        r["summary"]["channels"] = s.get("channels")
        if raw_rows is not None and s.get("n") not in (None, raw_rows):
            r["issues"].append(
                f"summary n={s.get('n')} but raw.d1raw holds {raw_rows} rows"
            )
        if s.get("mat_written") and "capture.mat" not in r["files"]:
            r["issues"].append("summary says mat_written but capture.mat is missing")
        if s.get("mat_written") is False:
            r["issues"].append(
                f".mat skipped ({s.get('mat_skip_reason')}): expected above MAT_MAX_BYTES, uploads must cope"
            )
        if s.get("tacho_measured") is False:
            r["issues"].append(
                "tacho_measured=false: rpm/revs are zeros, not a measurement (sensor, wiring or ppr)"
            )
        clipped = (s.get("channels_ranging") or {}).get("clipped")
        if clipped and any(clipped):
            names = [n for n, c in zip((s.get("channels") or [])[1:], clipped) if c]
            r["issues"].append(
                f"channels clipped at the amp's full scale: {names or clipped}"
            )
        ch = s.get("channels") or []
        if ch[:10] != [
            "Time",
            "Fx1",
            "Fx2",
            "Fy1",
            "Fy2",
            "Fz1",
            "Fz2",
            "Fz3",
            "Fz4",
            "Tacho",
        ]:
            r["issues"].append(f"column order is not the v1.0 layout: {ch[:10]}")

    if "live_cache.bin" in r["files"]:
        with open(os.path.join(d, "live_cache.bin"), "rb") as fh:
            head = fh.read(32)
        if len(head) == 32:
            magic, ver, n = struct.unpack_from("<III", head)
            fs, feed, diam, cs, ce = struct.unpack_from("<fffff", head, 12)
            r["live_cache"] = {
                "magic_ok": magic == D1LC_MAGIC,
                "version": ver,
                "n": n,
                "fs": fs,
                "cut_sec": [cs, ce],
                "feed": feed,
                "diam": diam,
            }
            if magic != D1LC_MAGIC:
                r["issues"].append(f"live_cache.bin magic {magic:#x} != 0x44314c43")
            expect = 32 + 6 * 4 * n
            if r["files"]["live_cache.bin"] < expect:
                r["issues"].append(
                    f"live_cache.bin truncated ({r['files']['live_cache.bin']} < {expect} bytes)"
                )
    elif s is not None:
        r["issues"].append(
            "finalized but no live_cache.bin: Plot and filters can't render it"
        )
    return r


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    target = sys.argv[1]
    dirs = (
        [target]
        if os.path.isfile(os.path.join(target, "raw.d1raw"))
        or os.path.isfile(os.path.join(target, "summary.json"))
        else sorted(
            (
                os.path.join(target, x)
                for x in os.listdir(target)
                if os.path.isdir(os.path.join(target, x))
            ),
            reverse=True,
        )
    )
    reports = [inspect(d) for d in dirs]
    if "--json" in sys.argv:
        print(json.dumps(reports, indent=2, default=str))
        return
    for r in reports:
        print(f"== {r['capture']}: {r['state']}")
        print(
            "   files: "
            + ", ".join(f"{k} {v/1e6:.2f} MB" for k, v in r["files"].items())
        )
        if r.get("manifest"):
            print(f"   manifest: {r['manifest']}")
        if "raw" in r:
            x = r["raw"]
            print(
                f"   raw: {x['rows']} rows x {x['n_cols']} cols @ {x['rate']:g} Hz = {x['seconds'] or 0:.2f} s"
            )
        if "summary" in r:
            x = r["summary"]
            print(
                f"   summary: n={x['n']} fs={x['fs']} peaks={x['peaks']} cut={x['cut_window_sec']}"
            )
        if "live_cache" in r:
            x = r["live_cache"]
            print(f"   live_cache: v{x['version']} n={x['n']} fs={x['fs']:g}")
        for i in r["issues"]:
            print(f"   ! {i}")
        if not r["issues"]:
            print("   no issues found")


if __name__ == "__main__":
    main()
