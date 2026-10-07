#!/usr/bin/env bash
# Run the force-app recorder backend hardware-free (simulated NI-DAQ, mock Lab Amp) with
# throwaway capture/config/log dirs, as docs/wiki/force-app/developer-guide.md describes.
#
# Usage: backend.sh start|stop|status
#   FA_DIR    scratch root for captures/config/logs (default /tmp/fa)
#   FA_PORT   port (default 8200 — the web app's default recorder URL)
#   FA_PYTHON python with the backend installed (default apps/force-app/backend/.venv/bin/python,
#             created with `pip install -e ".[dev]"` on first start)
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
backend="$root/apps/force-app/backend"
dir="${FA_DIR:-/tmp/fa}"
port="${FA_PORT:-8200}"
py="${FA_PYTHON:-$backend/.venv/bin/python}"
pidfile="$dir/backend.pid"

health() { curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; }

case "${1:-start}" in
  start)
    if health; then echo "backend already up on :$port"; exit 0; fi
    if [[ ! -x "$py" ]]; then
      echo "creating $backend/.venv (one-off, ~30 s)" >&2
      python3 -m venv "$backend/.venv"
      "$backend/.venv/bin/pip" install -q -e "$backend[dev]"
      py="$backend/.venv/bin/python"
    fi
    mkdir -p "$dir"/{captures,config,logs}
    (cd "$backend" && FORCE_APP_CAPTURES="$dir/captures" FORCE_APP_CONFIG_DIR="$dir/config" \
      FORCE_APP_LOG_DIR="$dir/logs" LABAMP_MODE=mock \
      nohup "$py" -m uvicorn app.main:app --host 127.0.0.1 --port "$port" \
      >"$dir/uvicorn.out" 2>&1 & echo $! >"$pidfile")
    for _ in $(seq 1 60); do health && break; sleep 0.5; done
    health || { echo "backend failed to start; see $dir/uvicorn.out" >&2; tail -20 "$dir/uvicorn.out" >&2; exit 1; }
    echo "backend up: http://127.0.0.1:$port  (captures $dir/captures, log $dir/logs/backend.log)"
    ;;
  stop)
    [[ -f "$pidfile" ]] && kill "$(cat "$pidfile")" 2>/dev/null || true
    # Also catch a server whose pidfile is gone (e.g. a killed shell).
    pkill -f "uvicorn app.main:app --host 127.0.0.1 --port $port" 2>/dev/null || true
    rm -f "$pidfile"; echo "backend stopped (scratch data left in $dir)"
    ;;
  status)
    health && curl -fsS "http://127.0.0.1:$port/record/status" && echo || echo "backend down"
    ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
