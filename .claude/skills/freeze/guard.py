#!/usr/bin/env python3
"""PreToolUse guard for the /freeze skill.

Blocks Edit/Write/NotebookEdit on any file outside the directories listed (one per
line, relative to the repo root) in .claude/freeze-paths. No file, or an empty one,
means no restriction. Exit 2 blocks the call and returns the reason to Claude.
"""

import json
import os
import sys
from pathlib import Path

root = Path(os.environ.get("CLAUDE_PROJECT_DIR", ".")).resolve()
config = root / ".claude" / "freeze-paths"


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0
    path = payload.get("tool_input", {}).get("file_path") or payload.get(
        "tool_input", {}
    ).get("notebook_path")
    if not path or not config.is_file():
        return 0
    allowed = [line.strip().strip("/") for line in config.read_text().splitlines()]
    allowed = [a for a in allowed if a and not a.startswith("#")]
    if not allowed:
        return 0

    target = Path(path)
    target = (target if target.is_absolute() else root / target).resolve()
    for a in allowed:
        base = (root / a).resolve()
        if target == base or base in target.parents:
            return 0
    print(
        f"/freeze: {target.relative_to(root) if root in target.parents else target} is outside "
        f"the frozen scope ({', '.join(allowed)}). Leave it unchanged and tell the user what you "
        "would change there instead, or ask them to widen the scope.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
