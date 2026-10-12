# Rig test requests: run backlog checks on the live rig from a GitHub issue

**Date:** 2026-10-11
**Status:** Design only. Decision record: [ADR-0012](../../adr/0012-rig-test-requests-over-github-issues.md).
**Amended 2026-10-12:** the shared rig token described below (`X-Rig-Token`,
`RIG_TEST_RELAY_TOKEN`, `FORCE_APP_RIG_TEST_TOKEN`) is replaced by the operator's D1 sign-in; see
[`2026-10-12-rig-test-d1-login-design.md`](2026-10-12-rig-test-d1-login-design.md).
Phase 1 plan: [`plans/2026-10-11-rig-test-requests-phase1.md`](../plans/2026-10-11-rig-test-requests-phase1.md).
The design choices come from a question-and-answer session with the maintainer on 2026-10-11.

## Problem

Fixes to the force app are written in cloud sessions with no rig. What needs the real NI-DAQ, Lab
Amp or packaged app goes into `docs/runbooks/physical-test-backlog.md` as prose and waits for a
rig day. The rig is usually in use by lab members, so the maintainer can't run checks whenever
they like. There's no way to ask whoever is at the rig to "let the app run R4 and #190 now", and
no record of the answer.

## Goals

- The maintainer, or a Claude session, requests tests by labelling a GitHub issue.
- The app on the rig PC, and only there, prompts the person using it. It says who asked, what
  will run, how long it should take and which steps need them.
- The operator can run the tests now, run only the automated steps, snooze until a time, or
  decline with a ready-made reason.
- No test starts or runs while a recording, finalize, recovery, restore or upload is in progress.
- A run can be minimised to a modal with a progress bar, the current step, the time left and a
  Cancel button. The modal pops up again when a step needs the operator.
- Automated steps run on their own. Operator steps are a dialog: "do this, then tell me what
  happened", with answer options and a note.
- Results go back to the issue as a comment that people can read and a session can parse, with
  captures and screenshots in Directus.
- A Claude session can drive a run live through issue comments (phase 3).

## Non-goals

- Running code, scripts or recipes supplied by a request. See ADR-0012 §3.
- Claude controlling the Windows desktop through computer use. That's still possible by hand, but
  it is not part of this design.
