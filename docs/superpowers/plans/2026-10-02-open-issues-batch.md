# Open-issues batch — 2026-10-02

Plan for the 48 issues open on 2026-10-02. Each one was triaged against the code, with file:line
root causes. This file lists, per issue, what we do in this batch, what is held back and why, and
what needs real lab equipment to validate. Delete this plan once the batch has shipped (see
`docs/superpowers/README.md`).

## 0. Already fixed in code — close

| # | Evidence |
|---|---|
| 57 | `ForceDashboard.vue` `onDeactivated(releaseFrmCache)`, `FrmCloud.vue` `onDeactivated(teardownRenderer)` |
| 58 | `LivePanelWindow.vue` `toggleChannel` honours `singleChannelMode` and has the collapse watcher |
| 59 | `ForcePanel.vue` and `LivePanelWindow.vue` watchers are `{ immediate: true }` |
| 61 | Diagnostics were redacted in 0.1.30; this batch also redacts the log and console tails and every `X:\Users\…` form (commit `fix(force-app): redact Windows account names…`) |
| 62 | `bug-report-relay/server.py` caps `body` (100 000) and `labels` (20 × 100 chars) |

## 1. Needs real equipment or external infrastructure to validate

Code changes for these can be written and unit-tested here; the item in the right-hand column can only be checked on the rig or the server.

