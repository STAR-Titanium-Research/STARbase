"""entrypoint.sh: when either long-running process dies, the container exits.

The real gunicorn / rq / python are replaced by stubs on PATH.
"""

import os
import subprocess
import time
from pathlib import Path

import pytest

ENTRYPOINT = Path(__file__).parent.parent / "entrypoint.sh"


def _stub(bindir: Path, name: str, body: str) -> None:
    p = bindir / name
    p.write_text("#!/bin/bash\n" + body + "\n")
    p.chmod(0o755)


def _run(tmp_path, stubs: dict[str, str], timeout=20):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    for name, body in stubs.items():
        _stub(bindir, name, body)
    env = {**os.environ, "PATH": f"{bindir}:{os.environ['PATH']}"}
    started = time.monotonic()
    proc = subprocess.run(
        ["bash", str(ENTRYPOINT)],
        env=env,
        timeout=timeout,
        capture_output=True,
        text=True,
        check=False,
    )
    return proc, time.monotonic() - started


STAY_UP = 'echo $$ >> "$PIDFILE"; exec sleep 60'


@pytest.fixture
def pidfile(tmp_path, monkeypatch):
    p = tmp_path / "pids"
    monkeypatch.setenv("PIDFILE", str(p))
    return p


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def test_crashed_rq_worker_stops_the_container(tmp_path, pidfile):
    proc, elapsed = _run(
        tmp_path,
        {
            "gunicorn": STAY_UP,
            "python": STAY_UP,
            "rq": "sleep 0.5; exit 3",
        },
    )
    assert proc.returncode == 3
    assert elapsed < 15  # did not wait for the 60 s sleepers
    time.sleep(0.3)
    assert not any(_alive(int(p)) for p in pidfile.read_text().split())


def test_dead_webhook_stops_the_container(tmp_path, pidfile):
    proc, _ = _run(
        tmp_path,
        {"gunicorn": "sleep 0.5; exit 7", "python": STAY_UP, "rq": STAY_UP},
    )
    assert proc.returncode == 7


def test_clean_exit_of_a_child_is_still_a_failure(tmp_path, pidfile):
    proc, _ = _run(
        tmp_path,
        {"gunicorn": "sleep 0.5; exit 0", "python": STAY_UP, "rq": STAY_UP},
    )
    assert proc.returncode != 0
