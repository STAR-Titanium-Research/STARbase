#!/usr/bin/env python3
"""PreToolUse hook (matcher: Skill): append one line per skill invocation to
.claude/skill-usage.log (gitignored), so we can see which skills are used and which
never trigger. Summarise with:

    cut -f2 .claude/skill-usage.log | sort | uniq -c | sort -rn

Never blocks: any error exits 0.
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    payload = json.load(sys.stdin)
    tool_input = payload.get("tool_input", {})
    skill = tool_input.get("skill") or tool_input.get("name") or "?"
    args = " ".join(str(tool_input.get("args", "")).split())[:120]
    log = (
        Path(os.environ.get("CLAUDE_PROJECT_DIR", ".")) / ".claude" / "skill-usage.log"
    )
    # timezone.utc, not datetime.UTC: hooks run on whatever python3 a developer has (UTC is 3.11+).
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: UP017
    with log.open("a", encoding="utf-8") as fh:
        fh.write(f"{stamp}\t{skill}\t{payload.get('session_id', '')[:8]}\t{args}\n")
except Exception:  # noqa: BLE001 — a logging hook must never break a session
    pass
sys.exit(0)