- Remote viewing of a live session (#97).
- Ticking `physical-test-backlog.md` from the rig. A cloud session does that in a PR.
- Unattended runs with nobody present ("run tonight"). This was considered and not chosen. The
  operator consents to every run.

## Flow

```
maintainer / Claude session                     GitHub issue                         d1-server relay                          rig PC (force app)
---------------------------                     ------------                         ---------------                          ------------------
open issue, rig-test block,  ───────────────▶  #N  label rig-test-request
apply label                                                                 ◀── GET  /rig-tests (every 60 s idle) ──  backend RigTestPoller
                                                                                checks: label applied by allowlisted
                                                                                login, body parses, rig matches
                                                                            ──▶ [request #N, items, estimate]   ───▶  prompt on screen
                                                comment "accepted by <op>,  ◀── POST /rig-tests/N/comment         ◀──  operator: Run now
                                                 est. 12 min" + label running
                                                                                                                       runner: snapshot → steps
                                                progress comment (edited    ◀── PATCH /rig-tests/N/comment/<id>   ◀──  after each step
                                                 in place, not one per step)
(live loop, phase 3)
comment ```rig-action```     ───────────────▶  comment by allowlisted login ◀── GET  /rig-tests/N/actions?since= ── every 3 s while live
                                                                            ──▶ validated actions               ───▶  runner queues them
                                                result comment + label done ◀── POST /rig-tests/N/comment         ◀──  restore → report
```

## Request format

A request is an issue in the repo the relay files to (`GITHUB_REPO`), with the label
`rig-test-request` applied by an allowlisted login. Its body holds one fenced block:

````markdown
```rig-test
rig: force-rig-1          # optional; omit = any eligible rig
budget: 20m               # optional; required for live runs (phase 3)
items: [R4, "#185", R5]   # backlog item ids to run, each resolved from the step catalogue
```
````

Items are resolved against the **catalogue**: the copy of `physical-test-backlog.md` bundled into
the backend at build time (`backend/app/rig_test/catalog.md`, copied there by the build and listed in the `datas` of
`force-app-backend.spec`). The backend parses each item's id, its prose and its `rig-test` block. Resolving
from the shipped copy, not from the issue body, is what keeps request text from turning into new
behaviour. It also matches how the backlog is used: a fix and its backlog entry land in the same
PR, so the release under test carries its own items. An id the build doesn't know is reported as
`unknown item (not in app <version>)`. An id that matches more than one backlog item is an
invalid request ("E5 matches 37 items in this app's backlog; ask for one by its full id"): the
backend never picks one. An id is `#190` or a letter-and-number token such as `R4`, plus any
hyphenated suffix (`E5-fix-ui`); it ends at the first space, colon, comma or slash.

An issue may also give inline steps under `steps:`, for one-off checks that aren't in the backlog.
They may only use vocabulary actions. An inline `ask` only shows text to the operator. It is
checked like everything else, and only allowlisted logins can write it.

### Step blocks in the backlog

From now on, every new rig item in `physical-test-backlog.md` gets a block straight after its
prose. Existing items are converted when someone works on them. An item with no block still runs:
the app shows its prose (up to 4000 characters; request-supplied inline text is limited to 1000)
as one `ask` step with Pass, Fail and Skip. Such a step defaults to a 10 min estimate, because it
is usually "record a cut, check X".

````markdown
- [ ] **R4 — pre-flight chips.** …prose as today…
  ```rig-test
  id: R4
  needs: [nidaq, labamp]
  steps:
    - do: labamp.set_mode        # automated
      mode: MEASURE
    - do: preflight.read
      expect: { amp: ok }
    - ask: Pull the Lab Amp's network cable. Within 10 s, does the Amp chip show a warning?
      options: [Yes, "No — still OK", Couldn't do it]
      pass: [Yes]
      est: 90s
    - ask: Plug the cable back in.
      options: [Done]
      est: 30s
    - do: preflight.read
      after: 4                   # skipped if step 4 wasn't done
      expect: { amp: ok }
  ```
````

Rules: every step has an estimate. Each action has a default estimate, and `ask` steps in a
block default to 2 min. `expect` compares fields in the action's result with literal values or ranges such as
`{ peak_n: [50, 500] }`. `after: <n>` makes a step depend on step n. If step n failed, was
skipped or got no response, this step is skipped too.

## Action vocabulary

Each action is defined once in `backend/app/rig_test/actions.py`: a name, a pydantic parameter
model with bounds, an executor, a default estimate, whether it needs the operator, and whether it
changes hardware state (if it does, the run captures that state first). Unknown names and
out-of-range parameters are rejected when the request is parsed, before anything runs.

| Action | Phase | What it does | Bounds |
|---|---|---|---|
| `ask` | 1 | Modal question, options, optional note; `pass:` says which options count as Pass | text ≤ 1000 chars, ≤ 6 options |
| `note` | 1 | Shows the operator an instruction with no answer needed (Continue) | |
| `status.read` | 2 | `/health/check`, `/record/status`, `/labamp/status`, NI-DAQ catalogue | |
| `preflight.read` | 2 | The Record page's pre-flight chip results | |
| `labamp.set_mode` | 2 | RESET or MEASURE (temporary; captured and restored) | |
| `labamp.set_range` | 2 | One channel's range (temporary; captured and restored) | ranges the amp reports |
| `labamp.autorange_propose` | 2 | Runs autorange and reports the proposal; **never applies it** | |
| `record` | 2 | A real recording through the normal `/record/start` path, tagged as a rig test | 1 to 120 s; rate ≤ the chassis maximum |
| `capture.read` | 2 | Fields from the run's own capture `summary.json` (peaks, `channels_ranging`, sizes) | only captures the run made |
| `capture.upload` | 2 | Upload that capture to Directus project "Rig tests" (renderer executes) | only captures the run made |
| `app.screenshot` | 2 | Screenshot of the app window, uploaded to Directus, link in the report | app window only, never the desktop |
| `app.navigate` | 2 | Opens a route (`/record`, `/plot`, …) so a following `ask` or screenshot shows it | routes from `router.ts` only |
| `wait` | 2 | Pause | ≤ 120 s |

Never in the vocabulary (ADR-0012 §3): `/labamp/sensors/write`, `PUT /nidaq/channels`,
`POST /labamp/config`, `/storage/*`, `/backup/config`, `DELETE /captures/*`, recovery and restore.

## Components

### Relay (`apps/force-app/bug-report-relay/server.py`)

New env: `RIG_TEST_ALLOWED_LOGINS` (comma-separated) and `RIG_TEST_RELAY_TOKEN` (the rig token).
If either is empty, all rig-test endpoints answer `{"ok": false, "reason": "rig tests not
configured"}`, the same fail-closed contract as `/report`. Every `/rig-tests*` call, `GET`
included, must carry the token in an `X-Rig-Token` header (compared in constant time); a missing
or wrong one gets HTTP 403 `{"ok": false, "reason": "rig token rejected"}`. The rig PC holds the
same token, from `FORCE_APP_RIG_TEST_TOKEN` or the first line of `<config dir>/rig_test_token`. It
is never built into the app, and never logged or put in a comment, report or diagnostics.

| Endpoint | Does |
|---|---|
| `GET /rig-tests` | Open issues labelled `rig-test-request`. For each one, check the issue's `labeled` events: the most recent application of the label must be by an allowlisted login, and the issue's author must be an allowlisted login too (an author can edit the block after the label is on), or the issue is left out. The labeller is found by reading the last page of events first (the `Link: rel="last"` header) and walking back, within a 10-page bound. An issue that can't be verified (too many events, a bad GitHub reply) is skipped and logged; it doesn't fail the list. Returns number, title, body, labeller, state label, created_at. Cached for 30 s, with an ETag to GitHub. |
| `GET /rig-tests/{n}/actions?since=<comment id>` | (phase 3) Comments after `since` that are by allowlisted logins, not by the App's own bot, and contain a `rig-action` block. Returns the raw blocks; the backend parses them. |
| `POST /rig-tests/{n}/comment` | Creates a comment, then returns its id. Refuses an issue that isn't an open `rig-test-request` issue, so it can't be used to post anywhere else. |
| `PATCH /rig-tests/{n}/comment/{id}` | Edits a comment the App created on that issue (the progress comment). Refuses a comment whose body holds a `<!-- rig-test-result` marker, so a result can't be rewritten. |
| `POST /rig-tests/{n}/state` | Sets one `rig-test:*` state label and removes the others. |

State labels: `rig-test:deferred`, `rig-test:declined`, `rig-test:running`, `rig-test:partial`,
`rig-test:done`, `rig-test:interrupted`. `rig-test-request` itself stays on the issue until the
run is `done`. A declined or partial request then shows up again at the next poll once its state
label is cleared, so the maintainer can ask again by removing it. The relay is reachable from the
whole tailnet, so network position is not trusted: without the rig token a tailnet host can
neither read requests nor post a comment (a forged result, say) or set a label through the
relay. With the token, the relay still only writes to an issue that passes the checks above, and
the rig never runs anything because of who called it, only because of GitHub authorship. The token
is a shared secret: anyone who can read the rig PC's config folder, or the relay's env, has it.

### Backend (`apps/force-app/backend/app/rig_test/`)

- `poller.py`: a background thread, like `BackupStreamer` in `backup.py`, that polls the relay
  every 60 s while the app is idle and every 3 s during a live run. It skips polling while
  `_busy()` or a run is active, and checks that before it checks eligibility, so it never adds
  load or enumerates DAQmx during a recording. It also retries the **outbox**: a result comment or
  label that the relay did not take at the end of a run, and the "interrupted" notice for a run
  that was active when the app last stopped, are kept in the state file and re-sent every poll
  until they get through.
- `eligibility.py`: answers requests only when `nidaq: simulated=False` with at least one chassis,
  and the Lab Amp client is not the mock. The rig id comes from `FORCE_APP_RIG_ID`, or is `rig` if
  that isn't set (never the Windows hostname: the id is posted on a public issue), and is shown in
  Settings → About. `FORCE_APP_RIG_TEST_ALLOW_SIM=1` (tests, hardware-free runs) makes any PC
  eligible only if `FORCE_APP_BUG_REPORT_RELAY_URL` is set to something other than the production
  relay, so a dev machine never answers requests from it. Without a rig token the PC is not
  eligible ("rig test token not set (see Settings → Rig tests)") and doesn't poll.
- `relay.py`: the client for the endpoints above; sends the rig token on every call.
- `catalog.py`: parses the bundled `catalog.md`, resolves a request's items, validates every step
  against `actions.py`, and computes the full and automated-only estimates.
- `runner.py`: the state machine. `pending → accepted → running → (done | partial | cancelled |
  timed_out | interrupted)`. While a run is active, `rig_test.owns_rig()` is true: accept
  refuses a second run and the poller stays quiet. The **rig lock** is narrower: it engages only
  while an *automated* step is executing (`runner.automated_step_active()`; never in phase 1, where
  every step is an `ask` or `note` and the operator has to use the rig to carry them out). While it
  is engaged, the runner's own recordings go through `/record/start` with an in-process token,
  and `/record/start`, `/record/start_replay`, `POST /labamp/mode`, `/labamp/autorange/apply`,
  `/labamp/autorange/converge`, `/labamp/sensors/write`, `PUT /nidaq/channels`,
  `/nidaq/channels/autoassign`, `/nidaq/tacho/start` and the storage writes return
  `409 "a rig test is running (issue #N); cancel it from the rig-test window"` for anyone else.
  The check is in a table (`lock_guard`) and also in `_refuse_nidaq_change_if_busy()` and next to
  each `_busy()` re-check after an await.
- **Snapshot and restore** (phase 2): before the first state-changing step, it saves the amp mode,
  per-channel ranges and params to `rig-tests/<n>/journal.json` (with fsync), and restores them on
  any end state. At startup, a journal with no end state means a crash: restore, mark it
  `interrupted` and post that.
- **Answer windows and the hard time limit.** An `ask` has max(5 min, 1.5× its estimate) to be
  answered, a `note` has 5 min; after that the step is `no_response` and the run carries on. The
  run's hard cap is min(2 h, max(1.5× the sum of the estimates, the sum of the windows)), so a run
  of default asks is never cut off before its last window. (An earlier draft capped a run at
  30 min; that was for automated steps holding the rig, and nothing is locked in phase 1.) For
  live runs the cap is 1.5× `budget`. When it runs out, the runner cancels the current step and
  ends as `timed_out`. `question.expires_at` is the earlier of the step's deadline and the run's,
  so the countdown the operator sees is the real one.
- Each run writes `rig-tests/<n>/result-<started>.json`, so asking for the same issue again
  doesn't overwrite the first result.
- `report.py`: builds the comments (format below).
- REST, loopback only like everything else: `GET /rig-tests/pending` (`{requests, snoozed,
  busy}`: `busy` is what accept refuses on, so the UI can stay in badge mode; `snoozed` lists
  snoozed requests with `snoozed_until`), `GET /rig-tests/run`
  (state, the current step and its index, elapsed and remaining time, pending question),
  `POST /rig-tests/{n}/accept {mode: full|automated}`, `/snooze {until}`, `/decline {reason}`,
  `POST /rig-tests/run/answer {step, option, note}`, `POST /rig-tests/run/cancel`, and
  `POST /rig-tests/run/minimise`, which is UI-only state kept so pop-outs agree.

Accepting is refused (409, with the reason shown on the prompt) while `_busy()`, while a recovery,
restore or discard holds a capture, or while the renderer reports an upload in flight. The
renderer sends its upload-queue state with the accept call.

### Web (`apps/force-app/web/src/rigtest/`)

- **`RigTestPrompt.vue`**, mounted in `AppShell.vue` so it shows on every page. The text is "Your
  admin has requested tests on this rig". It shows who asked (the labeller's login), the issue
  title and a link, the item list, and two estimates: "Full run: about 12 min, 3 steps need you"
  and "Automated only: about 4 min, nothing needed from you". The buttons are:
  - **Run now**
  - **Run automated only** (phase 2). Greyed out when no step is automated, and hidden when every
    step is.
  - **Snooze** ("in 30 min", "at 17:00", "after this recording")
  - **Decline** with these reasons: "About to record / mid-session", "Someone else is using the
    machine", "Rig not set up (no tool or sensor)", "Not today, ask tomorrow", "Other…" (free
    text).

  While a recording is running, the prompt is a small badge on the sidebar's Settings item, not
  a dialog. It never covers the Record page during a cut.
