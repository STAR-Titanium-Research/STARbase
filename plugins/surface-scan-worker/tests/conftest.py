"""pytest configuration: plugin root on sys.path, and the fakes the job tests share."""

import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.lib import archive, directus_client, minio_client  # noqa: E402
from app.lib.directus_client import VersionConflictError  # noqa: E402

SCAN = "0b0a1c1e-5a53-4b0e-9a3c-0d6f6a0c9e11"
FILE = "5d1d6a52-2f3a-4c0e-bd0b-7a1a4f0f9c01"
OTHER_SCAN = "1b0a1c1e-5a53-4b0e-9a3c-0d6f6a0c9e22"
OTHER_FILE = "9c1d6a52-2f3a-4c0e-bd0b-7a1a4f0f9c77"


class FakeWorld:
    """In-memory stand-ins for Directus (rows with OCC, the private render table behind the result route,
    files, fingerprints) and MinIO."""

    def __init__(self, root: Path):
        self.root = root
        self.rows: dict[str, dict] = {}  # public surface_scans rows
        # d1_private.surface_scan_renders as the result route fills it: scan_id -> render_error + columns
        self.renders: dict[str, dict] = {}
        self.files: dict[str, dict] = {}
        self.fingerprints: dict[str, dict] = {}
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.history: list[tuple[str, dict]] = []  # every PATCH: (scan_id, payload)
        self.results: list[
            tuple[str, dict]
        ] = []  # every POST /result: (scan_id, body incl. version)
        self.conflicts_to_inject = 0  # claim PATCHes that lose the race
        self.result_conflicts_to_inject = (
            0  # result POSTs answered 409 (the row moves on first)
        )
        self.result_error: Exception | None = None
        self.put_error: Exception | None = None

    # --- seeding -------------------------------------------------------------------------
    def add_scan(self, scan_id=SCAN, file_id=FILE, status="pending") -> dict:
        row = {
            "scan_id": scan_id,
            "directus_files_id": file_id,
            "render_status": status,
            "version": 1,
            "updated_at": "2026-10-15T10:00:00+00:00",
        }
        self.rows[scan_id] = row
        return row

    def add_file(
        self,
        relative_path: str | None,
        file_id=FILE,
        storage="star",
        forged=False,
    ) -> None:
        """Register a file row under ``file_id`` (what the scan row points at).

        A real pointer row's id is derived from its path (``archive.expected_file_id``), so the row
        Directus returns carries that id. ``forged=True`` keeps ``file_id`` as the row's own id instead,
        i.e. a row whose archive_path was edited after it was registered.
        """
        metadata = {"archive_path": relative_path} if relative_path is not None else {}
        row_id = file_id
        if relative_path is not None and not forged:
            row_id = archive.expected_file_id(relative_path)
        self.files[file_id] = {"id": row_id, "storage": storage, "metadata": metadata}

    def current_fingerprint(self, file_id: str, sha: str, **overrides) -> dict:
        """A ``done`` fingerprint that describes the file on disk right now (size and mtime)."""
        archive_path = self.files[file_id]["metadata"]["archive_path"]
        st = (self.root / archive_path).stat()
        fp = {
            "status": "done",
            "content_sha256": sha,
            "size_bytes": st.st_size,
            "source_mtime": datetime.fromtimestamp(st.st_mtime, UTC).isoformat(),
        }
        fp.update(overrides)
        self.fingerprints[file_id] = fp
        return fp

    # --- fakes for app.lib.directus_client --------------------------------------------------
    def get_scan(self, scan_id):
        return dict(self.rows[scan_id])

    def patch_scan(self, scan_id, payload, version=None):
        row = self.rows[scan_id]
        self.history.append((scan_id, dict(payload)))
        if self.conflicts_to_inject:
            self.conflicts_to_inject -= 1
            row["version"] += 1
            raise VersionConflictError("stale")
        if version is not None and row["version"] != version:
            raise VersionConflictError("stale")
        assert "version" not in payload  # never in the body
        row.update(payload)
        row["version"] += 1
        return {"data": dict(row)}

    def post_result(self, scan_id, payload, version):
        """The result route: one transaction, 409 unless the version matches and the row is rendering."""
        row = self.rows[scan_id]
        body = {**payload, "version": version}
        self.results.append((scan_id, body))
        if self.result_error:
            raise self.result_error
        if self.result_conflicts_to_inject:
            self.result_conflicts_to_inject -= 1
            row["version"] += 1
            raise VersionConflictError("stale")
        if row["version"] != version or row["render_status"] != "rendering":
            raise VersionConflictError("stale")
        assert payload["render_status"] in ("done", "failed")
        row["render_status"] = payload["render_status"]
        row["version"] += 1
        # A done result carries no error: the route stores NULL then, as it does for a missing one.
        self.renders[scan_id] = {
            "render_error": payload.get("render_error"),
            **(payload.get("columns") or {}),
        }
        return {"data": dict(row)}

    def get_file(self, file_id):
        return self.files[file_id]

    def get_fingerprint(self, file_id):
        return self.fingerprints.get(file_id)

    # --- fakes for app.lib.minio_client --------------------------------------------------
    def put_object(self, key, data, content_type="application/octet-stream"):
        if self.put_error:
            raise self.put_error
        self.objects[key] = (data, content_type)

    def object_exists(self, key):
        return key in self.objects

    def get_object_bytes(self, key):
        item = self.objects.get(key)
        return item[0] if item else None

    def statuses(self) -> list[str]:
        """The statuses written, in order: the claim's PATCH, then the result's POST."""
        patched = [p["render_status"] for _, p in self.history if "render_status" in p]
        return patched + [body["render_status"] for _, body in self.results]


@pytest.fixture
def world(tmp_path, monkeypatch):
    mount = tmp_path / "mnt" / "archive"
    root = mount / "star_group1"
    (root / "rig").mkdir(parents=True)
    monkeypatch.setattr(archive, "ARCHIVE_MOUNT", str(mount))
    monkeypatch.setattr(archive, "ARCHIVE_ROOT", str(root))
    w = FakeWorld(root)
    for name in (
        "get_scan",
        "patch_scan",
        "post_result",
        "get_file",
        "get_fingerprint",
    ):
        monkeypatch.setattr(directus_client, name, getattr(w, name))
    for name in ("put_object", "object_exists", "get_object_bytes"):
        monkeypatch.setattr(minio_client, name, getattr(w, name))
    monkeypatch.setattr(directus_client.time, "sleep", lambda s: None)
    return w
