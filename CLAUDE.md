# CLAUDE.md

## Resuming interrupted work

Long agentic runs here get interrupted: usage limits stop every running agent at once, cloud
containers restart, and a resumed session can come back with stale context (for example, the
conversation from before a `/clear`). Treat the repo, not your memory, as the source of truth.

**On resume, or whenever "continue" doesn't match what you remember, before doing anything else:**

1. `git status`, `git log --oneline -10` and `git branch -a` on the working branch.
2. `git worktree list`. Each `.claude/worktrees/agent-*` is a worker's checkout. For each one,
   run `git -C <wt> log --oneline <base>..HEAD` and `git -C <wt> status --short` to see what's
   committed and what isn't.
3. Read the active plan in `docs/superpowers/plans/` (newest first), including its **Status**
   table, to see which streams are done, in progress or merged.
4. If the plan and the worktrees disagree, or you still can't tell what was asked, read the
   session transcript under `~/.claude/projects/<project>/*.jsonl`. List the user messages and
   the `Agent` tool calls, with their descriptions and prompts, and the task notifications that
   say whether each agent completed, failed or was killed.
5. Tell the user what you found and what you are resuming before relaunching anything.

A killed or limit-stopped agent can be resumed with `SendMessage` to its agent id, which keeps
its context. If that fails, relaunch a fresh agent pointed at the same worktree. Give it the
original brief, plus a summary of what is already committed and what is left uncommitted.

## Running parallel work so it survives interruption

- **Plans.** Write multi-stream plans to `docs/superpowers/plans/` with a Status table, one row
  per stream: worktree id, branch, state. Update the table whenever a stream starts, finishes,
  is reviewed or is merged, and commit and push the plan.
- **Agent briefs.** Make each brief self-contained: the plan section, the files it owns, the
  tests to run and the commit trailer lines. That way any agent can pick the stream up again.
- **Workers commit early.** One commit per fix in the worker's worktree branch. Uncommitted
  edits survive a usage-limit stop but not a container reclaim.
- **Merges.** The coordinator merges stream branches only after reviewing them. Workers never
  push, merge or rebase.
- **Usage budget.** Run implementation workers on Sonnet (`model: "sonnet"`) at high effort,
  three or four at a time. Six Opus workers in parallel used up the 5-hour usage limit in about
  12 minutes. Keep Opus for planning, review and the coordinator.
- **Agent profiles.** Launch workers and reviewers with the committed profiles in
  `.claude/agents/` (`subagent_type`), not a generic agent with the rules pasted into the brief:
  `directus-ui-implementer`, `directus-ui-reviewer`, `force-plotting-implementer`, `force-app-implementer`, `force-app-reviewer`. They are in git,
  so they survive restarts, and they preload their area's conventions skill. If no profile fits
  the area, add one (and its conventions skill) and push it before launching.
- **Local-only config.** `.claude/skills/`, `.claude/agents/`, `.claude/agent-memory/`,
  `.claude/hooks/` and `.claude/settings.json` are committed. The rest of `.claude/` is
  gitignored (worktrees, local settings), so it exists only in the current container. Anything
  that must outlive it goes in the repo or gets pushed.

## Physical test backlog

Cloud sessions and CI have no Directus with real data, no NI-DAQ rig and no packaged Windows app.
Whenever a change can only be confirmed on one of those (anything a PR would list as "not tested
on real systems"), add the check to [`docs/runbooks/physical-test-backlog.md`](docs/runbooks/physical-test-backlog.md)
in the same PR, under the right section, with what to do, what to expect and the PR it came from.
Never remove an unticked item because it is inconvenient; tick it with a date and result once it
has actually been run.