- **`RigTestRunModal.vue`**: a modal with the title, a progress bar (steps done / total, and time
  elapsed / estimate), the current step's name and a list of steps with ✓ ✗ – marks, and a
  **Cancel** button that asks for confirmation. **Minimise** turns it into a bar along the bottom
  edge of the screen ("Rig test #N, step 4/9, about 6 min left, Cancel") so the operator can browse
  Plot, Captures or Settings. An `ask` step brings the modal back up, with the question, option
  buttons, a note field and a countdown to `question.expires_at`. With no answer, the step is marked `no response`
  and the run carries on. In automated-only mode, `ask` steps are skipped, never shown.
- **Settings → Rig tests** tab (`settings/RigTestsSettings.vue`): pending, snoozed and past
  requests with their state, issue link and result summary, plus the rig id and whether this PC
  is eligible (and why not).
- **Desktop**: when a request arrives while the window is unfocused, the app uses
  `BrowserWindow.flashFrame` and shows a Windows notification. This goes through a preload
  `notify` bridge, so no new privileged surface beyond showing a notification.

## Report format

The progress comment is edited in place:

> **Rig test #231, running on force-rig-1**: accepted by D.P. at 14:02, full run, about 12 min.
> Step 4 of 9: R4 › `ask`: waiting for the operator.

