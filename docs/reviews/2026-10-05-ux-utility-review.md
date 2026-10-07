# UX and utility review — 2026-10-05

A read-only review of `main` at `1b6424d`, looking for features and tweaks that would make the
force app and the Directus side easier and more useful to work with. Three Sonnet reviewers
surveyed the operator workflow (Record, Settings, recovery, upload), the analysis side (Plot
dashboard, Diagnostics Workbench, filter and diag services) and the Directus side (extensions,
roles and permissions, schema). The coordinator re-checked the headline claims against the code.
Items already tracked as open issues (#108, #100, #97, #90, #86, #81, #80, #67, #64, #31, #30,
#20, #10) are left out.

Items marked *(idea)* are judgement calls the reviewers did not confirm in code. Sizes are S, M
or L. Paths are relative to the repo root.

**Status:** shipped in five PRs (all merged): #123 ("Fix first" and "Small, high-value"), #124
(the "Next" tier: P3, P4, R4, R5, D4, D3), #125 (small high-use: R6, R10, R11, R13, P2, P11,
D12), #127 (larger: D5, D11, P10, P6, R9) and #128 (P6 axis-map default per operation type, the
genealogy-function fix). Their descriptions list what changed. See the **Progress checklist**
below for item-by-item state; everything not ticked is backlog. Checks that need the rig or a live Directus are tracked
in [`docs/runbooks/physical-test-backlog.md`](../runbooks/physical-test-backlog.md).

## Fix first — broken or risky, not new features

| # | Finding | Evidence |
|---|---|---|
| X1 | Lite 3D "Z = Fx/Fy/Fz" renders flat | `packages/force-plotting/src/FrmCloud.vue` never reads `Cloud.zv` (since `5e3876a`); the wiki still advertises the mode with a screenshot. Noted in the "Pre-existing" section of `docs/superpowers/specs/2026-10-04-frm-signal-linking-design.md`. |
| X2 | Lab Member cannot save a cut | `known-issues.md` (Open): no create on `directus_files` and `machining_force_analysis`. `core/permissions.json` and `core/apply.sh` still describe the pre-Directus-11 role model (Operators get only `sample_code`, `current_status`, `notes`, and the old `operator_name`). |
| X3 | ~~Ask-DB bypasses Directus permissions~~ — **mostly already fixed** | The survey quoted the comment in `core/extensions/d1-ask-endpoint/index.js:3-12`, but migration `20261003000132_llm_readonly_allow_list.sql` already took `audit_logs`, `people`, `Machine_Operators` and every `directus_*` table away from the LLM role, and the endpoint already refuses users without app access. What remains is the export-control row filter (`docs/adr/0005`), deferred to Phase 9 as an owner decision. Not in this batch. |
| X4 | Stale wiki paragraph | `docs/wiki/force-app/recording.md` "Leaving the page mid-cut" says the save dialog opens only if the page sees the end of the cut; the 0.1.34 changelog says the Record page now offers to save on return. |

## Force app — recording

| # | Suggestion | Evidence | Size |
|---|---|---|---|
| R1 | Remember the setup across launches | `apps/force-app/web/src/record/workspace.ts:85-96` keeps `cfg`, `meta`, `machining`, `link` as plain `reactive` objects; only source, channels, plot prefs and recording prefs reach localStorage. `meta.sample_name` defaults to `'SIM-CUT-001'`. | M |
| R2 | Named setup presets, "repeat last cut" *(idea)* | Builds on R1. `MetadataPanel.vue` is imported nowhere (only `MachineOperatorPanel.vue` is used). | M |
| R3 | "New" leaves the last cut's per-cut fields | `newRun()` (`workspace.ts:480`) clears only transient state; pass code, `operation_sequence`, `chips_ref` stay, so the Cut ID repeats. TODO at `record/panels/RecordingOptions.vue:295` (auto-generate chips ref). | S |
| R4 | Pre-flight check before Start | Start gates are alarm-test, disk and sample-rate only (`workspace.ts:286-341`); "no Sample" first appears in `SaveCutDialog.vue:305`. | M |
| R5 | Live clipping / rail warning | Clipping is computed only at finalize (`backend/app/finalize.py:215-221`) and used by Converge after the cut. | M |
| R6 | Alarms: early warning, auto-stop, accessibility | `record/alarms.ts:48-62` latches at one threshold; the overlay (`RecordPage.vue:540`) has no `role="alert"`; the tone forces system volume to max. | S–M |
| R7 | Disk runway and ETA for hardware runs | ETA only for the simulator (`OverviewPanel.vue:30-35`); the pre-Start disk estimate always uses the removed 8 s duration (`RecordingOptions.vue:202-210`). | S |
| R8 | Fix metadata inside the save dialog | `SaveCutDialog.vue` has no sample, notes or operation fields. | M |
| R9 | Captures list: search, filter, bulk actions | `settings/CapturesSettings.vue:91,107` is a plain list capped silently at 500; `uploadAllUnsynced` has no progress or cancel. | M |
| R10 | Keyboard shortcuts on Record | No handlers for Start/Stop/acknowledge/New. | S |
| R11 | "Restart recorder" in the packaged app | `settings/ConnectivitySettings.vue:80-90` tells operators to run `python -m uvicorn`. | S |
| R12 | Bug report attaches capture summary/manifest | `settings/ReportBugSettings.vue`, `backend/app/bug_report.py` send no capture context. | M |
| R13 | Release notes in the update prompt; Help menu items | `desktop/src/updater.ts:55-68`; `desktop/src/menu.ts` has only two links. | S |
| R14 | First-run checklist (drive, alarm limits, amp) *(idea)* | No first-run flow in `web/src`. | S–M |

