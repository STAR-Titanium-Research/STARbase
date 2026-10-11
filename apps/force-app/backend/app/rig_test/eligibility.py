"""Which machines may answer rig-test requests: only the rig (ADR-0012 §5)."""

from __future__ import annotations

import os

from .. import bug_report
from ..labamp import MockLabAmp

ALLOW_SIM_ENV = "FORCE_APP_RIG_TEST_ALLOW_SIM"
RIG_ID_ENV = "FORCE_APP_RIG_ID"
DEFAULT_RIG_ID = "rig"  # never the Windows hostname: the id is posted on a public issue
RELAY_URL_ENV = "FORCE_APP_BUG_REPORT_RELAY_URL"


def rig_id() -> str:
    return (os.environ.get(RIG_ID_ENV) or "").strip() or DEFAULT_RIG_ID


def check(devices: dict, labamp: object) -> tuple[bool, str | None]:
    """(eligible, reason when not). Eligible means real NI-DAQ hardware with a chassis and a real
    Lab Amp client. `FORCE_APP_RIG_TEST_ALLOW_SIM=1` overrides it for tests and hardware-free
    verification runs only."""
    if os.environ.get(ALLOW_SIM_ENV) == "1":
        # The override makes any machine a rig, and the relay URL defaults to the production one:
        # a developer with the flag set would answer real requests. Make them name another relay.
        url = os.environ.get(RELAY_URL_ENV, "").strip().rstrip("/")
        if not url or url == bug_report.DEFAULT_RELAY_URL.rstrip("/"):
            return False, (
                f"{ALLOW_SIM_ENV} is set but {RELAY_URL_ENV} is not a test relay: "
                "it must name a relay other than the production one"
            )
        return True, None
    if devices.get("simulated", True):
        return False, "NI-DAQ is simulated: no DAQmx hardware found on this PC"
    if not devices.get("chassis"):
        return False, "no NI-DAQ chassis found on this PC"
    if isinstance(labamp, MockLabAmp):
        return False, "the Lab Amp is in mock mode"
    return True, None
