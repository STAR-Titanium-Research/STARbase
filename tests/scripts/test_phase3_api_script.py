"""tests/phase3_api.sh against a stub Directus: the Researcher-isolation and stale-OCC checks
must fail for the wrong response and pass for the documented one (review finding 7.11).

The stub implements just the endpoints the script calls. `mode` selects how it misbehaves.
"""

import json
import os
import shutil
import subprocess
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "phase3_api.sh"
pytestmark = pytest.mark.skipif(
    shutil.which("jq") is None or shutil.which("curl") is None,
    reason="needs jq and curl",
)


class Stub(ThreadingHTTPServer):
    def __init__(self, mode):
        super().__init__(("127.0.0.1", 0), Handler)
        self.mode = mode  # dict: researcher, stale
        self.sample = None
        self.audit_queries = []
        self.log_row = {"log_id": 1, "table_name": "physical_samples"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def _who(self):
        return self.headers.get("Authorization", "").removeprefix("Bearer ")

    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        q = parse_qs(u.query)
        st = self.server
        if u.path == "/server/health":
            return self._send(200, {"status": "ok"})
        if u.path == "/collections":
            names = [
                "physical_samples",
                "manufacturing_operations",
                "test_sessions",
                "audit_logs",
            ]
            return self._send(200, {"data": [{"collection": c} for c in names]})
        if u.path == "/items/physical_samples":
            code = q.get("filter[sample_code][_eq]", [""])[0]
            rows = [st.sample] if st.sample and st.sample["sample_code"] == code else []
            return self._send(200, {"data": rows})
        if u.path.startswith("/items/physical_samples/"):
            return self._send(200, {"data": st.sample})
        if u.path in ("/items/manufacturing_methods", "/items/equipment"):
            return self._send(
                200, {"data": [{"method_id": "m1", "equipment_id": "e1"}]}
            )
        if u.path == "/items/audit_logs":
            st.audit_queries.append(u.query)
            if "filter[record_id][_eq]" not in u.query:  # a column that does not exist
                return self._send(400, {"errors": [{"message": "Invalid filter"}]})
            row = {"log_id": 1, "row_before": {"v": 1}, "row_after": {"v": 2}}
            action = q.get("filter[action_type][_eq]", [""])[0]
            return self._send(
                200, {"data": [row] if action in ("INSERT", "UPDATE") else []}
            )
        if u.path.startswith("/items/audit_logs/"):
            return self._send(200, {"data": st.log_row})
        return self._send(404, {"errors": [{"message": "no route"}]})

    def do_POST(self):  # noqa: N802
        u = urlparse(self.path)
        st = self.server
        body = self._body()
        if u.path == "/auth/login":
            token = "RES" if body.get("email") == "res@example.org" else "ADMIN"
            return self._send(200, {"data": {"access_token": token}})
        if u.path == "/items/physical_samples":
            if self._who() == "RES":
                if st.mode["researcher"] == "forbidden":
                    return self._send(
                        403, {"errors": [{"extensions": {"code": "FORBIDDEN"}}]}
                    )
                if st.mode["researcher"] == "server_error":
                    return self._send(500, {"errors": [{"message": "boom"}]})
                return self._send(200, {"data": {"sample_id": "leak", **body}})
            st.sample = {
                "sample_id": str(uuid.uuid4()),
                "version": 1,
                "notes": None,
                **body,
            }
            return self._send(200, {"data": st.sample})
        if u.path == "/items/manufacturing_operations":
            return self._send(200, {"data": {"operation_id": "op1", "version": 1}})
        return self._send(404, {"errors": []})

    def do_PATCH(self):  # noqa: N802
        u = urlparse(self.path)
        q = parse_qs(u.query)
        st = self.server
        body = self._body()
        if u.path.startswith("/items/audit_logs/"):
            return self._send(403, {"errors": [{"extensions": {"code": "FORBIDDEN"}}]})
        want = int(q.get("filter[version][_eq]", ["0"])[0])
        if want == st.sample["version"]:
            st.sample.update(body)
            st.sample["version"] += 1
            return self._send(200, {"data": st.sample})
        stale = st.mode["stale"]
        if stale == "null":
            return self._send(200, {"data": None})
        if stale == "server_error":
            return self._send(500, {"errors": [{"message": "boom"}]})
        if stale == "applied":  # the guard is ignored: the stale write goes through
            st.sample.update(body)
            return self._send(200, {"data": st.sample})
        return self._send(400, {"errors": [{"message": "bad"}]})

    def do_DELETE(self):  # noqa: N802
        self._send(204, {})


def _run(tmp_path, mode):
    server = Stub(mode)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        (tmp_path / "tests").mkdir()
        shutil.copy(SCRIPT, tmp_path / "tests" / "phase3_api.sh")
        env = {
            **os.environ,
            "DIRECTUS_URL": f"http://127.0.0.1:{server.server_port}",
            "DIRECTUS_ADMIN_EMAIL": "admin@example.org",
            "DIRECTUS_ADMIN_PASSWORD": "x",
            "DIRECTUS_RESEARCHER_EMAIL": "res@example.org",
            "DIRECTUS_RESEARCHER_PASSWORD": "x",
        }
        env.pop("D1_RIG1_TOKEN", None)
        r = subprocess.run(
            ["bash", str(tmp_path / "tests" / "phase3_api.sh")],
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        return r, server
    finally:
        server.shutdown()


def _lines(r, marker):
    return [ln for ln in r.stdout.splitlines() if marker in ln]


def test_documented_responses_pass(tmp_path):
    r, server = _run(tmp_path, {"researcher": "forbidden", "stale": "null"})
    assert r.returncode == 0, r.stdout
    assert any("HTTP 403" in ln and "PASS" in ln for ln in r.stdout.splitlines())
    assert _lines(r, "stale version → 200 with data:null")
    # the audit queries use the real column
    assert server.audit_queries and all(
        "record_id" in q and "row_id" not in q for q in server.audit_queries
    )


@pytest.mark.parametrize("researcher", ["server_error", "allowed"])
def test_researcher_check_fails_unless_the_response_is_403(tmp_path, researcher):
    r, _ = _run(tmp_path, {"researcher": researcher, "stale": "null"})
    assert r.returncode != 0
    assert any(
        "HTTP 403" in ln and "FAIL" in ln for ln in r.stdout.splitlines()
    ), r.stdout


@pytest.mark.parametrize("stale", ["server_error", "applied", "bad_request"])
def test_stale_occ_check_fails_unless_it_is_the_documented_conflict(tmp_path, stale):
    r, _ = _run(tmp_path, {"researcher": "forbidden", "stale": stale})
    assert r.returncode != 0
    assert any(
        "stale version" in ln and "FAIL" in ln for ln in r.stdout.splitlines()
    ), r.stdout