## Force app — Plot dashboard and Diagnostics

| # | Suggestion | Evidence | Size |
|---|---|---|---|
| P1 | CSV export (signal stats, wear trend, cluster table, series) | Only export is the FRM PNG (`frmExport.ts`, `ForceDashboard.vue:2191`). | M |
| P2 | SVG/PNG export of signal charts | `ForceChart.vue` has no export; reuse `frmExport.ts` framing. | M |
| P3 | Shareable deep link to a view | `?operation=` is read (`ForceDashboard.vue:1064`) but never written; mode, axes, zoom, compare set, map view are not in the URL. | M |
| P4 | Pass-to-pass difference | `alignAndDiff` (`compare.ts:44`) is exported but no `.vue` calls it. | M |
| P5 | Wider Compare (align by rev/radius, delta readout, FFT) | Force mode only, time-aligned (`ForceDashboard.vue:1795-1830`). | M |
| P6 | Cutting metrics (resultant, Fc/Ff/Fp, power, specific energy) | Nothing in force-plotting; feed, depth, speed already fetched (`ForceDashboard.vue:1044-1052`). | M |
| P7 | Wear trend beyond peak force | `WearTrend.vue:64,100` fetches only `peak_f*`. | S–M |
| P8 | Saved, named markers per operation | Marker clears on Escape; persistence deferred in the 2026-10-04 spec. | M |
| P9 | Polar Plot on the dashboard | `PolarPlot.vue` exists; `ForceDashboard.vue` doesn't import it. Spec follow-ups put tooth-pass lines on FFT first. | M |
| P10 | Diagnostics across a campaign | `RecipeLibrary.vue` uses `window.prompt`/`confirm`; no batch apply; `DiagnosticsPage.vue:143` is a flat `<select>` with `limit: -1`. | M–L |
| P11 | Help overlay for gestures; units everywhere | Right-click/drag interactions undocumented in-app; `ForceChart.vue:472,502` falls back to `"amp"`. | S |
| P12 | Scale the campaign list | `limit: -1` plus a client-side Metadata Doctor over every row (`ForceDashboard.vue:1035-1060`); 2D pick ~0.3–0.5 s at 5M points. | M |
| P13 | Filter/diag service batch endpoints *(idea)* | Only `/run`, `/fft`, `/spectrogram`, `/preview`, `/viewport`. | S–M |

## Directus

| # | Suggestion | Evidence | Size |
|---|---|---|---|
| D1 | Ask-DB example question chips | `d1-ask-db/src/chat.vue:88-95` has one hint paragraph; 62 curated questions sit in `plugins/llm-text-to-sql/eval/questions.json`. | S |
| D2 | Ask-DB: say when rows were truncated; clearer errors | `plugins/llm-text-to-sql/api.py:145-164` applies `row_limit` with no `truncated` flag; guard rejections say only "Try rephrasing"; 502/504 show raw strings. | S |
| D3 | Ask-DB: CSV download, copy SQL, saved questions, feedback | `chat.vue` keeps turns in memory only. | M |
| D4 | Sample label / QR printing and scan-to-open | QR exists only inside A4 reports (`d1-report/src/index.js:287,372,414`). | M |
| D5 | Sample timeline view | SRS §5; `f_sample_timeline`, `f_trace_*` exist; `plan.md:368` "visual timeline UI deferred". | M–L |
| D6 | Reverse traceability breadcrumbs on tests/operations | `d1-archive-links` lists UNC paths only. | S–M |
| D7 | Dashboard click-through to records | `d1-lab-dashboard/src/views/*.vue` have no links to `/content/...`. | S |
| D8 | Clone / bulk create / copy-from-last | `register-sample.vue` creates one sample per submit; no clone anywhere. | M |
| D9 | Next sample number without fetching every code | `d1-home/src/register-sample.vue:81-92`, `d1-sample-code` `SampleCode.vue` fetch all `sample_code` (`limit:-1`); undercounts when permissions hide rows (2026-10-03 review 4.5). | S |
| D10 | Per-user home page and "needs attention" tiles | `d1-home` `home.vue` shows global counts and recents only. | S–M |
| D11 | Campaign overview (samples → tests → force status) | `d1-campaign-ops` `CampaignOps.vue:68-80` queries operations only. | M |
| D12 | Saved filters / bookmarks | `scripts/.../configure_directus.sql:205-235` seeds one global bookmark. | S |
| D13 | Notifications on processing finish/fail *(idea)* | No Flows beyond the `directus_flows` stub (migration 030). | M |
| D14 | Note search UI | pgvector `/api/search` has no UI consumer. | S–M |
| D15 | Phone/tablet layouts *(idea)* | Only four extensions have media queries. | S–M |

