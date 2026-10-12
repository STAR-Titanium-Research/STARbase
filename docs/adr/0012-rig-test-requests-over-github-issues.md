# ADR-0012 — Rig test requests: GitHub issues as the command channel, a fixed action vocabulary on the rig

- **Status:** Proposed
- **Date:** 2026-10-11
- **Deciders:** Maintainer + Claude (force app, post-0.1.36)
- **Amended:** 2026-10-12, decision 2: the relay authenticates callers by the operator's D1
  sign-in instead of a shared rig token (many laptops connect to the rig in turn). Spec:
  [`2026-10-12-rig-test-d1-login-design.md`](../superpowers/specs/2026-10-12-rig-test-d1-login-design.md).

## Context

Most force-app fixes are written in cloud sessions that have no NI-DAQ chassis, no Lab Amp and no
packaged Windows app. What only the real rig can confirm goes into
[`docs/runbooks/physical-test-backlog.md`](../runbooks/physical-test-backlog.md) as prose (167
unticked items on 2026-10-11), and waits for a rig day. The rig PC is in use by lab members most
of the time, so the maintainer can't just walk up and run checks, and asking by message is slow
and leaves no record of what was run.

The maintainer wants to request tests from GitHub, have the app on the rig ask whoever is using it
for permission, run what it can on its own, guide the operator through what needs a person, and
report back to the issue. A Claude session should be able to drive a run step by step, not only
hand over a fixed script.

Constraints:

- **No GitHub credential on the rig PC.** A packaged build's asar can be unpacked, so a token
  shipped to the PC would be public. Today the
  [bug-report relay](../../apps/force-app/bug-report-relay/server.py) on d1-server holds the GitHub
  App key and files issues for the app (`POST /report`, `GET /issues`).
- **The relay is reachable only over Tailscale**, and its older endpoints have no authentication
  of its own (`infra/caddy/Caddyfile`, `handle_path /bug-report-relay/*`); the rig-test endpoints
  require a D1 sign-in (decision 2). Claude cloud sessions are not on
  the tailnet, so they can't reach the relay or the rig. They can reach GitHub.
- **The backend only listens on loopback** (`app/origin_guard.py`). Nothing off the PC can talk to
  it directly, and that should stay true.
- **A recording must never be disturbed.** `_busy()` in `app/main.py` already refuses a second
  `/record/start` while a session is recording or finalizing.
- **Physical safety and the next user.** A test may leave the amp in the wrong mode or range for
  the next person's cut, which spoils a real sample.

Issue #97 (remote viewing of a live session) asks a related question, but it is not settled here.

## Decision

1. **The GitHub issue is the only command channel.** A request is an issue labelled
   `rig-test-request`. During a run, Claude or the maintainer sends further actions as comments
   that carry a fenced `rig-action` block. The rig app reports progress and results as comments on
   the same issue. The issue thread is the full record of what ran on the rig.

