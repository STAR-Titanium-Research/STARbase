"""Entry point for the PyInstaller-frozen backend. The Electron sidecar (apps/force-app/desktop)
spawns the frozen exe with `--port <n>`; this runs uvicorn in-process rather than shelling out to
the `uvicorn` CLI (which isn't present inside a frozen bundle), bound to loopback only — the
sidecar is reached solely by the Electron renderer on the same machine.
"""

from __future__ import annotations

import argparse

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8200)
    args = parser.parse_args()
    # access_log=False (#106): uvicorn writes one stdout line per request, and nothing ever read
    # them — they never reached backend.log either (uvicorn.access does not propagate to the root
    # handlers). On a pipe that a parent fails to drain, those writes eventually block the event
    # loop and hang every endpoint. The sidecar drains stdout now too; this removes the flood.
    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=args.port,
        log_level="info",
        access_log=False,
    )


if __name__ == "__main__":
    main()