The result comment is new, so that GitHub notifies the maintainer:

```markdown
### Rig test result: partial (force-rig-1, app 0.1.40, 14:02–14:13, accepted by D.P.)

| Item | Result | Evidence |
|---|---|---|
| R4 pre-flight chips | ✅ Pass | amp chip ok → warning after 6 s → ok; operator: "Yes" |
| #190 long cut | ⏭ Skipped (automated only) | needs the operator |
| R5 live clipping | ❌ Fail | step 3 expect `clipped.Fz1 == true`, got false; capture [20261011-140533](directus link) |

<!-- rig-test-result {"version":1,"issue":231,"rig":"force-rig-1","app":"0.1.40","items":[…]} -->
```

Result values: `pass`, `fail`, `no_response`, `skipped_automated_only`, `skipped_dependency`,
`cancelled`, `timed_out`, `error`. Only `pass` lets the ticking session tick a backlog item. The
ticking session writes `— <date>, rig test #N (op): OK` after the item, or for a fail
`FAIL, see #N` and a new or reopened issue, following the backlog's own rules.

The repository is public, so the comments carry no personal data: the operator is initials only
(the web sends initials and the recorder reduces anything else to initials, 12 characters at
most), and the rig id is `rig` unless an admin sets `FORCE_APP_RIG_ID`. Operator and request text
is fenced or escaped, with Windows account names redacted and `<!--` / `-->` broken up, so a note
can't add a second `rig-test-result` marker. Issue links are shown only if they look like
`https://github.com/<owner>/<repo>/issues/<n>`.