## Progress checklist (2026-10-06)

`[x]` done, `[~]` partly done, `[ ]` not started. "#123" shipped in PR #123 (merged 2026-10-05).
"Next tier" shipped in PR #124 and "small high-use" in PR #125 (both merged 2026-10-06).

### Fix first
- [x] **X1** Lite 3D height — #123
- [x] **X2** Lab Member can save a cut — #123 (migration 133; `configure_users_and_policies.sql` no longer wipes migration grants)
  - [ ] Retire or port `core/permissions.json` / `core/apply.sh` — owner decision (2026-10-03 review 4.3)
- [~] **X3** Ask-DB permissions — already fixed by migration 132
  - [ ] Export-control row filter, which must also cover `directus_files` reads — Phase 9, owner decision (ADR-0005)
- [x] **X4** Stale "leaving mid-cut" wiki paragraph — #123

### Force app — recording
- [x] **R1** Remember the setup across launches — #123 (Replay and recording keep separate form copies)
- [ ] **R2** Named setup presets / "repeat last cut"
- [x] **R3** "New" steps the sequence and clears per-cut fields — #123
  - [ ] Auto-generate the chips ref (TODO at `RecordingOptions.vue`) — no documented rule for it
- [x] **R4** Pre-flight check before Start — next tier ("Start anyway" for a missing Sample)
  - [ ] Tacho chip shows "not checked": the backend has no pre-Start tacho report
  - [ ] Amp and channel chips not checked against real NI-DAQ hardware
