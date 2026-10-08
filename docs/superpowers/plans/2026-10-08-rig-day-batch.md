# Rig-day batch — 2026-10-08

Plan for the in-app reports filed since the 2026-10-02 batch: #135–#137 (filed on 0.1.31) and
#184–#190 (filed on 0.1.34 during a real NI-DAQ cut). Each was triaged against HEAD `d40314b`
with file:line root causes. Older open issues (#10 #20 #30 #31 #64 #67 #80 #81 #86 #90 #97 #100
#108) were triaged in the 2026-10-02 batch and stay as recorded there. Delete this plan once
the batch has shipped (see `docs/superpowers/README.md`).

## 0. Already fixed

None. 0.1.34 is the newest release and nothing since touches these areas.

## 1. Needs real equipment or the server to confirm

Code and unit tests are written here; the right-hand column goes in
`docs/runbooks/physical-test-backlog.md`.

| # | What only the real setup can confirm |
|---|---|
| 190 | Migration applied on d1-server; re-upload of a > 6 min capture links with no .mat; crop survives an app restart |
| 187 | Pop-outs reachable on the rig with a monitor unplugged, after Win+D / minimise; stale `/live/*` entries in `window-state.json` |
| 185, 189 | Packaged Windows app: minimise / alt-tab / switch route during and after a cut, plots keep or regain their data |
| 186 | CPU and WS bandwidth with 12 channels at the real rate and the finer FFT |
| 135 | An install with a saved backup URL keeps it |

## 2. Held back for an owner decision

- **#184** manual "start FRM now" when the causal cut detector never fires. Design sketched
  (`POST /record/cut-start`, button on FrmPanel while waiting). Owner to decide: does a manual
  mark seed the saved crop / metadata, should the default threshold change, may it re-origin
  after auto-detection.
- **#190 (C)** automatic crop (`finalize.py:228-241`, first/last |Fz| > 0.2·peak, no dwell or
  hysteresis) is data fidelity. Options: min dwell, RMS envelope, tacho gating, resultant force.
  The manual crop (fixed below) is the workaround.
- **#137 attribution** (crediting reporters in release notes): reporter field is an email, so a
  privacy call. Categories ship here.
- **#185 backfill** of the gap from the raw file after returning to /record: larger, separate.

## 3. This batch — work streams

Workers: `force-app-implementer` (Sonnet, high), one worktree each under `.claude/worktrees/`, branch `worktree-agent-<id>`, fast-forwarded to `7901489`. Workers
don't edit the backlog, the changelog or the version; the coordinator does.

### Status

| Stream | Scope | Worktree / branch | State |
|---|---|---|---|
| A — Upload and crop (P1) | #190 A+B | `agent-ad791c74b30c88930` | merged (`08faa2c`..`7c8f643`); workspace.ts export-list conflict with B resolved; migration up/down/up + phase1 273 passed locally |
| B — Live and finished plots | #185 #189 #188 | `agent-adf2dbacd89896db7` | merged (`53919a8`..`60c07b6`); no jsdom, so component wiring is tested via pure modules + source assertions |
| C — FFT and pop-outs | #186 #187 | `agent-a48f8683250a6d659` | merged (`7ff136c`, `8c30d9d`); `ensurePopoutReachable` untested (needs Electron) |
| D — Settings, layout, release notes | #135 #136 #137 | `agent-ab54cf260692df0c3` | merged (`e88352b`..`77c88f6`) |
| /simplify fixes | crop/upload · stream/plots · FFT/desktop/notes | `agent-ad597db19cf601364`, `agent-a4c9bb20f328ab690`, `agent-a52c0889f3615aae7` | merged; untouched-crop clear fixed after; skipped: shared linkAnalysis(), NULL-file CHECK constraint, seq-based gaps, FFT `f` only on change |
| Debug pass + review | Opus: force-app-verify run, /code-review high | main checkout + `agent-a08f087e361db4861`, `agent-af9c16a2dc765e230` | merged. Debug found a pre-existing P0 (workspace watchers died with the first RecordPage: alarms, stop-on-trip, prefs) — fixed `0ca1740`; review: 9 of 10 fixed, per-side crop override kept as both-sides (dashboard only honours both) |
| Coordinator | changelog 0.1.35, backlog, preflight, PR | main checkout | preflight 0 failed; pre-commit clean; PR #198 open, CI pending |