| # | What only the real setup can confirm |
|---|---|
| 84 | Real DAQmx error text and codes (‑200077), whether the chassis or the module limits the rate, coerced rates on discrete-rate modules |
| 86 | NI-DAQ hot-plug, and whether NI MAX simulated devices count as "present" |
| 81 | DAQ buffer overruns while a 12 GB finalize runs beside a live acquisition — **held back** (needs #79 first and the chassis) |
| 80 | MATLAB run on the d1-server orchestrator, Directus asset download — **held back** |
| 10 | Figure-mode PNGs are baked by MATLAB on d1-server; `process_force.m` has no crop-override input — **held back** |
| 90 | Packaged Windows NSIS build and the Tailscale update feed — **held back** |
| 97 | Tailscale serve, phone access, live-DAQ load — **held back** (L, security model is an owner decision) |
| 96, 101 | Explorer reveal and Windows/network-drive behaviour (logic is unit-tested here) |
| 109 | Real LabAmp latency (logic uses the mock amp) |

## 2. Held back for an owner decision (comment left on each issue)

- **20** screenshots — still needs GitHub App `Contents: write` or an image host, plus a privacy rule.
- **31** pipeline unification — only the non-controversial *cross-link* part ships here (each
  remote backup shows its local state and name; see #91/#82). Merge-into-one-list vs. two lists is
  still the owner's call.
- **64** audio replay — needs a decision on fidelity (the cache is decimated without anti-aliasing)
  and behaviour at speeds ≠ 1×.
- **67** RPM glitch — the screenshot can't be fetched; the stable-scale fix below targets the likely
  cause, issue stays open for confirmation.
- **30** settings scroll — not reproducible; the structural fixes below remove every overflow cause
  we could find, issue stays open for confirmation.
- **100** performance umbrella — the concrete hotspots ship here (#77, #94, #107, Plot-page hover);
  the umbrella stays open.

## 3. This batch — work streams

Each stream has its own files, so the streams can run in parallel.

**Status** (update when a stream changes state; see "Resuming interrupted work" in `CLAUDE.md`).
Each stream works in its own worktree under `.claude/worktrees/` on branch
`worktree-agent-<id>`, based on `73a8547`.

| Stream | Worktree / branch id | State |
|---|---|---|
| A | `agent-ac87f3fd4cc2d8fcb` | merged; review fixes `de16eb6`, `e5ddb01` |
| B | `agent-a868c600a24febd73` | merged; blocker fixed in `062ba02`, other findings `dcf158f`..`1e78cf2` |
| C | `agent-a00fe5a7493b655ca` | merged; review nits fixed (`55c96ba`..`08357c8`) |
| D | `agent-a16dd8a730e68dddf` | merged; review nits fixed (`fdb83e7`..`4251934`) |
| E | `agent-a9c22f1bdfa0cadc3` | merged; blockers fixed in `ffd79fe`, `f7090dc`; nits `bc26b62`..`8f33785` |
| F | `agent-a091876a6e38fc188` | merged (`de8e4b1`); review clean, nit fixed in `6bad005` |
| Integration | `agent-ae500a5076c4b6316` | merged; cross-stream review blocker (folder switch during restore) fixed in `a7fba27` |
| /simplify | `agent-a1832224d6e0ac779`, `agent-a767db3daae16117c` | merged (`6715e7a`, `97f2709`); lint fixed in `6080895` |
| /code-review fixes | backend `agent-a87bebd62e1671252`, web/desktop `agent-a94d7341682b49027`, db `agent-a25eede646ce867e3` | merged (`0c2feee`, `1bf65bf`, `94553af`): all 9 findings fixed, with tests that fail on the old code |

### A. Finalize at constant memory — #79
- `finalize.py`/`dsp.py`: stream the memmap in blocks (gains, peaks, clipping, axis sums,
  least-squares detrend sums, tacho edges with carry-over, RPM and cumulative revs, cut window,
  decimated live cache). No full-length float64 copies.
- Time computed as `start + idx/fs` in float64 (the float32 column quantises past ~336 s).
- .mat stays v5 behind the existing `MAT_MAX_BYTES` guard (v7.3 is an owner decision). The capture
  finalizes; only the .mat export is skipped for huge captures, as today.
- Test: synthetic raw file of tens of millions of rows; bounded peak memory; output equal to the
  old path on small inputs.

### B. Captures, backup, Doctor, bug reporter — #83 #92 #93 #91 #82 #84 #86 #85 #88 #89 #95
- **#83:** the Doctor's "Fix now" for crashed recordings becomes a confirmed "Discard all…" listing
  the items. It adds a real link to where recovery lives, and never reports healthy while discards
  are still running.
- **#92:** load the remote list on mount; an unreachable server is an error, not "no backups".
- **#93:** remove the retention-hours input; show the server's value read-only.
- **#91 / #31 cross-link:** remote sessions carry `local_status` and `name`, and the states get
  clear labels. A local delete or discard marks the remote copy deleted (new backup-server
  endpoint), and it expires on the normal retention.
- **#82:** label captures by `sample_name` from the manifest when there is no summary. Remove the
  capture directory when a restore fails. Add a Recover action for incomplete rows in Local
  Captures.
- **#84:** pre-flight the sample rate in `/record/start` against the hardware maximum, returning a
  structured 400 with the field. A "failed to start" error is shown apart from "finalize failed",
  the empty capture directory is removed, and the offending field is focused (with #98's
  spotlight).
- **#86:** `/nidaq/devices` reports `hardware_present`; the NI-DAQ source button is disabled with a
  tooltip when there is none.
- **#85:** Machine / Operator / Operation type becomes a collapsible card like Tooling and Post-cut.
- **#88 / #89:** the issue list is cached at module level; a submitted issue is inserted
  optimistically, then reconciled; no refetch on every tab visit.
- **#95:** several areas per report (UI chips; backend list, filtered, max 4).

### C. Replay and live plots — #110 #105 #76 #34 #87 #103 #107 #104 #108 #67
- **#110:** the playhead and scrub bar start at the cache's first timestamp, not 0.
- **#105 / #76:** the window becomes a view parameter. Replay rebuilds the trace when it changes;
  `LiveForcePlot` slices to its own window with a fixed x-range, and the live buffer keeps up to
  the slider maximum.
- **#34:** each panel has its own window (persisted with the layout), with the global value as
  default.
- **#87:** `LiveFrm` points get `frustumCulled = false`; GPU update ranges accumulate instead of
  being cleared every frame.
- **#103:** a trailing histogram emit after a throttled or reset frame.
- **#107:** the pop-out relay peer flag clears when the pop-out closes (heartbeat); scrub seeks are
  coalesced to one per animation frame; the plot palette is cached.
- **#104:** timeline markers for cut start/end, crop, and per-axis peaks; click to seek.
- **#108:** plot options persisted; Tacho is the default bottom panel for new layouts.
- **#67:** stable RPM gauge scale (nice steps with hysteresis) and a fixed sparkline range.

### D. Desktop shell — #106 #96 #101 #108 (windows)
- **#106:** drain the backend's stdout (the root cause: uvicorn blocked on a full pipe), a periodic
  liveness probe that restarts the backend, and renderer-crash and unresponsive handlers.
- **#96:** a per-capture directory in the API, an IPC `revealPath` restricted to the captures root,
  and a "Show in folder" / copy-path control.
- **#101:** a folder picker (Electron dialog) in General; the backend refuses to change the root
  while busy and checks the folder is writable.
- **#108:** pop-out windows open at quit are reopened on the next start.

### E. Plot page, plotting library, lists, focus — #94 #78 #77 #102 #99 #109 #98 #30 #100
- **#94:** `ForceChart` observes its always-present root; the previous detail stays visible while
  the next loads; the user's preferred FRM mode is remembered and not reset by the empty state.
- **#78:** shaping parameters (symmetrical, always-show-zero) are applied to an unshaped base range,
  so unticking restores it; the axis domain is frozen to the data range while dragging.
- **#77:** the end-of-cut crop redraw runs at most once per animation frame, with cached bounds and
  per-pixel decimation.
- **#102:** a staged loading overlay (download %, building, streaming) when switching Figure, Lite
  or Full.
- **#99:** `LookupField` and `CutPicker` mark already-selected or current items (a check plus
  `aria-selected`); multi-pick lists hide what is already picked.
- **#109:** the LabAmp page uses stale-while-revalidate, so it shows the last-known sensors at once.
- **#98:** a `spotlight()` helper (an animated ring, static under reduced motion) and a `?focus=`
  link convention; Settings follows `?tab=` changes.
- **#30:** Settings becomes a fixed-height column with its own scrolling pane and a stable
  scrollbar gutter; banners no longer push it into overflow.
- **#100:** the Plot page's hover no longer re-renders the whole dashboard (memoised chart inputs).

### F. Natural ordering of ID codes — #115
- Migration: an ICU numeric collation (`und-u-kn`) on the code columns (`sample_code`, `pass_code`,
  `tool_code`, `insert_code`, `tool_box_code`, `edge_code`, `lot_code`, `project_code`). It
  recreates dependent views verbatim, re-adds `code_sort`, and has an up/down pair. Clicking the
  column header then sorts 9 < 10 < 151.
- `configure_directus.sql`: global default presets per collection, and no `sort_field` on
  non-integer columns (which removes the drag-to-reorder that could overwrite codes and names).
- Tests in `tests/phase1_schema.sh`; verified against a local Postgres 16.

## 4. After the streams merge

Progress (2026-10-03): all five steps are done; the PR is dpremoli/D1-Database#117. All streams are merged, each stream and the merged
whole were reviewed and their findings fixed, every suite passes (including the slow 2 GB
finalize test), and the 0.1.33 changelog and version bump are in. After /simplify and /code-review
(2026-10-03), 29 issues are closed. #84 #86 #96 #101 #109 stay open for a check on real
equipment. #30 #31 #67 #79 #100 #108 #110 are partial; see each issue's comment for what is left.

1. Merge every stream into `claude/trusting-euler-ku2z3z` and resolve conflicts.
2. Code review of the whole diff (correctness first), and fix the findings.
3. Write the missing tests, then run every suite: backend pytest, backup-server, bug-report relay,
   web and plotting vitest, typecheck, the desktop unit tests that can run on Linux, and the schema
   tests against local Postgres.
4. Add a changelog entry (0.1.33) and bump the desktop version.
5. Close the fixed issues with a short note; comment on the held-back ones.
