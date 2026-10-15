"""entrypoint.sh: one or two rq workers (renders at a time), and the poller is supervised too."""

import subprocess
from datetime import UTC, datetime

import pytest

from .test_entrypoint import STAY_UP, _run, pidfile  # noqa: F401 - the PIDFILE fixture

pytestmark = pytest.mark.usefixtures("pidfile")


def _count_stub(name: str) -> str:
    """A stub that logs one line per start to $STARTS, then stays up."""
    return f'echo {name} >> "$STARTS"; ' + STAY_UP


def _env(tmp_path, monkeypatch, concurrency):
    starts = tmp_path / "starts"
    monkeypatch.setenv("STARTS", str(starts))
    if concurrency is None:
        monkeypatch.delenv("SURFACE_SCAN_CONCURRENCY", raising=False)
    else:
        monkeypatch.setenv("SURFACE_SCAN_CONCURRENCY", concurrency)
    return starts


@pytest.mark.parametrize("concurrency,workers", [(None, 1), ("1", 1), ("2", 2)])
def test_runs_one_or_two_rq_workers(tmp_path, monkeypatch, concurrency, workers):
    starts = _env(tmp_path, monkeypatch, concurrency)
    proc, _ = _run(
        tmp_path,
        {
            "gunicorn": _count_stub("gunicorn"),
            "python": _count_stub("poller"),
            # an rq worker that dies after the others have had time to start ends the run
            "rq": 'echo rq >> "$STARTS"; sleep 1.5; exit 5',
        },
    )
    assert proc.returncode == 5
    lines = starts.read_text().split()
    assert lines.count("rq") == workers
    assert lines.count("gunicorn") == 1
    assert lines.count("poller") == 1


@pytest.mark.parametrize("bad", ["0", "3", "many"])
def test_more_than_two_renders_at_a_time_is_refused(tmp_path, monkeypatch, bad):
    _env(tmp_path, monkeypatch, bad)
    proc, _ = _run(tmp_path, {"gunicorn": STAY_UP, "python": STAY_UP, "rq": STAY_UP})
    assert proc.returncode == 2
    assert "SURFACE_SCAN_CONCURRENCY" in proc.stderr


def test_the_start_time_is_exported_before_any_child_starts(tmp_path, monkeypatch):
    """The poller's startup sweep needs the container's start, not the time its imports finished."""
    _env(tmp_path, monkeypatch, "2")
    monkeypatch.delenv("SURFACE_SCAN_STARTED_AT", raising=False)
    seen = tmp_path / "seen"
    monkeypatch.setenv("SEEN", str(seen))
    record = 'echo "$0 $SURFACE_SCAN_STARTED_AT $(date -u +%s)" >> "$SEEN"; '
    before = int(
        subprocess.run(["date", "-u", "+%s"], capture_output=True, text=True).stdout
    )
    proc, _ = _run(
        tmp_path,
        {
            "gunicorn": record + STAY_UP,
            "python": record + STAY_UP,
            "rq": record + "sleep 1; exit 4",
        },
    )
    assert proc.returncode == 4
    lines = [line.split() for line in seen.read_text().splitlines()]
    assert len(lines) == 4  # gunicorn, two rq workers, the poller
    stamps = {line[1] for line in lines}
    assert len(stamps) == 1  # every child got the same value
    (stamp,) = stamps
    started = datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    assert before - 1 <= started.timestamp() <= min(int(line[2]) for line in lines)


def test_dead_poller_stops_the_container(tmp_path, monkeypatch):
    _env(tmp_path, monkeypatch, None)
    proc, _ = _run(
        tmp_path,
        {"gunicorn": STAY_UP, "python": "sleep 0.5; exit 9", "rq": STAY_UP},
    )
    assert proc.returncode == 9
