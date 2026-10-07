"""Bug-report issue body assembly (apps/force-app/backend/app/bug_report.py)."""

import httpx
import pytest

from app import bug_report
from app.bug_report import build_body

BASE = {
    "description": "RPM looked wrong",
    "app_version": "0.1.17",
    "platform": "Win32",
    "route": "/record",
    "reporter_email": "someone@example.com",
    "log_tail": "",
}


def test_body_includes_the_basics():
    body = build_body(**BASE)
    assert "RPM looked wrong" in body
    assert "0.1.17" in body
    assert "`/record`" in body
    assert "someone@example.com" in body


def test_diagnostics_are_rendered_uncollapsed():
    """Machine state is short and answers the first questions a triager would ask, so it is not
    hidden behind a <details> the way the long log tails are."""
    body = build_body(**{**BASE, "diagnostics": "labamp: mock=True mode=MEASURE"})
    assert "Machine state at time of report" in body
    assert "labamp: mock=True mode=MEASURE" in body
    head, _, tail = body.partition("labamp: mock=True")
    assert "<details>" not in head, "diagnostics must not be collapsed"


def test_console_and_log_tails_are_collapsed_separately():
    body = build_body(
        **{**BASE, "log_tail": "backend line", "console_tail": "console line"},
    )
    assert body.count("<details>") == 2
    assert "Renderer console" in body and "Recent backend log" in body
    assert "console line" in body and "backend line" in body


def test_reporter_is_always_recorded_even_when_not_signed_in():
    """A missing 'Reported by' line must never be ambiguous between 'not signed in' and 'the
    client forgot to send it' — so the line is always present, with an explicit fallback."""
    body = build_body(**{**BASE, "reporter_email": ""})
    assert "**Reported by:** _not signed in_" in body


def test_absent_sections_are_omitted_entirely():
    body = build_body(**BASE)
    assert "<details>" not in body
    assert "Machine state" not in body


def test_backticks_in_attached_text_cannot_break_out_of_the_fence():
    """The tails are renderer- and machine-supplied. A literal ``` would close our fence early and
    let whatever follows render as raw markdown/HTML in the issue."""
    hostile = "before ``` after"
    body = build_body(**{**BASE, "log_tail": hostile, "console_tail": hostile})
    assert "before ``` after" not in body
    # Exactly the fences we opened: two per collapsed section, and none contributed by the payload.
    assert body.count("```") == 4


def test_windows_account_names_are_redacted_from_every_attached_section():
    """captures_root defaults under the operator's profile, and log/console lines quote paths too
    (tracebacks, config loads), so the account name must not reach the issue from any of them."""
    leaks = [
        r"captures_root: C:\Users\jsmith\AppData\Local\force-app\captures",
        r'File "D:\Users\Jane Smith\force-app\main.py", line 3',
        "C:/Users/jsmith/AppData/Local/force-app",
        r'{"path": "C:\\Users\\jsmith\\AppData"}',
    ]
    for leak in leaks:
        body = build_body(
            **{**BASE, "diagnostics": leak, "log_tail": leak, "console_tail": leak},
        )
        assert "jsmith" not in body and "Jane" not in body and "Smith" not in body, leak
        assert body.count("<redacted>") == 3, leak
    # A path that names no account is left alone, so the triage value of the paths survives.
    body = build_body(**{**BASE, "diagnostics": r"captures_root: J:\My Drive\force-app-captures"})
    assert r"J:\My Drive\force-app-captures" in body


def test_long_tails_are_truncated_from_the_front():
    """GitHub caps issue bodies, and the END of a log is the part that matters."""
    body = build_body(**{**BASE, "log_tail": "X" * 50_000 + "TAIL_MARKER"})
    assert "TAIL_MARKER" in body
    assert len(body) < 30_000


# ---- create_issue: kind -> title prefix + label (never trust a user-typed "[Bug]"/"[Feature]") --


class _FakeResponse:
    status_code = 200

    def json(self):
        return {"ok": True, "url": "https://example.invalid/issues/1", "number": 1}


class _FakeAsyncClient:
    last_payload: dict | None = None

    def __init__(self, *a, **kw):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, json):
        _FakeAsyncClient.last_payload = json
        return _FakeResponse()


@pytest.fixture()
def fake_relay(monkeypatch):
    monkeypatch.setattr(bug_report.httpx, "AsyncClient", _FakeAsyncClient)
    return _FakeAsyncClient


CREATE_ARGS = {**BASE, "title": "the plot lags"}


@pytest.mark.anyio
async def test_kind_bug_prefixes_title_and_labels_bug(fake_relay):
    await bug_report.create_issue(**CREATE_ARGS, kind="bug")
    payload = fake_relay.last_payload
    assert payload["title"] == "[Bug] the plot lags"
    assert payload["labels"] == ["force-app", "in-app-report", "bug", "area:general"]


