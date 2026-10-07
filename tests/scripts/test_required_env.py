"""Scripts must not fall back to the old `change_me` placeholder credentials: a missing
secret is a clear error, not a login attempt with a guessed password."""

import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"


def _env_without(*names):
    return {k: v for k, v in os.environ.items() if k not in names}


@pytest.mark.parametrize(
    "script,args,var",
    [
        ("diag_smoke_check.py", [], "DATABASE_URL"),
        ("transfer_images.py", ["x.xlsx"], "ADMIN_PASSWORD"),
        ("flatten_param_fields.py", [], "DATABASE_URL"),
    ],
)
def test_script_requires_its_secret(script, args, var):
    r = subprocess.run(
        [sys.executable, str(SCRIPTS / script), *args],
        env=_env_without(var),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert r.returncode != 0
    assert var in (r.stderr + r.stdout)


def test_no_placeholder_password_defaults_remain():
    offenders = []
    patterns = (
        "scripts/*.py",
        "scripts/*.sh",
        "tests/ui/*.ts",
        "tests/ui/*.mjs",
        "tests/ui/specs/*.ts",
    )
    for pattern in patterns:
        for path in ROOT.glob(pattern):
            if "change_me" in path.read_text(encoding="utf-8", errors="replace"):
                offenders.append(str(path.relative_to(ROOT)))
    assert not offenders, f"change_me placeholder still present in {offenders}"
