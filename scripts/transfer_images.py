#!/usr/bin/env python3
"""Import asset image URLs from the legacy XLSX into the Directus File Library
(MinIO) and link them to equipment / tools / insert_types.

Uses Directus's POST /files/import, which downloads the URL server-side and
stores it in MinIO (so images are available offline). Then sets the entity's
`image` field to the new file id.

Usage:
  DIRECTUS_URL=http://localhost:8055 ADMIN_EMAIL=admin@example.com \\
  ADMIN_PASSWORD="$DIRECTUS_ADMIN_PASSWORD" \\
      python scripts/transfer_images.py "<path to Sample_Data.xlsx>"
"""

from __future__ import annotations

import os
import sys

import openpyxl
import requests

BASE = os.environ.get("DIRECTUS_URL", "http://localhost:8055")
EMAIL = os.environ.get("ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("ADMIN_PASSWORD") or sys.exit(
    "ERROR: ADMIN_PASSWORD is required (the Directus admin password; no default)"
)


def clean(v):
    s = str(v).strip() if v is not None else None
    return s if s and s.lower() not in ("none", "n/a", "na") else None


def rows(wb, name):
    ws = wb[name]
    raw = list(ws.iter_rows(values_only=True))
    hdr = [str(h) for h in raw[0] if h is not None]
    out = []
    for r in raw[1:]:
        if not any(x is not None for x in r):
            continue
        out.append({hdr[i]: r[i] for i in range(min(len(hdr), len(r)))})
    return out


def main():
    xlsx = sys.argv[1]
    wb = openpyxl.load_workbook(xlsx, read_only=True, data_only=True)
    s = requests.Session()
    tok = s.post(
        f"{BASE}/auth/login", json={"email": EMAIL, "password": PASSWORD}
    ).json()["data"]["access_token"]
    s.headers["Authorization"] = f"Bearer {tok}"

    # (sheet, image-url column, key column, collection, db match field, pk)
    plans = [
        ("Machines", "Image", "Machine", "equipment", "equipment_name", "equipment_id"),
        ("Tools", "Image", "Unique ID", "tools", "tool_code", "tool_id"),
        (
            "Insert Types",
            "Image",
            "Name",
            "insert_types",
            "type_code",
            "insert_type_id",
        ),
    ]

    for sheet, url_col, key_col, coll, match_field, pk in plans:
        try:
            data = rows(wb, sheet)
        except KeyError:
            continue
        done = skipped = 0
        for r in data:
            url = clean(r.get(url_col))
            key = clean(r.get(key_col))
            if not url or not key or not url.lower().startswith("http"):
                continue
            # find matching DB record
            res = (
                s.get(
                    f"{BASE}/items/{coll}",
                    params={
                        "filter[" + match_field + "][_eq]": key,
                        "fields": pk + ",image",
                        "limit": 1,
                    },
                )
                .json()
                .get("data", [])
            )
            if not res:
                skipped += 1
                continue
            rec = res[0]
            if rec.get("image"):
                continue  # already has an image
            # import the URL into the File Library (MinIO)
            imp = s.post(
                f"{BASE}/files/import",
                json={
                    "url": url,
                    "data": {"title": f"{coll} {key}"},
                },
            )
            if imp.status_code not in (200, 201):
                skipped += 1
                continue
            file_id = imp.json()["data"]["id"]
            up = s.patch(f"{BASE}/items/{coll}/{rec[pk]}", json={"image": file_id})
            if up.status_code in (200, 204):
                done += 1
            else:
                skipped += 1
        print(f"{coll}: linked {done} images, skipped {skipped}")


if __name__ == "__main__":
    main()
