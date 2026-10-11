# Open issues re-check — 2026-10-11

Triage of every open issue on the repo (30) against main `3788dbf` (force app 0.1.36, released).
Scope widened past `in-app-report` at the owner's request ("existing issues in the repo"), so it
also covers the reports filed by hand (#199 #200 #212–#216 #222 #223 #67). Delete this plan once
#223 is deployed and the owner has decided on §0.

## 0. Fixed and released: closed on 2026-10-11

Closed at the owner's word, each with a note naming the version and pointing at its re-check in
`docs/runbooks/physical-test-backlog.md` (reopen the issue if the check fails). #30 (fixed in
0.1.33) and #86 (greyed out in #117, hot-plug in 0.1.35 via #215) were closed the same way.

| # | Fixed in | Commit / PR | Backlog re-check |
|---|---|---|---|
| 135, 136 | 0.1.35 | #198 | "Rig-day batch (2026-10-08, 0.1.35)" |
| 185, 186, 187, 188, 189, 190 | 0.1.35 | #198 | same section; #190 also needs migration 140 on d1-server (§C) |
| 199, 200 | 0.1.35 | `1a263aa` | "Re-checks for the 2026-10-08 fixes" |
| 212 | 0.1.35 | `69d13ff` | same |
| 213 | 0.1.35 | `04c72d1` | same |
| 214 | 0.1.35 | `f6556a1` | same |
| 215 | 0.1.35 | `c6bda01` | same |
| 216 | 0.1.35 | `c75c8df`, `4d507b4` | same |
| 67 | #117, 0.1.35 | gauge scale steps (#117), sparkline range (#188 in #198) | "#67 RPM meter doesn't glitch" in the rig-day section |

## 1. Needs real equipment or the server

| # | What only the real setup can confirm |
|---|---|
| 223 | Relay redeployed on d1-server; a report from the app lands (backlog §C) |
| 81 | Held back: saving while acquiring needs a multi-session model and DAQ-overrun tests |

## 2. Held back for an owner decision (unchanged unless noted)

- **#190 (C)** automatic crop detection (first/last |Fz| > 0.2·peak, no dwell or hysteresis):
  min dwell, RMS envelope, tacho gating or resultant force. Data fidelity, so the owner's call;
  the manual crop shipped in 0.1.35 is the workaround. #190 itself is closed; file this as its
  own issue if it's wanted.
- **#196** light-mode login: screenshots look consistent; asked the reporter for theirs on 10-09,
  no answer yet.
- **#100** performance umbrella: two slices shipped (#117, then 0.1.36); asked which screen still
  feels slow.
- **#10** re-bake Figure with the saved crop; **#20** screenshot attachments (App permission +
  privacy); **#31** backups / incomplete recordings as one list or two; **#64** audio replay
  fidelity and speeds; **#80** what crawler "processing" produces; **#90** in-app downgrade;
  **#97** remote control security model. As in the 2026-10-08 post-rig plan, §2.
- **#222** (new, owner task) bring the FAST runs dashboard (`core/extensions/d1-fast-dashboard`,
  939 lines of Vue, uses `@d1/ui`) and the force viewer as shown inside Directus
  (`d1-force-dashboard` around `packages/force-plotting`) up to the force app's Record page look:
  soft shadows, colours, dark mode. Not a bug, and it needs a visual reference. Proposed as one
  `directus-ui-implementer` stream with before/after screenshots in light and dark, once the
  owner says which Record-page surfaces are the reference (panels, chips, buttons).

## 3. This batch

| Stream | Scope | State |
|---|---|---|
| Relay redirect | #223 (P1) | done on `claude/busy-volta-r9imng`; needs a d1-server redeploy |

### #223 — every bug report fails with HTTP 307 (P1)
- **Cause:** the repo was renamed on GitHub (it now answers as `dpremoli/TimeTracker`). GitHub
  answers `POST /repos/dpremoli/D1-Database/issues` with a 307 to `/repositories/<id>/issues`,
  and the relay's httpx client doesn't follow redirects (`bug-report-relay/server.py`
  `_github()`), so `report()` returns "GitHub rejected the report (HTTP 307) Moved Permanently".
  This breaks the force app's Report a Bug screen and the "already reported" list (`GET /issues`,
  301) too, not only the Directus form in the report.
- **Change:** `follow_redirects=True` on the API client. A 307 keeps the method and body, and the
  target is on the same host, so httpx keeps the Authorization header. `GITHUB_REPO` /
  `DEFAULT_REPO` stay as they are; renaming them is the owner's call (see below).
- **Test:** `test_report_follows_a_renamed_repo_redirect` (fails on the old code: the 307 is
  returned as a rejection).

### Rename follow-ups (owner's call, not changed here)
If the rename to `TimeTracker` was intended, update `GITHUB_BUG_REPORT_REPO` in d1-server's
`.env`, `DEFAULT_REPO` in the relay, `.env.example`, `RELEASES_URL`
(`desktop/src/releaseNotes.ts`), the About link (`web/src/settings/AboutSettings.vue`), the
`publish-release*.ps1` defaults and d1-server's release poller. All of them work through
GitHub's redirect today. If it wasn't intended, renaming it back fixes #223 on its own.

## 4. After merge

Redeploy the relay on d1-server and tick the backlog item. Closing issues and posting comments
wait for the owner.
