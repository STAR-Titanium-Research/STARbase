"""Shared pytest hooks for tests/scripts.

REQUIRE_DB_TESTS=1 (set by the `script-tests` CI job) turns every skip into a failure. The
database-level tests skip themselves when DATABASE_URL is unset, the database is unreachable or
unmigrated, or psql/jq/curl are missing, which is right on a laptop but let CI go green while
testing nothing. With the variable set, a skip means the job's setup is broken, so it fails.
"""

import os

import pytest


def _strict() -> bool:
    return os.environ.get("REQUIRE_DB_TESTS") == "1"


def _skip_reason(longrepr) -> str:
    # A skip's longrepr is (path, lineno, "Skipped: reason") for tests and a
    # CollectReport longrepr tuple for module-level importorskip.
    if isinstance(longrepr, tuple) and longrepr:
        return str(longrepr[-1])
    return str(longrepr)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    if _strict() and report.skipped and not hasattr(report, "wasxfail"):
        report.outcome = "failed"
        report.longrepr = (
            f"REQUIRE_DB_TESTS=1: this test was skipped instead of run "
            f"({_skip_reason(report.longrepr)}). Fix the job's setup (database, "
            f"migrations, seed data, tools) instead of skipping."
        )


@pytest.hookimpl(hookwrapper=True)
def pytest_make_collect_report(collector):
    outcome = yield
    report = outcome.get_result()
    if _strict() and report.skipped:
        report.outcome = "failed"
        report.longrepr = (
            f"REQUIRE_DB_TESTS=1: {collector.nodeid} was skipped at import "
            f"({_skip_reason(report.longrepr)}). Install the missing dependency."
        )
