---
name: freeze
description: Restrict file edits to one or more directories for the rest of the session (e.g. /freeze apps/force-app/web). Any Edit or Write outside them is blocked by a hook. Use for focused work in one package, or when a change must not spill into the schema, core or other apps.
disable-model-invocation: true
argument-hint: <dir> [dir...]   |   off
hooks:
  PreToolUse:
    - matcher: "Edit|Write|NotebookEdit"
      hooks:
        - type: command
          command: python3 "$CLAUDE_PROJECT_DIR/.claude/skills/freeze/guard.py"
          timeout: 5
---

# Freeze edits to a scope

Requested scope: `$ARGUMENTS`

1. Write the scope to `.claude/freeze-paths` with Bash, one repo-relative directory per line,
   e.g. `printf '%s\n' apps/force-app/web packages/force-plotting > .claude/freeze-paths`.
   If the argument is `off`, run `rm -f .claude/freeze-paths` instead. The file is gitignored.
2. Confirm the active scope to the user in one line.

From now on the hook rejects Edit/Write on anything outside the scope. When it does:
- Don't work around it with Bash redirects, `sed -i` or `cp`. Those bypass the hook but not
  the intent.
- Finish the in-scope work, then list the out-of-scope changes you'd make (file and what to
  change) so the user can widen the scope or do them separately.

The hook stays registered for the session. Clearing `.claude/freeze-paths` lifts the
restriction without a restart.