A result comment can't exceed GitHub's 60 000 characters. If it would, operator notes are shortened
first, then the table's evidence column. The hidden JSON is kept whole, and each item in it carries
its `title` so a ticking session can match the backlog line.

## Directus

The migration `…_rig_tests_project.sql` seeds one project, "Rig tests", and one operation under
it. `capture.upload` and `app.screenshot` upload with the signed-in operator's session, into that
project, with `notes = "rig test #<n>, step <i>"`. Dashboards and the campaign and explorer
views exclude that project. If no one is signed in, or the app is offline, the uploads are queued
like any capture, and the report says "upload queued".

## Error handling

- **Relay unreachable, or not configured**: nothing is shown. Settings → Rig tests says why. No
  rig token on this PC, or one the relay rejects (403), is shown the same way, with its own text.
- **The request body doesn't parse, or names an unknown item or action**: the request is never
  shown to the operator. The app posts one comment explaining the error and sets
  `rig-test:declined` with reason `invalid request`. This includes a body over 64 KB and a YAML
  value the parser can't build (`2026-13-01`, a 5000-digit number). One bad request never stops
  the poll: each issue is judged on its own, and an unexpected error on one is logged and skipped.
  An unchanged body that was already judged invalid is skipped before it is parsed again.
- **An action fails, for example a DAQmx error**: the step is marked `error` with the message,
  steps that depend on it are skipped, and the run continues.