- [x] **R5** Live clipping / rail warning — next tier (also fixed the Lab Amp full-scale mismatch that stopped finalize's clipping test firing)
  - [ ] Not checked on the real rig
- [x] **R6** Alarms — #125: early warning (default 80 %), optional stop-on-alarm (Record page open), `role="alert"`, tone volume setting
- [~] **R7** Disk runway — the pre-flight chip shows "~N min at this rate"
  - [ ] ETA during hardware recording
  - [ ] The pre-Start disk prompt still uses the hidden 8 s duration
- [ ] **R8** Fix metadata (sample, notes) inside the save dialog
- [x] **R9** Captures list — #127: search, status chips, sort, paging with totals, guarded bulk delete, "Free up space" cleanup, Upload all with progress/cancel; "partial upload" state
- [x] **R10** Record keyboard shortcuts — #125 (Ctrl/Cmd+Enter, Ctrl/Cmd+., A, Ctrl/Cmd+N, Enter in the save dialog)
  - [ ] Not available in pop-out windows; Ctrl+N cannot be overridden in a browser tab (Electron is fine)
- [x] **R11** "Restart recorder" — #125 (refuses while recording; confirms when the recorder doesn't answer)
  - [ ] Not exercised in a real Electron window
- [ ] **R12** Bug report attaches the capture summary/manifest
- [x] **R13** Release notes in the update prompt; Help menu (Alt shows the menu bar) — #125
- [ ] **R14** First-run checklist *(idea)*

### Force app — Plot dashboard and Diagnostics
- [x] **P1** CSV export for signal stats, wear trend and cluster table — #123
  - [ ] Raw force series CSV
- [x] **P2** PNG/SVG export of the signal charts — #125
  - [ ] PNG export not yet seen in a browser
- [x] **P3** Shareable view link with "Copy link" — next tier
  - [ ] An already-open (kept-alive) Plot page ignores a new link opened later
  - [ ] Not checked: Directus page tracking on each address-bar update
- [x] **P4** Difference vs reference pass — next tier
  - [ ] It is time-aligned within the crop/zoom window, not per revolution: the stored envelopes have no revolution axis
- [~] **P5** Wider Compare — the difference adds a mean/RMS delta readout
  - [ ] Align by revolution or radius
  - [ ] Compare on the FFT
- [x] **P6** Cutting metrics card — #127; owner's axis-map default, remembered per operation type — #128
  - [ ] Confirm the dynamometer axis mapping per workholding and operation on the rig. Default
    Fc=Fx, Ff=Fy, Fp=Fz (owner, 2026-10-06), remembered per operation subtype; see the
    physical-test backlog, P6
- [ ] **P7** Wear trend beyond peak force (mean/RMS stored per cut)
- [ ] **P8** Saved, named markers per operation
- [ ] **P9** Polar Plot on the dashboard (tooth-pass lines on the FFT first)
- [x] **P10** Diagnostics across a campaign — #127: recipe dialogs and import/export, searchable picker, apply recipe to selected
- [x] **P11** Gesture help overlay; units on every signal chart — #125 (spectra are "N rms"; filter-service `/fft` now matches)
- [ ] **P12** Scale the campaign list (pagination, faster pick)
- [ ] **P13** Filter/diag service batch endpoints *(idea)*

### Directus
- [x] **D1** Ask-DB example chips — #123 (5 chips; the export-controlled example was dropped)
- [x] **D2** Truncation notice and clear errors — #123 (a bad plugin secret now shows as a server problem)
- [x] **D3** CSV download, Copy SQL, per-user history and saved questions — next tier (CSV formula injection guarded)
  - [ ] Thumbs up/down feedback — needs a place to store it (owner decision)
- [x] **D4** Label sheets with QR codes — next tier (`/d1-report/label`, the `/d1-report/labels` picker, sample-form buttons, a Home tile)
  - [ ] A bulk action on the samples list itself: Directus 11 extensions cannot add one
  - [ ] Scan-to-open not checked on a phone against a live Directus
  - [ ] Case-insensitive code matching
- [x] **D5** Sample timeline — #127 (`d1-trace` endpoint, permission-filtered)
- [ ] **D6** Reverse traceability breadcrumbs
- [x] **D7** "Open in Directus" links on the lab dashboards — #123
  - [ ] "New operation for this sample": nothing can prefill the operation form yet
- [ ] **D8** Clone / bulk create / copy-from-last
- [x] **D9** Next sample number from the database — #123 (`next_sample_code_number()`, `d1-next-number`)
- [x] **D10** Per-user home page and "needs attention" tiles — Explorer pages E3 (PR pending)
- [x] **D11** Campaign overview — #127 (counts, progress, pickers); full Campaign page with the sample × step matrix in Explorer pages E2 (PR pending)
- [x] **D12** Saved filters — #125 (7 global bookmarks, migration 135; kept by `configure_directus.sql` re-runs)
- [ ] **D13** Notifications on processing finish/fail *(idea)*
- [ ] **D14** Note search UI
- [ ] **D15** Phone/tablet layouts *(idea)*

### Fixed along the way (not in the review)
- [x] A replayed cut's sample, operator, machine, edge, sequence and notes leaked into the next real recording, and into the stored setup
- [x] `configure_users_and_policies.sql` re-runs dropped Lab Member grants added by migrations 066, 075, 078, 084, 100 and 111
- [x] CI "Scripts and diagnostics" had been red on `main` since 2026-10-04. Cause: HDBSCAN tie order varied with the CPU (AVX-512); fixed in `scripts/diag/spatial.py`
- [x] CI never ran the Directus extension endpoint tests, the d1-report tests or the Ask-DB helper tests; it now runs all three
- [x] The finalize clipping test ignored the Lab Amp full scale (pre-existing; surfaced by R5)
- [x] The FFT overlay from filter-service was N/√Hz on an N axis (pre-existing; surfaced by P11)
- [x] The offline banner covered the safety-alarm banner (pre-existing)
- [x] Re-uploading a partially uploaded capture never completed its analysis row (pre-existing; surfaced by R9)
- [x] `f_trace_ancestors` / `f_trace_descendants` (migration 014) enumerated paths, not samples, so deep diamond genealogies blew up exponentially; fixed in #128 by migration 20261006000136 (breadth-first walk, one row per sample at its minimum depth; `d1-trace` keeps its 8 s deadline as a safety net) and 20261006000137 (index on `sample_genealogy.parent_sample_id`). Real-database check: physical-test backlog, section A
- [x] Label endpoint hardening: errors are `text/plain` with no echoed markup, and the 200-row cap is counted once

## Suggested order

1. **Fix first:** X1, X2, X4 (X3 is already fixed apart from the Phase 9 export-control filter).
2. **Small, high-value:** R1 + R3 (setup persistence and "New"), D1 + D2 (Ask-DB examples and
   truncation), P1 (CSV export), D7 (dashboard click-through), D9 (next sample number).
3. **Next:** P3 (deep links), R4 + R5 (pre-flight and live clipping), P4 (pass-to-pass
   difference), D4 (QR labels), D3.
4. **Larger:** D5, P10, D11, P6, R9.
