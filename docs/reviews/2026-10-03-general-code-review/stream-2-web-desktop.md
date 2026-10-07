# Stream 2 — `apps/force-app/web`, `apps/force-app/desktop` (raw reviewer report)

Unverified reviewer output; the consolidated report records which findings the coordinator
checked. `main.ts`, `updater.ts`, `sidecar.ts`, `preload.ts` and `windowOpen.ts` are in
`apps/force-app/desktop/src/`; every other path is in `apps/force-app/web/src/`.

## Blocking

1. **Record page never reconciles with `/record/status`; a missed `done` leaves the UI stuck.**
   `record/liveClient.ts:156-168` (`connect()`), `record/RecordPage.vue:453-455`,
   `record/workspace.ts:386-399` (`stop()`), `record/panels/SaveCutDialog.vue:104`. The backend WS
   (`main.py:2615`) sends no state on connect; only `AppShell` calls `/record/status`.
   - A: leave `/record` mid-cut, the cut auto-stops, `done` is never delivered. On return
     `st.state` is still `'recording'`; Stop → `/record/stop` 409, which `RecordClient.stop()`
     ignores silently; the save dialog spins forever with no buttons.
   - B: backend crashes on `/record`; supervisor restarts it and `main.ts:196` sends
     `navigate('/record')`, a no-op on the current route. No WS reconnect logic exists, so
     `st.connected` stays false and Start stays disabled; `checkRecovery()` never reruns.
   - Fix: reconcile from `/record/status` on mount and every WS (re)open; reconnect with backoff;
     make `client.stop()` throw on non-ok and surface it.
2. **SaveCutDialog retry duplicates the `manufacturing_operations` row.**
   `record/workspace.ts:451-472`, `:477-531`, `record/panels/SaveCutDialog.vue:176-188`. The
   operation row is inserted first; if a file upload or the `machining_force_analysis` POST then
   fails, Save again inserts a second row and re-uploads. `w.logged` is never read; `savedOpId` is
   set only on success. `uploadCapture.ts` has the same shape. Fix: remember `opId` / uploaded file
   ids and resume, or look up by `recorded_metadata.capture_id`.
3. **Quit and auto-update guards ignore `finalizing`.** `main.ts:56-78` (`activeRecording()` is
   null unless `state === 'recording'`), `updater.ts:100`. Quitting or "Update now" during
   finalize runs `taskkill /T /F`, leaving `capture.mat`, `live_cache.bin`, `summary.json`
   unwritten (raw survives; the cut becomes an incomplete recording). Fix: treat `finalizing` as
   busy, or wait for `join_finalize` before killing.

## Should fix

4. `updater.ts:44-54`, `:60-81` — `showUpdateDialog` calls `performInstall` on "Update now"
   without re-checking `isRecording()` (the `update:install` IPC does re-check).
5. `record/workspace.ts:354-358` — `start()` awaits the alarm and disk pre-flight before
   `busy = true`; a double-click runs two `start()`s, the second resets state and gets 409.
6. `record/RecordPage.vue:186-197`, `:213-224` — disk and backup polling watchers on `st.state`
   lack `immediate`; after a remount mid-cut the intervals never restart, so the disk alarm and
   chips go stale.
7. `record/workspace.ts:621-668`, `:672-750` — `searchCuts` and `pickReplayCut` have no request
   token; out-of-order replies overwrite newer state (options, `link.*`, `meta`, `machining`), and a
   late `playback.load` can reset the live client after switching to Sim.
8. `settings/ConnectivitySettings.vue:219-231`, `config.ts:57-64` — Save pins the per-launch
   `recorderUrl` (defeats the 8200→8201 fallback); Reset restores build defaults, not
   `config.json`, so desktop Directus calls go to `app://force` until reload.
9. `sidecar.ts:195-210`, `:75-82` — startup wait ignores the process exiting; the operator waits
   the full 20 s while a concurrent restart runs, then may see two error boxes. (Read, not run.)
10. `settings/AboutSettings.vue:56`, `preload.ts:13-20` — `onUpdateStatus` / `onNavigate` return
    no disposer; each About visit adds an `ipcRenderer.on` listener.
11. `main.ts:~257`, `windowOpen.ts` — no `will-navigate` or permission handler; the `update:*`
    IPC handlers skip the `fromApp()` check that `dialog:pickFolder` and `shell:reveal` use.
    Defence in depth (no current path navigates externally).

## Uncertain

- No parent-death watchdog on the sidecar: if Electron is killed without `/T`, the backend may
  keep the DAQ and amp; the next launch binds 8201. Confirm on Windows with `taskkill /F`.

## Nits

- `record/RecordPage.vue:285` — `JSON.parse` of `dismissedRecoveryIds` outside try.
- `record/RecordPage.vue:67-71` — `loadLayout` discards the whole layout on one unknown panel type
  (invariant 11 says skip).
- `settings/ConnectivitySettings.vue:~60` — hard-coded developer Windows path in UI text.
- `directusSync.ts` — operation POST retried after a timeout has no idempotency key.

## Test gaps

`createWorkspace().start()/stop()/uploadCutToDatabase()`, `RecordClient.start()/stop()` non-ok
handling, the SaveCutDialog retry, `desktop/src/updater.ts`, the `main.ts` quit guard, the
sidecar startup-crash path.

## Checks run

`npm test -w force-app-web` 317 passed; `typecheck` and `lint:theme` clean.
`npm test -w force-app-desktop` 68 passed, 1 skipped (Windows-only); `typecheck` clean.