- **The relay is down when a run ends**: the result comment and label are kept in the outbox and
  sent when the relay is back.
- **The app or the PC crashes mid-run**: at the next start the journal is restored and the run
  is reported as `interrupted` (through the outbox, so a relay outage can't lose the notice).
- **Two requests at once**: they are offered one at a time, oldest first.
- **A request is relabelled or closed mid-run**: the run finishes the current step, restores the
  state and reports `cancelled (request withdrawn)`.

## Testing

- **Relay** (`test_server.py`): allowlist filtering of labellers and comment authors, own-bot
  comments ignored, `POST comment` refused on issues that aren't rig-test issues, fail-closed
  when not configured.
- **Backend** (`tests/test_rig_test_*.py`): catalogue parsing and bounds, the estimates,
  automated-only filtering and dependency skipping, the lock on every endpoint listed above,
  accept refused while busy, cancel, the hard time limit, journal restore after a simulated
  crash, and report rendering, all against the sim source and `MockLabAmp`.
- **Web** (vitest): prompt states (recording → badge), the modal's progress, the minimise bar,
  the ask countdown, and estimate text. **e2e** through `force-app-verify`: a fake relay serving
  one request, run it in sim, screenshots of the prompt, the modal and the minimised bar.
- **Physical**: the phase-1 PR adds §B entries to `physical-test-backlog.md`: the first real
  request on the rig, the prompt during a recording, Cancel while an `ask` is open, and the
  report landing on the issue.

## Phases

1. **Request, consent, operator steps, report.** Relay endpoints (except `/actions`), poller,
   eligibility, catalogue with `ask` and `note` only, runner and the rig lock (built, but it only
   engages for automated steps, so not yet), prompt (Run now, Snooze,
   Decline), modal with minimise and Cancel, the Settings tab, the report. Items without blocks
   run as prose checklists.
2. **Automation.** The vocabulary above, snapshot and restore with the journal, Run automated
   only, the Directus project and uploads, screenshots. The backlog's existing rig items are
   converted section by section.
3. **Live Claude loop.** `/rig-tests/{n}/actions`, `rig-action` comments, 3 s polling while live,
   `budget`. Claude sees each step's result as a progress comment and posts the next action.

## Open questions

- Which login do Claude session comments show up as on this repo? Comments posted through the
  GitHub MCP have so far appeared as the maintainer's own login. If that holds, the allowlist is
  just `dpremoli`. Check this on the first live run.
- Item ids aren't unique across the backlog today (E5 appears 37 times, R9 6 times, #190 twice),
  and some items have no id. The parser takes the id from the bold lead (see "Request format");
  an id that names several items is refused, so those items can't be requested until they get a
  distinct id in a block (`id: E5-owner-a`). A CI check should report duplicates and items with no
  id once blocks start appearing.