@pytest.mark.anyio
async def test_kind_feature_prefixes_title_and_labels_enhancement(fake_relay):
    await bug_report.create_issue(**CREATE_ARGS, kind="feature")
    payload = fake_relay.last_payload
    assert payload["title"] == "[Feature] the plot lags"
    assert payload["labels"] == ["force-app", "in-app-report", "enhancement", "area:general"]


@pytest.mark.anyio
async def test_unrecognized_kind_falls_back_to_bug(fake_relay):
    await bug_report.create_issue(**CREATE_ARGS, kind="nonsense")
    assert fake_relay.last_payload["title"] == "[Bug] the plot lags"


@pytest.mark.anyio
async def test_does_not_double_prefix_a_title_the_user_already_typed(fake_relay):
    """The picker is the single source of truth — a user-typed "[Bug]" is only skipped so the
    title isn't doubled, never trusted in place of the picker to choose the label."""
    await bug_report.create_issue(**{**CREATE_ARGS, "title": "[Bug] already tagged"}, kind="bug")
    assert fake_relay.last_payload["title"] == "[Bug] already tagged"


# ---- create_issue: area -> `area:*` label, restricted to the fixed AREAS set -----------------


@pytest.mark.anyio
async def test_area_is_appended_as_a_dedicated_label(fake_relay):
    await bug_report.create_issue(**CREATE_ARGS, kind="bug", area="plotting")
    assert fake_relay.last_payload["labels"] == [
        "force-app",
        "in-app-report",
        "bug",
        "area:plotting",
    ]


@pytest.mark.anyio
async def test_unrecognized_area_falls_back_to_general(fake_relay):
    await bug_report.create_issue(**CREATE_ARGS, kind="bug", area="nonsense")
    assert fake_relay.last_payload["labels"][-1] == "area:general"


@pytest.mark.anyio
async def test_missing_area_defaults_to_general(fake_relay):
    await bug_report.create_issue(**CREATE_ARGS, kind="bug")
    assert fake_relay.last_payload["labels"][-1] == "area:general"


# ---- #95: several areas per report ------------------------------------------------------------


@pytest.mark.anyio
async def test_several_areas_each_get_a_label(fake_relay):
    await bug_report.create_issue(**CREATE_ARGS, kind="bug", area=["plotting", "recording"])
    assert fake_relay.last_payload["labels"][-2:] == ["area:plotting", "area:recording"]


def test_normalize_areas_filters_dedupes_and_caps():
    assert bug_report.normalize_areas(["nidaq", "bogus", "nidaq", "GUI"]) == ["nidaq", "gui"]
    many = ["recording", "plotting", "diagnostics", "settings", "labamp", "nidaq"]
    assert bug_report.normalize_areas(many) == many[: bug_report.MAX_AREAS]


def test_normalize_areas_falls_back_to_general_and_drops_it_beside_a_specific_area():
    assert bug_report.normalize_areas([]) == ["general"]
    assert bug_report.normalize_areas(None) == ["general"]
    assert bug_report.normalize_areas(["bogus"]) == ["general"]
    assert bug_report.normalize_areas(["general", "plotting"]) == ["plotting"]
    # A single string (an older client) still works.
    assert bug_report.normalize_areas("labamp") == ["labamp"]


@pytest.mark.anyio
async def test_success_result_carries_the_filed_title_and_labels(fake_relay):
    """#88: the app lists the new issue at once from this, before GitHub's list catches up."""
    result = await bug_report.create_issue(**CREATE_ARGS, kind="feature", area=["gui"])
    assert result["number"] == 1 and result["url"].endswith("/issues/1")
    assert result["title"] == "[Feature] the plot lags"
    assert "area:gui" in result["labels"]


# ---- list_issues: proxies the relay's /issues, never raises ----------------------------------


class _FakeGetResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class _FakeAsyncClientGet:
    def __init__(self, *a, **kw):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url):
        return _FakeGetResponse(200, {"ok": True, "issues": [{"number": 1}]})


@pytest.mark.anyio
async def test_list_issues_returns_relay_payload(monkeypatch):
    monkeypatch.setattr(bug_report.httpx, "AsyncClient", _FakeAsyncClientGet)
    result = await bug_report.list_issues()
    assert result == {"ok": True, "issues": [{"number": 1}]}


@pytest.mark.anyio
async def test_list_issues_surfaces_relay_http_error(monkeypatch):
    class _Failing:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            raise httpx.ConnectError("boom")

    monkeypatch.setattr(bug_report.httpx, "AsyncClient", _Failing)
    result = await bug_report.list_issues()
    assert result["ok"] is False
    assert "could not reach" in result["reason"]
