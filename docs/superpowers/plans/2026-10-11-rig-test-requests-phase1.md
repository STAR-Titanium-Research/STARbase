# Rig test requests, phase 1: request, consent, operator steps, report

Spec: [`specs/2026-10-11-rig-test-requests-design.md`](../specs/2026-10-11-rig-test-requests-design.md).
Decision: [ADR-0012](../../adr/0012-rig-test-requests-over-github-issues.md) (Proposed until
phase 1 is merged). Delete this plan once phase 1 has shipped in a release and its backlog
entries have been run on the rig.

Phase 1 delivers the whole loop with **operator steps only** (`ask`, `note`). Automated actions,
snapshot and restore, Run automated only, and Directus uploads are phase 2. The live Claude loop
is phase 3. Both get their own plan.

## Status

| Stream | Worktree | Branch | Agent profile | State |
|---|---|---|---|---|
| A. Relay endpoints | `.claude/worktrees/agent-a173c86a1bfb243bc` | `worktree-agent-a173c86a1bfb243bc` | `force-app-implementer` (sonnet, high) | done (4 commits, relay 43 tests pass), awaiting review |
| B. Backend `rig_test` package + rig lock | agent worktree | worktree branch | `force-app-implementer` (sonnet, high) | in progress |
| C. Web prompt, run modal, Settings tab, desktop notify | agent worktree | worktree branch | `force-app-implementer` (sonnet, high) | in progress (codes against the contract below, not B's code) |
| D. Docs, conventions, deploy config | coordinator | `ccr-52e8d6c9-5rl4pg` | coordinator | in progress |
| Review | — | — | `force-app-reviewer` (opus, high), then a security review (opus, high) | — |

Workflow per stream (owner's instruction, 2026-10-11): plan → code → `/simplify` → debug (full suites, typecheck, `force-app-verify` where it applies) → Opus review → security review → coordinator merge.

Update this table when a stream starts, finishes, is reviewed or is merged, and fold that commit
into the next code push (CLAUDE.md, "CI minutes").

## Contract between B and C (fixed here so both can start at once)

Backend REST (loopback, like every other route):

```
GET  /rig-tests/eligibility   -> {eligible: bool, rig_id: str, reason?: str, relay: "ok"|"unreachable"|"not_configured"}
GET  /rig-tests/pending       -> {requests: [Request]}           # oldest first; excludes snoozed until due
POST /rig-tests/{n}/accept    {mode: "full", upload_busy: bool}  -> {ok} | 409 {detail}
POST /rig-tests/{n}/snooze    {until: ISO8601 | "after_recording"} -> {ok}
POST /rig-tests/{n}/decline   {reason_code, text?}               -> {ok}
GET  /rig-tests/run           -> Run | {state: "idle"}
POST /rig-tests/run/answer    {step: int, option: str, note?: str} -> {ok} | 409
POST /rig-tests/run/cancel    -> {ok}
GET  /rig-tests/history       -> {runs: [RunSummary]}            # last 50, from rig-tests/<n>/result.json

Request    = {number, title, url, requested_by, created_at, items: [{id, title, steps: Step[]}],
              estimate_s: {full, automated}, needs_operator_steps: int, error?: str}
Step       = {index, item_id, kind: "ask"|"note", text, options?: str[], pass?: str[], est_s, after?: int}
Run        = {number, state: "running"|"done"|"partial"|"cancelled"|"timed_out",
              started_at, deadline_at, elapsed_s, estimate_s,
              steps: [{index, item_id, kind, text, status: "pending"|"active"|"pass"|"fail"|
                       "no_response"|"skipped_dependency"|"cancelled"|"error", answer?, note?}],
              current?: int, question?: {step, text, options, expires_at}}
decline reason_code ∈ {about_to_record, machine_in_use, rig_not_set_up, not_today, other}
```

The web polls `GET /rig-tests/pending` every 30 s, and `GET /rig-tests/run` every 1 s while a run
is active. There is no websocket in phase 1.

## Stream A: relay (`apps/force-app/bug-report-relay/`)

Owns: `server.py`, `test_server.py`, `README` text in the module docstring.

1. Add `RIG_TEST_ALLOWED_LOGINS` (comma-separated, case-insensitive). If it's empty, every
   `/rig-tests*` endpoint returns `{"ok": false, "reason": "rig tests not configured"}`, never 500.
2. `GET /rig-tests`: open issues with the label `rig-test-request` (per_page 50). For each one, call
   `GET /repos/{repo}/issues/{n}/events`. The most recent `labeled` event for `rig-test-request`
   must have an `actor.login` on the allowlist, or the issue is left out (and logged at INFO).
   Return `{number, title, body, url, requested_by, created_at, state_label}`. Cache for 30 s.
3. `POST /rig-tests/{n}/comment {body}` creates a comment and returns `{ok, id}`.
   `PATCH /rig-tests/{n}/comment/{id} {body}` edits it, but only if the comment's author is the
   App's own bot. Both refuse unless issue n is open and carries `rig-test-request`. The body is at
   most 60 000 chars.
4. `POST /rig-tests/{n}/state {state}` takes a state in `deferred|declined|running|partial|done|interrupted`,
   sets `rig-test:<state>` and removes the other `rig-test:*` labels. It creates the labels if they
   are missing.
5. Tests (mock GitHub with `respx` or the existing pattern in `test_server.py`): a labeller not on
   the allowlist is excluded, the most recent labeller wins, the endpoints fail closed when not
   configured, a comment on an issue that isn't a rig-test issue is refused, PATCH of a comment by
   someone else is refused, and the state labels swap.

Run: `cd apps/force-app/bug-report-relay && python -m pytest -q`.

## Stream B: backend (`apps/force-app/backend/app/rig_test/`)

Owns: `app/rig_test/*`, the rig-test routes and lock hooks in `app/main.py`,
`force-app-backend.spec` (datas), `tests/test_rig_test_*.py`. Touch nothing else in `main.py`
beyond what's listed.

1. `relay.py`: a client for stream A's endpoints. It reuses `bug_report._relay_url()`, has a 10 s
   timeout and never raises: failures come back as `{ok: false, reason}`.
2. `eligibility.py`: eligible only when `_devices()` reports `simulated=False` with at least one
   chassis, and `_labamp` is not a `MockLabAmp`. For tests and the hardware-free
   `force-app-verify` run, `FORCE_APP_RIG_TEST_ALLOW_SIM=1` overrides this. The rig id is
   `FORCE_APP_RIG_ID`, or `socket.gethostname()` if that isn't set.
3. `catalog.py`: parses `catalog.md`, the bundled copy of `docs/runbooks/physical-test-backlog.md`,
   into items `{id, title, prose, block?}`. The id comes from the bold lead (`**R4 — …**` →
   `R4`, `**#190 …**` → `#190`), and the first occurrence wins. It also parses the issue body's
   `rig-test` fence (YAML: `rig`, `items`, `steps`) and resolves each item: with no block, the
   item becomes one `ask` step showing its prose, with options Pass, Fail, Skip and
   `pass: [Pass]`. In phase 1 only the `ask` and `note` kinds are valid. Any other kind makes the
   request invalid ("action X arrives in phase 2"). It computes the estimates (ask 120 s, note
   30 s). Use bounded pydantic models for steps (text ≤ 1000 chars, ≤ 6 options, ≤ 50 steps).
   Add `catalog.md` to the spec's `datas`, and add a `scripts/` copy step to the backend build so
   the packaged app carries the backlog version it was built with.
4. `poller.py`: a daemon thread like `BackupStreamer` (`app/backup.py`). It polls every 60 s, and
   not while `_busy()` or a run is active. It filters by `rig:` and keeps a pending list plus the
   snoozes, persisted in `<config dir>/rig_tests_state.json`. An invalid request is posted once as
   a comment ("invalid request: …") and its state set to `declined`.
5. `runner.py`: one run at a time. It's a thread that walks the steps. An `ask` step waits up to
   300 s for `/run/answer`, then marks the step `no_response`. `after:` dependencies are skipped
   when the step they depend on did not pass. The hard time limit is
   `min(1.5 × estimate, 30 min)`. It posts the progress comment when the run starts, edits it
   after each step, and posts the result comment at the end, then sets the state label: `done`
   when every step passed, `partial` otherwise. It writes `rig-tests/<n>/result.json` under the
   captures root.
6. **Lock**: `owns_rig()` is true while a run is active. In `main.py`, extend `_busy()`'s callers
   as follows. `record_start`, `start_replay`, `POST /labamp/mode`, `/labamp/autorange/apply`,
   `/labamp/autorange/converge`, `/labamp/sensors/write`, `/labamp/config`,
   `PUT /nidaq/channels`, `/nidaq/tacho/start` and `POST /storage/config` all return
   `409 "a rig test is running (issue #N); cancel it from the rig-test window"` while
   `owns_rig()` is true. Phase 1 runs make no recordings, so there is no bypass token yet.
   Accepting a request returns 409 while `_busy()`, while `recovery._recovering` or `recovery._discarding` is non-empty (add a public `recovery.any_in_flight()` rather than reading the privates), or
   when `upload_busy`.
7. `report.py`: renders the progress and result comments as in the spec, "Report format",
   including the hidden `<!-- rig-test-result {...} -->` JSON. Escape operator notes with
   `bug_report._fence`-style backtick breaking, and redact Windows user paths with
   `bug_report._redact_paths`.
8. Tests, against the sim source and `MockLabAmp`, with `relay.py` monkeypatched: catalogue
   parsing of real backlog snippets (R4, #190, an item with no id), invalid kinds rejected, the
   estimates, dependency skipping, no_response after the timeout (inject a clock), the hard time
   limit, cancel, every locked endpoint returning 409 during a run and 200 after, accept returning
   409 while recording, snooze and decline posting the right comment and label, and report
   rendering (golden strings).

Run: `cd apps/force-app/backend && python -m pytest -q tests/test_rig_test_*.py` and then the
full suite.

## Stream C: web and desktop

Owns: `web/src/rigtest/*` (new), `web/src/settings/RigTestsSettings.vue` (new), one tab entry in
`settings/SettingsPage.vue`, one mount in `AppShell.vue`, the rig id line in
`settings/AboutSettings.vue`, and a `notify` bridge in `desktop/src/preload.ts` and
`desktop/src/main.ts` (with its test).

1. `rigtest/rigTestApi.ts`: typed client for the contract above, using `recorderHttp`.
2. `rigtest/rigTestStore.ts`: polling (30 s pending, 1 s run), with the recording state from the
   existing record status. Unit-test the decisions in plain functions: show a dialog or a badge,
   the estimate text, the countdown.
3. `RigTestPrompt.vue`: shown on every page through `AppShell`. While recording or finalizing, it
   is only a badge on the Settings sidebar item. Otherwise it's a dialog with who asked, the issue
   link, the items, "about N min, K steps need you", **Run now**, **Snooze** (30 min, 2 h, at a
   time, after this recording) and **Decline**. Decline offers the reason chips plus "Other…" with
   text. It sends `upload_busy` from the upload queue (`record/directusSync.ts`) on accept, and
   shows a 409's detail inline.
4. `RigTestRunModal.vue`: shows the title, a progress bar (steps and time), the step list with
   status marks, the current step, and **Cancel** (with a confirmation). **Minimise** turns it
   into a bar along the bottom edge of the screen ("Rig test #N, step i/n, about m min left,
   Cancel") that stays visible on every page. When `question` is set, the modal opens again with
   the question, the option buttons, a note field and the countdown to `expires_at`. Respect the
   existing z-order rules (`z-order.test.ts`) and the Save dialog: the modal must never sit on top
   of an open recording Save dialog.
5. `RigTestsSettings.vue`: shows eligibility and its reason, the relay state, the rig id, the
   pending and snoozed requests (with Run, Snooze and Decline), and the history (state, date,
   issue link, pass/fail counts).
6. Desktop: `notify(title, body)` in the preload calls `new Notification` and `flashFrame(true)`
   when the window isn't focused. Validate the arguments as strings of at most 200 chars, as the
   other IPC handlers do.
7. Tests: vitest for the store's decision functions, and one e2e in `web/e2e` with a stubbed
   backend (pending → accept → ask → answer → done; cancel; minimise bar).

Run: `cd apps/force-app/web && npm test && npm run build`, plus `cd ../desktop && npm test`.

## Stream D: coordinator

1. `physical-test-backlog.md` header: document the optional `rig-test` block (format from the
   spec), say that new rig items should carry one from now on, and add the phase-1 §B section
   "Rig test requests (phase 1)": first real request accepted on the rig, the prompt during a
   recording (badge only), Cancel during an `ask`, no response after 5 min, the result comment
   and labels on the issue, `FORCE_APP_RIG_ID` shown in About.
2. `CLAUDE.md` "Physical test backlog": one line saying a rig item can now be run from an issue
   (`rig-test-request` label plus a `rig-test` block listing item ids).
3. `.claude/skills/triage-bug-reports/SKILL.md`: read `<!-- rig-test-result -->` comments on
   `rig-test:done` and `rig-test:partial` issues, tick `pass` items in the backlog in a PR, and open
   or reopen issues for `fail`.
4. d1-server: add `RIG_TEST_ALLOWED_LOGINS` to the relay's service in `docker-compose.yml` and to
   `.env.example`, and add a §C backlog item to redeploy the relay with it set.
5. After review: ADR-0012 → Accepted, the spec's Status line and both README rows updated.

## Review and merge

`force-app-reviewer` on A+B and on C, focusing on: no request-supplied text reaches anything but
the operator's screen and the report; the lock covers every listed endpoint; nothing can start a
run without `/accept`; the relay can't post outside rig-test issues. Then run
`force-app-verify` with `FORCE_APP_RIG_TEST_ALLOW_SIM=1` and a fake relay to take screenshots of
the prompt, the modal, the minimise bar and the Settings tab. The coordinator merges A, B and C in
that order.
