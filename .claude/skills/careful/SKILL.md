---
name: careful
description: Guardrail mode for D1-Database. Blocks destructive commands (reset-db, DROP/TRUNCATE, docker volume removal, MinIO deletes, rm -rf, force-push, pushes to main, release tags, non-local DATABASE_URLs) for the rest of the session. Turn on before working near real lab data, the production stack or the archive share.
disable-model-invocation: true
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: python3 "$CLAUDE_PROJECT_DIR/.claude/skills/careful/guard.py"
          timeout: 5
---

# Careful mode

Careful mode is on for the rest of this session. A PreToolUse hook (`guard.py`) now refuses
Bash commands that can destroy experimental data or shared history. You'll see the reason
when one is blocked.

When a command is blocked:
- Don't rephrase it to get past the pattern. The block is the point.
- If the command is genuinely needed, stop. Tell the user the exact command and why, and let
  them run it themselves.
- Prefer a non-destructive alternative: a scratch database
  (`.claude/skills/db-migration/scripts/scratch_pg.sh`), `--dry-run` flags
  (`make migrate-legacy-dry`, `make index-archive-dry`), or a new migration instead of a
  rollback.

Lab data here is irreplaceable: sintering runs, machining captures, 10–100 GB force files.
There's no undo for a dropped volume or a deleted MinIO object, and backups are only as recent
as the last `make backup`.

To extend the guard, add a `(regex, reason)` pair to `RULES` in `guard.py`. Test it with:
`echo '{"tool_name":"Bash","tool_input":{"command":"make reset-db"}}' | python3 .claude/skills/careful/guard.py; echo $?`
(expect `2`).
