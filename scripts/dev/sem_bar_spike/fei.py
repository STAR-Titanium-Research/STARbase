"""FEI metadata (TIFF tag 34682) and data-bar crop, from the 2026-10-16 spike."""

import configparser

import numpy as np


def fei_meta(im):
    raw = im.tag_v2.get(34682)
    if not raw:
        return None
    cp = configparser.ConfigParser(strict=False, interpolation=None)
    try:
        cp.read_string(str(raw))
    except Exception:  # noqa: BLE001
        return None
    g = lambda s, k: cp.get(s, k, fallback=None)  # noqa: E731
    out = {}
    hv = g("Beam", "HV") or g("EBeam", "HV")
    if hv:
        out["kv"] = float(hv) / 1000
    wd = g("EBeam", "WD") or g("Stage", "WorkingDistance")
    if wd:
        out["wd_mm"] = float(wd) * 1000
    spot = g("Beam", "Spot") or g("EBeam", "Spot")
    if spot:
        out["spot"] = float(spot)
    out["det"] = g("Detectors", "Name")
    out["mode"] = g("Detectors", "Mode")
    out["bar_h"] = g("PrivateFei", "DatabarHeight")
    return out


def bar_of(im):
    a = np.asarray(im.convert("L"))
    h = a.shape[0]
    means = a.mean(axis=1)
    # the bar's top divider: the first full-white row in the bottom 25% followed by dark rows
    for y in range(int(h * 0.75), h - 10):
        if means[y] > 250 and means[y + 2] < 60:
            return im.crop((0, y, im.width, h)).convert("L")
    return None
