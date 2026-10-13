# Rig test requests: authenticate with the operator's D1 sign-in instead of a shared token

**Date:** 2026-10-12
**Status:** Design. Amends [ADR-0012](../../adr/0012-rig-test-requests-over-github-issues.md)
decision 2, and the rig-token parts of
[`2026-10-11-rig-test-requests-design.md`](2026-10-11-rig-test-requests-design.md).
The choices come from a question-and-answer session with the maintainer on 2026-10-12.

## Problem

Phase 1 (#237) protects the relay's `/rig-tests*` endpoints with one shared secret: the relay
holds `RIG_TEST_RELAY_TOKEN`, and the rig PC sends the same value in `X-Rig-Token`, read from
`FORCE_APP_RIG_TEST_TOKEN` or a `rig_test_token` file in its config folder. That assumed one fixed
rig PC. In practice many lab laptops are plugged into the rig in turn, so the token would have to
be copied onto every laptop, per Windows user, and rotated on all of them. That is not workable.

Every operator already signs in to the force app with their D1 (Directus) account. That sign-in
can authenticate rig-test calls instead.

## Goals

- Any laptop that is connected to the rig hardware, with any D1 user signed in online, can receive
  rig-test requests and post results. No per-machine setup.
- The relay knows which D1 user each rig-test call came from and logs it (relay log only; GitHub
  still shows initials only).
- The shared rig token is removed everywhere: relay, backend, web, docs, deploy config.

## Non-goals

- Restricting rig tests to certain D1 roles or named users. Any active D1 user may run them
  (maintainer's choice). Who may *request* a test is unchanged: the GitHub allowlist.
- Working while signed out or signed in offline. Requests are only seen, and results only sent,
  while someone is signed in online (maintainer's choice). Results wait in the outbox meanwhile.
- A relay-issued session that outlives the D1 sign-in. Considered and rejected as extra moving
  parts (see Alternatives).
- Any change to the GitHub-side trust checks, the action vocabulary or the run flow.

## Design

### 1. Web app → local backend

- `rigTestStore` watches the auth store. Whenever the signed-in session is online and its access
  token changes (sign-in, every refresh, offline → online), it sends
  `PUT /rig-tests/session {"access_token": "<token>", "expires_at": <epoch ms>}` to the local
  backend. On sign-out, or when the session goes offline, it sends `DELETE /rig-tests/session`.
- Only the main window does this (same rule as the rest of the feature; pop-outs never host it).
- Today the auth store refreshes only after a 401. While the PC has rig hardware (see
  `hardware_ok` below), the store also refreshes about 90 s (`REFRESH_AHEAD_MS`) before `expiresAt`, so the
  recorder's copy never lapses between two 30 s polls, and so never while the app is open and idle.
- A `signin_rejected` answer is believed only if its GET /pending left after the last successful PUT
  finished (a monotonic stamp the store takes before each GET). An older answer describes the token
  that PUT replaced, and acting on it would refuse and then delete the fresh token.
- The access token is the short-lived Directus one (15 min by default). The refresh token never
  leaves the web app.

### 2. Backend

- `relay.py` holds the session in memory only: `set_session(token, expires_at)`,
  `clear_session()`, `session_present()`. It is never written to disk or the log, never returned
  by any route, and is scrubbed from exception text (as the shared token was).
- New routes in `routes.py`: `PUT /rig-tests/session` (validates shape: printable ASCII,
  at most 4096 chars) and `DELETE /rig-tests/session`. Both sit behind the existing loopback /
  origin guard.
- Every relay call sends `Authorization: Bearer <token>` instead of `X-Rig-Token`. With no session
  present, or `expires_at` already past, `_call` returns
  `{"ok": false, "kind": "signed_out", "reason": "Sign in to D1 online to receive rig-test requests"}`
  without contacting the relay.
- A 403 from the relay with reason `D1 sign-in rejected` clears the session (only if it is still
  the token that was refused) and returns `kind: "signin_rejected"`. A 503 `D1 unavailable` gets
  `kind: "unreachable"`, so the outbox waits instead of counting it as a refusal.
- Eligibility: `eligibility.check` (hardware) is unchanged. `GET /rig-tests/pending` (which the
  web already polls every 30 s) and `GET /rig-tests/eligibility` gain `session` (bool),
  `hardware_ok` (the last hardware check, or null before the first) and `/pending` also `relay`
  (the poller's relay state), so the web knows when to send or refresh the token without
  triggering a DAQmx enumeration. The poller polls only when hardware and session are both there.
- `PUT /rig-tests/session` with a token different from the current one resets the poller's relay
  state to `unknown`, so a rejection reported afterwards always refers to the new token.
- Removed: `TOKEN_ENV`, `TOKEN_FILE`, `token()`, `set_config_dir()` and the `rig_test_token` file
  read. A leftover file is ignored.
- A backend restart loses the session; the web re-sends it on the next store tick (it re-sends
  whenever `/rig-tests/eligibility` reports `session: false` while it holds an online token).

### 3. Relay

- `_rig_gate` reads `Authorization: Bearer <token>`. Missing or malformed → 403
  `{"ok": false, "reason": "D1 sign-in rejected"}`.
- It verifies the token with Directus: `GET {DIRECTUS_INTERNAL_URL}/users/me?fields=id,email`
  with that bearer, 5 s timeout. `DIRECTUS_INTERNAL_URL` defaults to `http://directus:8055`
  (the relay and Directus share the `d1net` Docker network). Only `id,email` are requested: a
  non-admin user may not be allowed to read their own `status`, and Directus already refuses to
  refresh a suspended user's session, so a suspended account loses access within one access-token
  lifetime (15 min) plus the 60 s cache.
  - 200 with a user `id` → accepted. The relay logs the D1 user id and email next to the
    action it performs (list, comment, edit, state).
  - 401/403, or a 200 without a user `id` → 403 `D1 sign-in rejected`.
  - Timeout, connection error or 5xx → 503 `{"ok": false, "reason": "D1 unavailable"}`.
- Accepted results are cached for 60 s, keyed by SHA-256 of the token (the token itself is never
  stored or logged). Rejections and errors are not cached. The cache holds at most 256
  entries; the oldest is dropped first.
- Fail closed as before: with `RIG_TEST_ALLOWED_LOGINS` empty or the GitHub App unconfigured,
  every rig-test endpoint answers `rig tests not configured`.
- Removed: `RIG_TEST_RELAY_TOKEN`, `X-Rig-Token` and the constant-time token compare.
- Unchanged: every GitHub-side check (open issue, not a PR, labelled, author and labeller
  allowlisted, only the App's own comments editable, never a result comment).

The relay sees a user's D1 access token. That is acceptable: it runs on d1-server next to Directus,
and it only uses the token to call `/users/me`. It must never use it for anything else.

### 4. What the operator sees

| Situation | Behaviour |
|---|---|
| Signed in online, laptop on the rig | Works as in phase 1. |
| Signed in offline, or signed out | Not eligible. Settings → Rig tests: "Sign in to D1 online to receive rig-test requests." No polling. |
| D1 rejects the sign-in (account disabled, session revoked) | Backend drops the session; the web refreshes and re-sends once. Still rejected → "D1 didn't accept your sign-in: sign out and back in." |
| Directus or relay down | Existing "relay unreachable" state; retried on the next poll. |
| Session ends mid-run | The run continues (phase-1 steps are manual). Results stay in the outbox and are sent at the next online sign-in on that laptop. |

`RelayState` `token_rejected` becomes `signin_rejected`; a new `signed_out` state replaces the
"rig test token not set" reason. The Settings text about token files and `FORCE_APP_RIG_TEST_TOKEN`
is removed.

## Error handling

- The backend never raises on a relay failure; it returns the `kind` above, as phase 1 does.
- A malformed `PUT /rig-tests/session` body → 422, session unchanged.
- The token appears in no response body, log line or exception text on backend or relay; tests
  assert this.

## Rollout

The rig-test feature has not shipped in a force-app release, so no laptop runs the token-based
client and no compatibility period is needed.

1. Merge this change.
2. Redeploy `bug-report-relay` on d1-server (`docker compose up -d --build --no-deps bug-report-relay`).
3. Ship the next force-app release.
4. Clean up d1-server: remove `RIG_TEST_RELAY_TOKEN` from `.env`, and delete
   `%LOCALAPPDATA%\force-app\rig_test_token` (written during the #237 deploy).

`docker-compose.yml`: replace `RIG_TEST_RELAY_TOKEN` with
`DIRECTUS_INTERNAL_URL: ${DIRECTUS_INTERNAL_URL:-http://directus:8055}` for the relay.
`.env.example`: drop `RIG_TEST_RELAY_TOKEN`.

## Testing

- **Relay (pytest, Directus stubbed):** no header, a token Directus rejects, a 200 without a user id →
  403 on every rig-test endpoint and nothing sent to GitHub; a valid user → 200; two calls within
  60 s → one Directus call; Directus down → 503; rejections not cached; the token never appears in
  logs or responses; `rig tests not configured` still wins when the allowlist is empty.
- **Backend (pytest):** `PUT`/`DELETE /rig-tests/session`; no route returns the token; no session
  → `signed_out`, no relay call, poller idle; 403 from relay → session cleared, `signin_rejected`;
  expired `expires_at` → treated as signed out; outbox entries wait while signed out and send once
  a session arrives; the `rig_test_token` file is ignored.
- **Web (vitest):** the store sends the token on sign-in and refresh, deletes it on sign-out and
  offline, re-sends when eligibility reports `session: false`; the early refresh fires about 90 s
  before expiry only while `hardware_ok`; Settings shows the signed-out and rejected messages.
- **E2E:** update `web/e2e/rig-tests.spec.ts` for the session call and the signed-out state.
- **Live (runbook §C):** on d1-server, the real relay with a real D1 access token → `ok: true`;
  no header or a made-up token → 403.

## Alternatives considered

- **Move polling into the web app,** so the backend never holds a credential. Rejected: the
  poller, outbox and crash catch-up all live in the backend; most of #237 would be rewritten.
- **The relay verifies the Directus JWT itself with Directus's signing secret.** No network call,
  but Directus's master secret would sit in a second service, and a suspended user or revoked
  session would still pass until the token expires.
- **A relay-issued rig session (e.g. 12 h) in exchange for a D1 token,** so polling survives the
  UI closing. Rejected by the maintainer: online sign-in only is enough, and it adds a signing key
  and a second credential.
- **Keep the shared token as a fallback** for a fixed rig PC. Rejected: two auth paths to maintain
  and test, for a case the lab doesn't have.
