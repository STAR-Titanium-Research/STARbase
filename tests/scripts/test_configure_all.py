"""scripts/configure_all.sh must stop at the first SQL error, roll that file back and not
restart Directus (finding 7.10). A fake `docker` pipes the SQL to a real psql."""

import os
import re
import shutil
import stat
import subprocess
import uuid
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
DSN = os.environ.get("DATABASE_URL")

FILES = re.findall(
    r"^\s+(configure_\w+\.sql)$", (SCRIPTS / "configure_all.sh").read_text(), re.M
)

FAKE_DOCKER = r"""#!/usr/bin/env bash
echo "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$*" == *" psql "* ]]; then
  args=(); skip=0
  seen=0
  for a in "$@"; do
    if [[ $seen == 0 ]]; then [[ "$a" == psql ]] && seen=1; continue; fi
    if [[ $skip == 1 ]]; then skip=0; continue; fi
    if [[ "$a" == -U || "$a" == -d ]]; then skip=1; continue; fi
    args+=("$a")
  done
  exec psql "${args[@]}" "$FAKE_DSN"
fi
exit 0
"""


def test_every_configure_file_is_one_transaction():
    assert len(FILES) == 7
    for name in FILES:
        text = (SCRIPTS / name).read_text(encoding="utf-8")
        stmts = [
            ln.strip()
            for ln in text.splitlines()
            if ln.strip() and not ln.strip().startswith("--")
        ]
        assert stmts[0] == "BEGIN;", name
        assert stmts.count("COMMIT;") == 1 and stmts.count("BEGIN;") == 1, name


def test_script_has_no_error_swallowing():
    text = (SCRIPTS / "configure_all.sh").read_text()
    assert "ON_ERROR_STOP=1" in text
    assert "|| true" not in text
    assert "grep -i" not in text


@pytest.fixture
def sandbox(tmp_path):
    if not DSN or shutil.which("psql") is None:
        pytest.skip("needs DATABASE_URL and psql")
    shutil.copy(SCRIPTS / "configure_all.sh", tmp_path / "configure_all.sh")
    for name in FILES:
        shutil.copy(SCRIPTS / name, tmp_path / name)
    bindir = tmp_path / "bin"
    bindir.mkdir()
    docker = bindir / "docker"
    docker.write_text(FAKE_DOCKER)
    docker.chmod(docker.stat().st_mode | stat.S_IEXEC)
    env = {
        **os.environ,
        "PATH": f"{bindir}:{os.environ['PATH']}",
        "FAKE_DOCKER_LOG": str(tmp_path / "docker.log"),
        "FAKE_DSN": DSN,
    }
    return tmp_path, env


def _write(path: Path, sql: str):
    path.write_text(sql)


def test_first_error_stops_the_run_and_rolls_back(sandbox):
    tmp, env = sandbox
    marker = "cfg_all_" + uuid.uuid4().hex[:8]
    for name in FILES:
        _write(tmp / name, "BEGIN;\nSELECT 1;\nCOMMIT;\n")
    _write(
        tmp / FILES[1],
        f"BEGIN;\nCREATE TABLE {marker} (x int);\nSELECT 1/0;\nCOMMIT;\n",
    )
    _write(tmp / FILES[2], f"BEGIN;\nCREATE TABLE {marker}_third (x int);\nCOMMIT;\n")
    try:
        r = subprocess.run(
            ["bash", str(tmp / "configure_all.sh")],
            env=env,
            capture_output=True,
            text=True,
        )
        assert r.returncode != 0
        assert FILES[1] in r.stderr
        log = (tmp / "docker.log").read_text()
        assert "redis-cli" not in log and "restart" not in log
        check = subprocess.run(
            [
                "psql",
                DSN,
                "-Atc",
                f"SELECT to_regclass('{marker}'), to_regclass('{marker}_third')",
            ],
            capture_output=True,
            text=True,
        )
        assert (
            check.stdout.strip() == "|"
        )  # neither table exists: rolled back / never run
    finally:
        subprocess.run(
            ["psql", DSN, "-c", f"DROP TABLE IF EXISTS {marker}, {marker}_third"],
            capture_output=True,
        )


def test_success_flushes_redis_and_restarts_directus(sandbox):
    tmp, env = sandbox
    for name in FILES:
        _write(tmp / name, "BEGIN;\nSELECT 1;\nCOMMIT;\n")
    r = subprocess.run(
        ["bash", str(tmp / "configure_all.sh")], env=env, capture_output=True, text=True
    )
    assert r.returncode == 0, r.stderr
    log = (tmp / "docker.log").read_text()
    assert "redis-cli FLUSHALL" in log and "restart" in log


def test_missing_file_fails_before_anything_runs(sandbox):
    tmp, env = sandbox
    (tmp / FILES[-1]).unlink()
    r = subprocess.run(
        ["bash", str(tmp / "configure_all.sh")], env=env, capture_output=True, text=True
    )
    assert r.returncode != 0
    assert not (tmp / "docker.log").exists()
