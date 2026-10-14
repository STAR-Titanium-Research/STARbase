#!/usr/bin/env python3
"""Compare two performance-gate runs of scripts/dev/directus_smoke.sh (D1_SMOKE_MODE=perf): "before" (migrations 166 and 167 withheld: main's
rules) and "after", on the same seeded copy. Reads their output files and prints the table of the plan's gate (A1a Task 2):
reads: p95 under 300 ms for every list request (and the ratio to before); writes: at most 2x the time before.

    python3 scripts/dev/perf_compare.py before.log after.log [--markdown]
"""

import re
import sys

READ = re.compile(
    r"^PERF (\w+) (\S+) n=(\d+) p50=(\S+) p95=(\S+) max=(\S+) rows=(\S*)(?: dups=(\d+))?"
)
WRITE = re.compile(r"^PERFW (\S+) n=(\d+) p50=(\d+)(?: p95=(\d+))?(?: max=(\d+))?")
LOCKS = re.compile(r"^PERFLOCKS (\S+) (\d+)")


def num(v):
    return (
        float(v.lstrip(">"))
        if v and v.lstrip(">").replace(".", "").isdigit()
        else float("nan")
    )


def parse(path):
    reads, writes, locks = {}, {}, {}
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.rstrip()
        if m := READ.match(line):
            user, label, _n, p50, p95, _mx, rows, dups = m.groups()
            reads[(user, label)] = (num(p50), num(p95), rows, int(dups or 0))
        elif m := WRITE.match(line):
            name, _n, p50, p95, mx = m.groups()
            writes[name] = (float(p50), float(p95 or mx or p50))
        elif m := LOCKS.match(line):
            locks[m.group(1)] = max(locks.get(m.group(1), 0), int(m.group(2)))
    return reads, writes, locks


def main():
    before, after = parse(sys.argv[1]), parse(sys.argv[2])
    bad = 0
    print(
        "READS (ms)  user / request: before p50/p95, after p50/p95, ratio of p95, after dups"
    )
    worst = (0, "")
    for key in sorted(after[0]):
        a = after[0][key]
        b = before[0].get(key)
        ratio = a[1] / b[1] if b and b[1] else float("nan")
        flag = ""
        if a[1] >= 300:
            flag = "  OVER 300 ms"
            bad += 1
        if a[3]:
            flag += f"  DUPLICATES {a[3]}"
            bad += 1
        if ratio == ratio and ratio > worst[0]:
            worst = (ratio, f"{key[0]} {key[1]}")
        print(
            f"  {key[0]:8} {key[1]:38} before {b[0] if b else '-':>7}/{b[1] if b else '-':>7}  after {a[0]:>7.0f}/{a[1]:>7.0f}  x{ratio:5.2f}{flag}"
        )
    print(
        f"worst read ratio of p95: x{worst[0]:.2f} ({worst[1]}); worst read p95 after: {max(v[1] for v in after[0].values()):.0f} ms"
    )
    print("\nWRITES (ms, median)  scenario: before, after, ratio")
    wworst = (0, "")
    for name in sorted(after[1]):
        a = after[1][name][0]
        b = before[1].get(name, (float("nan"),))[0]
        ratio = a / b if b == b and b else float("nan")
        # cascades and the wait behind an import transaction are reported, not limited; so is a SQL-level scenario whose before time is under
        # 5 ms (a ratio against 1 ms is noise: the same operations through Directus, with 10 to 600 ms baselines, carry the limit)
        limited = not name.startswith(("cascade_", "ui_write_wait")) and not (
            b == b and b < 5
        )
        flag = ""
        if limited and ratio == ratio and ratio > 2.0:
            flag = "  OVER 2x"
            bad += 1
        if limited and ratio == ratio and ratio > wworst[0]:
            wworst = (ratio, name)
        print(
            f"  {name:36} before {b:>8.0f}  after {a:>8.0f}  x{ratio:5.2f}{flag}{'' if limited else '  (reported, no limit)'}"
        )
    print(f"worst write ratio: x{wworst[0]:.2f} ({wworst[1]})")
    if after[2]:
        print(
            "\nPEAK pg_locks per scenario (after): "
            + ", ".join(f"{k}={v}" for k, v in sorted(after[2].items()))
        )
    print("\nGATE:", "FAIL" if bad else "PASS", f"({bad} problem(s))")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