### A. Upload and crop — #190 (P1)
- **Cause:** captures over `MAT_MAX_BYTES` (`finalize.py:59`, ~366 s at 51.2 kHz × 10 cols) skip
  the .mat; `workspace.ts:800` and `uploadCapture.ts:202` then POST `directus_files_id: null`,
  but `machining_force_analysis.directus_files_id` is `NOT NULL`
  (`20260705000074_machining_force_analysis.sql:15`), so Directus returns 400. The error text
  "both files uploaded" is hard-coded (`workspace.ts:819`, `uploadCapture.ts:218`).
- **Change:** dbmate migration dropping the NOT NULL (down refuses while NULL rows exist);
  check `scripts/force_orchestrator.py` and `d1-force-crawler` ignore NULL-file rows; honest
  error text. Schema test inserting a NULL-file row.
- **Crop lost:** the edited crop lives only in memory (`workspace.ts:236-238`) and in the failed
  POST. Add `PUT /captures/{id}/crop` writing sample-index overrides into `summary.json`;
  Save writes it locally before uploading; `LocalCaptureView.vue` passes it to both plots;
  `uploadCapture.ts` sends it on retry.
- **Tests:** phase1 schema test; backend `test_crop_override_guard.py`; vitests for
  `uploadCapture` (override in POST, honest message with `mat_written:false`).

### B. Live and finished plots — #185 #189 #188
- **#185:** `RecordPage.vue:506` disconnects the stream on unmount even while recording;
  `LiveForcePlot.vue:168,174` draws a line across gaps. Keep the socket open while recording
  or finalizing; split series where Δt > 3× median bin and leave the gap visibly empty.
- **#189:** plots don't redraw after the canvas is discarded while hidden (no
  `contextrestored` / `visibilitychange` handling in `LiveForcePlot.vue` and
  `FinishedForcePlot.vue`); `ForcePanel.vue:135-136` flips between finished and live plots when
  the save dialog opens. Force a full redraw on those events; keep the finished plot while the
  dialog is open; hide the window slider while the finished plot is shown.
- **#188:** `RpmPanel.vue:22,57-62` sparkline reuses the gauge's target-based max. Give it its own
  stable min/max from history, with padding and a minimum span.
- **Tests:** gap-split helper; redraw on `contextrestored`; ForcePanel with dialog open; RpmPanel
  sparkline span ≥ 50 % for 40–80 RPM at target 3000; unmount during recording keeps socket.

### C. FFT and pop-outs — #186 #187
- **#186:** `dsp.py:223,244-246` stride-picks 240 of 2049 bins (peaks dropped);
  `session.py:435`. Peak-preserving max-pool, `max_bins` ≈ 1024, nperseg up to 8192 if the
  buffer allows. Test: a sine between stride picks keeps its amplitude; `len(f) >= 1000`;
  existing Welch equality test still passes.
- **#187:** `desktop/src/windowOpen.ts:61` applies saved pop-out bounds with no on-screen check
  (main window has `isOnSomeDisplay`, `main.ts:337-343`). Drop x/y when off every display;
  never save minimised (-32000) or zero-size bounds. Test in `windowOpen.test.ts`.

### D. Settings, layout, release notes — #135 #136 #137
- **#135:** `BackupSettings.vue:153` only shows the URL as placeholder. `GET /backup/config`
  returns `suggested_url` (`DEFAULT_BACKUP_URL`, `main.py:252`); the page fills an empty field
  with it, marked "suggested, not saved". Not a backend default (Doctor would probe it).
- **#136:** grid-layout-plus only pushes collisions down, so the full-height Recording &
  Metadata panel can't go to the right. Pure `dockPanel()` in `record/recordLayout.ts` plus a
  "Move panel to other side" button next to Reset. `LS_KEY` unchanged.
- **#137:** keep `notes: string[]`; group by prefix (`Fixed:`, `Improved:`, none = New) in a
  `changelogGroups.ts` helper used by `AboutSettings.vue` and by `.github/scripts/release_plan.py`
  for the GitHub Release text; document `Improved:` in the force-app-release skill.

## 4. After the streams merge

`/simplify` (Opus), debug pass on the merged diff, `/code-review` high (Opus) + `force-app-reviewer`,
fix findings, preflight + schema tests, changelog 0.1.35 + version bump, backlog items, PR.
Closing issues waits for the user.
