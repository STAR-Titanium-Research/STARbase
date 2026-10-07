#!/usr/bin/env python3
"""Drive one simulated recording end to end through the backend's HTTP API and check
what it leaves on disk — the same path the Record page takes, minus the UI.

  start -> poll /record/status until done -> /captures/{id}/summary -> check the files

Usage: sim_record.py [--url http://127.0.0.1:8200] [--duration 3] [--rate 5000]
                     [--json '{"extra": "RecordConfig fields"}']
Exit 0 = every check passed. Stdlib only, so it runs with any python3.
"""

import argparse
import json
import struct
import sys
import time
import urllib.error
import urllib.request

FAILS = []


def call(url, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            ctype = r.headers.get("Content-Type", "")
            return json.loads(raw) if "json" in ctype else raw
    except urllib.error.HTTPError as e:
        sys.exit(
            f"{method} {url} -> HTTP {e.code}: {e.read().decode(errors='replace')}"
        )


def check(ok, what):
    print(f"  {'PASS' if ok else 'FAIL'} {what}")
    if not ok:
        FAILS.append(what)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8200")
    ap.add_argument("--duration", type=float, default=3.0)
    ap.add_argument("--rate", type=float, default=5000.0)
    ap.add_argument("--json", default="{}", help="extra RecordConfig fields")
    a = ap.parse_args()

    cfg = {
        "sample_name": "SKILL-SIM",
        "duration_sec": a.duration,
        "sample_rate": a.rate,
        "source": "sim",
        **json.loads(a.json),
    }
    st = call(f"{a.url}/record/status")
    if st.get("state") in ("recording", "finalizing"):
        sys.exit(f"backend is busy ({st['state']}); stop it first")

    print(f"== start {cfg}")
    st = call(f"{a.url}/record/start", "POST", cfg)
    cid = st["id"]
    t0 = time.time()
    while st.get("state") in ("recording", "finalizing", "idle"):
        if time.time() - t0 > a.duration + 120:
            sys.exit(f"timed out in state {st.get('state')}")
        time.sleep(0.5)
        st = call(f"{a.url}/record/status")
    print(f"== {cid}: state={st['state']} after {time.time() - t0:.1f}s")
    check(st["state"] == "done", f"session finished as done (error={st.get('error')})")

    s = call(f"{a.url}/captures/{cid}/summary")
    s = s.get("summary", s)
    expect_n = a.duration * a.rate
    check(
        abs(s.get("n", 0) - expect_n) <= 0.02 * expect_n,
        f"n={s.get('n')} ~ duration*rate={expect_n:.0f}",
    )
    check(s.get("fs") == a.rate, f"fs={s.get('fs')} matches the requested rate")
    chans = s.get("channels", [])
    check(
        chans[:10]
        == ["Time", "Fx1", "Fx2", "Fy1", "Fy2", "Fz1", "Fz2", "Fz3", "Fz4", "Tacho"],
        f"v1.0 column order kept ({chans[:10]})",
    )
    check(
        all(s.get("peaks", {}).get(ax, 0) > 0 for ax in ("Fx", "Fy", "Fz")),
        f"non-zero peaks {s.get('peaks')}",
    )
    check(s.get("mat_written") is True, f"mat_written ({s.get('mat_skip_reason')})")
    check(s.get("tacho_measured") is True, "tacho measured")

    lc = call(f"{a.url}/captures/{cid}/live_cache.bin")
    # 32-byte little-endian header: u32 magic 0x44314C43 ('D1LC' read as a u32, so the bytes on
    # disk are b"CL1D"), u32 version, u32 N, then f32 Fs, feed, diam, cs_sec, ce_sec.
    ok = isinstance(lc, bytes) and len(lc) >= 32
    magic, version, n_lc = struct.unpack_from("<III", lc, 0) if ok else (0, 0, 0)
    check(magic == 0x44314C43, f"live_cache.bin has the D1LC magic ({magic:#x})")
    if ok:
        fs_lc = struct.unpack_from("<f", lc, 12)[0]
        print(
            f"     live_cache v{version}: N={n_lc}, Fs={fs_lc:g} Hz, {len(lc)/1e6:.2f} MB"
        )
    mat = call(f"{a.url}/captures/{cid}/capture.mat")
    check(isinstance(mat, bytes) and mat[:6] == b"MATLAB", "capture.mat is a MAT file")

    print(f"\n{len(FAILS)} failed" if FAILS else "\nall checks passed")
    print(f"capture id: {cid}")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
