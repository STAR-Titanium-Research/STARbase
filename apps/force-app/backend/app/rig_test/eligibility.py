"""Which machines may answer rig-test requests: only the rig (ADR-0012 §5)."""

from __future__ import annotations

import os
import socket

from ..labamp import MockLabAmp

ALLOW_SIM_ENV = "FORCE_APP_RIG_TEST_ALLOW_SIM"
RIG_ID_ENV = "FORCE_APP_RIG_ID"


def rig_id() -> str:
    return (os.environ.get(RIG_ID_ENV) or "").strip() or socket.gethostname()


def check(devices: dict, labamp: object) -> tuple[bool, str | None]:
    """(eligible, reason when not). Eligible means real NI-DAQ hardware with a chassis and a real
    Lab Amp client. `FORCE_APP_RIG_TEST_ALLOW_SIM=1` overrides it for tests and hardware-free
    verification runs only."""
    if os.environ.get(ALLOW_SIM_ENV) == "1":
        return True, None
    if devices.get("simulated", True):
        return False, "NI-DAQ is simulated: no DAQmx hardware found on this PC"
    if not devices.get("chassis"):
        return False, "no NI-DAQ chassis found on this PC"
    if isinstance(labamp, MockLabAmp):
        return False, "the Lab Amp is in mock mode"
    return True, None
