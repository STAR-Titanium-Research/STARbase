#!/usr/bin/env python3
"""PreToolUse guard for the /careful skill.

Reads the hook payload on stdin and blocks (exit 2, reason on stderr) Bash commands
that destroy lab data, rewrite shared history or reach production. Everything else
passes (exit 0). Patterns are deliberately broad: a false positive costs one
"run it yourself", a false negative can cost real experimental data.
"""

import json
import re
import sys

RULES = [
    # Database
    (r"\bmake\s+(reset-db|migrate-down|restore)\b", "drops or rolls back the database"),
    (r"\bdbmate\b.*\b(drop|down|rollback)\b", "rolls back or drops the schema"),
    (
        r"\b(DROP\s+(TABLE|SCHEMA|DATABASE|VIEW|FUNCTION|TRIGGER)|TRUNCATE)\b",
        "destructive SQL",
    ),
    (r"\bDELETE\s+FROM\b(?![^;]*\bWHERE\b)", "DELETE without WHERE"),
    (r"\bdropdb\b", "drops a database"),
    # Containers and volumes (postgres_data, minio_data, the SMB archive)
    (r"\bdocker\s+compose\b.*\bdown\b.*(-v\b|--volumes)", "deletes compose volumes"),
    (r"\bdocker\s+(volume\s+(rm|prune)|system\s+prune)", "deletes Docker volumes"),
    # Object storage and files
    (r"\bmc\s+(rm|rb)\b", "deletes MinIO objects or buckets"),
    (r"\baws\s+s3\s+(rm|rb)\b", "deletes S3/MinIO objects"),
    (
        r"\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]",
        "recursive force delete",
    ),
    (
        r"\b(rm|mv|cp|rsync|truncate|shred|tee)\b[^|;&]*(/mnt/archive|star_group1)",
        "writes to the lab archive share",
    ),
    (r"\bfind\b.*\s-delete\b", "bulk delete"),
    # Git
    (r"\bgit\s+push\b.*(--force\b|-f\b|--force-with-lease)", "force-push"),
    (r"\bgit\s+push\b.*\b(origin\s+)?main\b", "push to main"),
    (
        r"\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s+\.|restore\s+\.)",
        "discards work",
    ),
    (
        r"\bgit\s+(tag|push)\b.*\bforce-app-v",
        "creates or pushes a force-app release tag",
    ),
    # Production
    (
        r"DATABASE_URL=\S*@(?!localhost|127\.0\.0\.1|postgres[:/])",
        "DATABASE_URL points at a non-local host",
    ),
]


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0
    if payload.get("tool_name") != "Bash":
        return 0
    command = payload.get("tool_input", {}).get("command", "")
    for pattern, why in RULES:
        if re.search(pattern, command, re.IGNORECASE):
            print(
                f"/careful blocked this command ({why}). If it is really intended, "
                "stop and ask the user to run it themselves, quoting the exact command.",
                file=sys.stderr,
            )
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
