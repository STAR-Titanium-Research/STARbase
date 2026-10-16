"""OCR trial v2: split the FEI bar into cells, recognise each cell with RapidOCR's recogniser only, score against
the TIFF's FEI metadata. Input: a file of share-relative paths (one per line) and the share root."""

import collections
import json
import os
import re
import sys
import time

import numpy as np
from cells import cells, prep
from fei import bar_of, fei_meta
from PIL import Image
from rapidocr_onnxruntime import RapidOCR

ocr = RapidOCR()
KEYS = {
    "hv": "kv",
    "det": "det",
    "wd": "wd_mm",
    "mag": "mag",
    "mode": "mode",
    "spot": "spot",
    "hfw": "hfw",
    "curr": "curr",
    "pressure": "pressure",
    "tilt": "tilt",
}


def read(bar):
    cs, _mid = cells(bar)
    imgs, idx = [], []
    for i, (_x0, _x1, top, bot) in enumerate(cs):
        imgs += [np.asarray(prep(top, 2, 6)), np.asarray(prep(bot, 2, 6))]
        idx.append(i)
    res, _ = ocr.text_recognizer(imgs)
    out = {}
    for i in idx:
        head, hc = res[2 * i]
        val, vc = res[2 * i + 1]
        h = head.strip().lower()
        key = next((v for k, v in KEYS.items() if h.startswith(k)), None)
        if key is None and re.search(r"\d\s*[nuμµm]m$", head.strip()):
            key, val, vc = (
                "scale",
                head,
                hc,
            )  # the scale-bar cell has its label on the top row
        if key:
            out[key] = (val.strip(), float(vc))
    return out


def num(s):
    m = re.search(r"\d[\d\s]*(?:[.,]\d+)?", s or "")
    if not m:
        return None
    try:
        return float(re.sub(r"\s", "", m.group(0)).replace(",", "."))
    except ValueError:
        return None


def main(listfile, share, out_json):
    paths = [ln.strip() for ln in open(listfile, encoding="utf-8") if ln.strip()]
    tally = collections.defaultdict(lambda: [0, 0])
    conf_right, conf_wrong = [], []
    rows = []
    n_fei = n_bar = n_full = 0
    t0 = time.time()
    for rel in paths:
        p = (
            os.path.join(share, *rel.split("/")[1:])
            if rel.startswith("User/")
            else os.path.join(share, rel)
        )
        p = os.path.join(share, rel.replace("/", os.sep))
        try:
            im = Image.open(p)
            meta = fei_meta(im)
            if not meta:
                rows.append(
                    {
                        "rel": rel,
                        "fei": False,
                        "model": str(im.tag_v2.get(272, ""))[:40],
                    }
                )
                continue
            im.load()
        except Exception as e:  # noqa: BLE001
            rows.append({"rel": rel, "err": type(e).__name__})
            continue
        n_fei += 1
        bar = bar_of(im)
        if bar is None:
            rows.append({"rel": rel, "fei": True, "bar": False})
            continue
        n_bar += 1
        got = read(bar)
        full = True
        row = {
            "rel": rel,
            "fei": True,
            "bar": True,
            "got": got,
            "meta": {k: v for k, v in meta.items() if k != "bar_h"},
        }
        for k in ("kv", "wd_mm", "spot"):
            if meta.get(k) is None:
                continue
            v = num(got.get(k, ("", 0))[0])
            tol = 0.051 if k == "wd_mm" else max(0.006, 0.006 * meta[k])
            good = v is not None and abs(v - meta[k]) <= max(
                tol, abs(meta[k]) * 0.006 + (0.05 if k == "wd_mm" else 0)
            )
            tally[k][0] += good
            tally[k][1] += 1
            full &= good
            (conf_right if good else conf_wrong).append(got.get(k, ("", 0))[1])
        for k in ("det", "mode"):
            if meta.get(k) and k in got:  # score only fields the bar shows
                v = (got.get(k, ("",))[0] or "").upper().replace(" ", "")
                good = v == meta[k].upper().replace(" ", "")
                tally[k][0] += good
                tally[k][1] += 1
                full &= good
                (conf_right if good else conf_wrong).append(got.get(k, ("", 0))[1])
        tally["mag_read"][1] += 1
        tally["mag_read"][0] += num(got.get("mag", ("",))[0]) is not None
        n_full += full
        row["full"] = full
        rows.append(row)
    dt = time.time() - t0
    summary = {
        "files": len(paths),
        "fei_metadata": n_fei,
        "bar_found": n_bar,
        "all_fields_right": n_full,
        "per_field": {k: f"{g}/{t}" for k, (g, t) in tally.items()},
        "conf_right_min": min(conf_right) if conf_right else None,
        "conf_wrong": sorted(round(c, 2) for c in conf_wrong)[:20],
        "seconds": round(dt, 1),
    }
    json.dump(
        {"summary": summary, "rows": rows},
        open(out_json, "w", encoding="utf-8"),
        indent=1,
        default=str,
    )
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main(*sys.argv[1:4])