2. **The relay is the only broker, and it checks authority.** New relay endpoints (see the
   spec) list pending requests and their unread action comments, and post comments and labels for
   the app. The relay accepts a request only if a login on `RIG_TEST_ALLOWED_LOGINS` applied the
   label (checked against the issue's `labeled` events) and the issue's author is on the list too
   (an author can edit the request after the label is on), and an action comment only if an
   allowlisted login wrote it. Comments by the relay's own bot (`d1-database-bug-reporter[bot]`)
   are never read as commands. Anything else is dropped and logged. The rig app polls the relay; nothing
   connects inbound to the rig, and the backend still listens on loopback only. The relay also
   authenticates its caller: every `/rig-tests*` call must carry the signed-in operator's D1
   (Directus) access token as `Authorization: Bearer`, which the web app lends to its local
   backend while the session is online. The relay checks it with Directus (`/users/me`, active
   user, cached 60 s) and logs which D1 user made each call. Without it a tailnet host could post
   a forged result as the App bot. No credential is built into the app or stored on the PC, and
   the relay refuses to edit a comment that already holds a result. (Amended 2026-10-12; phase 1
   first shipped with a shared `X-Rig-Token`, which needed copying onto every laptop.)

3. **The rig runs only a fixed action vocabulary compiled into the app.** An action is a name and
   validated parameters (pydantic, with bounded ranges such as a recording of at most 120 s). No
   request can carry code, shell commands, file paths or URLs that the app executes or fetches.
   New actions arrive only with app releases. Allowed: reads, short real recordings, Lab Amp mode
   and temporary range changes, autorange *proposals*, app screenshots, and `ask` steps that put a
   question to the operator. Never allowed: writing sensor data to the Lab Amp, saving the channel
   config, deleting captures, changing storage or backup settings.

4. **The operator decides, and the backend enforces it.** Nothing runs until the operator
   accepts in the app (run now, run automated steps only, snooze, or decline). A run is refused
   while a recording, finalize, recovery, restore or upload is in progress. While an *automated*
   step is executing, the backend refuses `/record/start` and hardware config writes from anyone
   but the run. Operator steps (`ask`, `note`) don't lock anything: the person has to use the rig
   to carry them out. Cancel always works. The hardware state is captured before the first
   automated step and restored after Cancel, after the hard time limit (the larger of 1.5× the
   estimate and the sum of the answer windows, at most 2 h), or after a crash, from a journal on
   disk.

5. **Only the rig answers.** A backend answers requests only when it sees real NI-DAQ hardware and
   a real Lab Amp. A request can also name one machine (`rig: <id>`). Office PCs, and laptops
   that aren't plugged into the rig, never see the prompt; a laptop that is plugged in is the rig
   while it stays connected.

6. **Results flow back as data, not repo writes.** The result comment carries a table for people
   and a hidden JSON block for machines. A cloud session ticks the backlog items in a normal PR.
   The relay gets no contents-write permission.

## Alternatives considered

- **Claude drives the rig desktop with computer use.** This covers every UI check, but it needs
  the Claude desktop app signed in on a shared lab PC. The force app can't enforce the recording
  lock or restore state around clicks it doesn't see. It is still possible by hand, as on
  2026-10-08, and it stays outside this design.
- **The relay holds a live socket to the rig, and Claude talks to the relay.** Cloud sessions
  can't reach the tailnet, and this would mean adding auth to a service that has none.
- **Arbitrary scripts or recipes in the issue.** This is the most flexible option, but it lets anyone who
  can comment as an allowlisted login run code on the lab PC. A vocabulary covers the backlog's
  needs, and it can grow with each release.
- **Trust GitHub's own repo permissions instead of an allowlist.** Any collaborator who can label
  issues could then command the rig. The allowlist is one environment variable.
- **A GitHub Actions `workflow_dispatch` to send requests.** Every request would cost paid
  Actions minutes, and the results would still need an issue to land in.
- **The relay commits backlog ticks directly.** This would need contents-write permission on the
  App and safe edits to markdown on a server with no review step. A session ticking in a PR is
  reviewable.

## Consequences

- Backlog items gain an optional `rig-test` step block next to the prose (format in the spec).
  Items without a block still run as an operator checklist built from their prose.
- The relay's GitHub App needs no new permission. Its existing Issues read and write permission
  covers issue events, comments and labels. It still gets no Contents permission.
- Every round trip of the live loop goes rig → relay → GitHub → Claude and back. Expect 5 to 15 s
  per step, so live runs suit checks that take minutes, not tight interactive tuning.
- Tailnet hosts can no longer write through the relay (or read requests) without a valid D1
  sign-in. Any active D1 user may run rig tests; nothing needs installing or rotating per PC.
  A PC sees requests and sends results only while someone is signed in online; results wait in
  its outbox otherwise. The relay sees the operator's short-lived D1 access token and must use it
  for nothing but `/users/me`. The sign-in protects the relay's endpoints, not GitHub: a person
  who can label and write issues as an allowlisted login is still trusted by design.
- The repository is public, so everything the rig posts is public. Results name the operator by
  initials only and the rig by a neutral id (`rig`, or `FORCE_APP_RIG_ID`), never a full name,
  email or the Windows hostname.
- The relay's allowlist, the D1 sign-in check and the app's action vocabulary are the security boundaries. A new
  action that writes to hardware or disk needs a review against decision 3 and an update to this
  ADR.
- Test captures upload to a dedicated Directus project, "Rig tests". Dashboards and campaign views
  must filter it out.
- **Accepted risk: edits made after the label.** The relay checks who wrote the issue and who
  last applied the label, but not who last edited the body. Anyone with write access to the repo
  can change an allowlisted author's `rig-test` block after it is labelled. The block can only
  name items from the app's bundled backlog, plus inline `ask`/`note` text shown to the operator.
  Any triager can also remove a `rig-test:*` state label so a request is offered again. Both
  need repo write or triage rights, so the risk is accepted. GraphQL `lastEditedAt`/`editor`
  could close it later if the collaborator list grows.
- **Phase 2:** the `LOCKED` table is a deny-list. Before automated actions ship, turn it into an
  allow-list of what a run may call (security review, 2026-10-11).
- **Forbidden from now on:** an action that executes request-supplied code or paths, a code path
  that starts a run without operator consent, and an inbound listener on the rig for this feature.

## Verification

- Relay tests: a call with no bearer, one Directus rejects, or an inactive D1 user → 403 on every
  endpoint, nothing sent to GitHub; Directus down → 503; a result comment can't be edited; label applied by a login not on the allowlist → the request is not listed; an
  action comment by a login not on the allowlist, or by the relay's own bot → it is not returned.
- Backend tests: `/record/start` → 409 while an automated step runs (and free during an `ask`); accept → 409 while recording or
  finalizing; Cancel and the hard time limit restore the captured amp state; a journal left by a
  crash is restored at startup and reported as `interrupted`; unknown action names and
  out-of-range parameters are rejected before anything runs.
- Physical test backlog §B entries for the first real run (added by the phase-1 PR).

## References

- Spec: [`docs/superpowers/specs/2026-10-11-rig-test-requests-design.md`](../superpowers/specs/2026-10-11-rig-test-requests-design.md)
- Relay: `apps/force-app/bug-report-relay/server.py`; backend client `apps/force-app/backend/app/bug_report.py`
- Recording guard: `_busy()` in `apps/force-app/backend/app/main.py`; loopback guard
  `apps/force-app/backend/app/origin_guard.py`
- ADR-0010 (force-app packaging, why the rig PC holds no secrets)
- Related open issues: #97 (remote control), #20 (screenshot attachments)
