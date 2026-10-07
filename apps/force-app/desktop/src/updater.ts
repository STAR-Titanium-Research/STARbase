import { app, dialog, ipcMain, Notification, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { formatReleaseNotes } from './releaseNotes';
import { isAppSender } from './windowOpen';

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'installing'; version: string }
  | { state: 'error'; message: string };

let status: UpdateStatus = { state: 'idle' };
let getWindow: (() => BrowserWindow | null) | null = null;
let isRecording: () => Promise<boolean> = async () => false;
// True once initAutoUpdater() has attached the electron-updater listeners (packaged builds only).
let initialized = false;
// initAutoUpdater() only runs once the recorder is up, so "not initialized" is normal during a slow
// startup. Only a recorder that is known to have failed gets the "unavailable" wording.
const STARTING = 'Updates will be available once the recorder has started.';
const UNAVAILABLE = "Updates unavailable: the recorder didn't start.";
let recorderStartFailed = false;

/** Called when startup gave up on the recorder, so update checks say why they can't run. */
export function markRecorderStartFailed(): void {
  recorderStartFailed = true;
}

function push(next: UpdateStatus): void {
  status = next;
  getWindow?.()?.webContents.send('update:status', status);
}

// A silent NSIS install (see below) closes the window with no wizard and no taskbar progress of
// any kind — from the operator's point of view the app just vanishes for several seconds before
// reappearing, which reads as a crash. Two things soften that: an OS-level notification, which
// survives the app process exiting (unlike anything drawn in the renderer), and a short pause
// between "user clicked" and "process actually quits" so the renderer has a moment to show an
// "Installing…" state — see AboutSettings.vue's `state === 'installing'` branch — before the
// window closes out from under it.
function performInstall(version: string): void {
  push({ state: 'installing', version });
  if (Notification.isSupported()) {
    new Notification({
      title: 'Force App is updating',
      body: `Installing version ${version}. The app will close and reopen automatically — this takes a few seconds.`,
    }).show();
  }
  setTimeout(() => {
    // (isSilent, isForceRunAfter). Both matter. The default is a NON-silent install, which
    // launches the full NSIS wizard — the operator answers "Update now" and is then made to
    // click through a setup wizard, which is not what that button promises. Silent skips it;
    // isForceRunAfter brings the app back up afterwards, since a silent NSIS run does not
    // relaunch on its own and the operator would otherwise be left staring at a closed app.
    // Safe here because the installer is perMachine: false — a per-user install needs no
    // elevation, so there is no UAC prompt hiding behind the silent flag.
    autoUpdater.quitAndInstall(true, true);
  }, 800);
}

function showUpdateDialog(version: string, notes: string): void {
  const choice = 'Choose "Not now" to keep working on the current version — you can install it anytime from Settings > About.';
  void dialog
    .showMessageBox({
      type: 'info',
      buttons: ['Update now', 'Not now'],
      defaultId: 0,
      title: 'Update ready',
      message: `Version ${version} has been downloaded and is ready to install.`,
      detail: notes ? `What's new:\n${notes}\n\n${choice}` : choice,
    })
    .then(async ({ response }) => {
      if (response !== 0) return;
      // The dialog can sit open for a long time: a cut may have started (or still be finalizing)
      // since offerUpdate() looked. Check again at the moment of the click, as update:install does.
      if (await isRecording()) {
        deferUntilIdle(version, notes);
        void dialog.showMessageBox({
          type: 'warning',
          buttons: ['OK'],
          title: 'Update postponed',
          message: 'A recording is in progress or still being saved, so the update was not installed.',
          detail: 'You will be asked again once it has finished.',
        });
        return;
      }
      performInstall(version);
    });
}

// Set once a downloaded update is deferred because a cut was running when it finished; re-checked
// on a slow poll rather than wired to a push event, since nothing pushes "recording just stopped"
// to the main process either.
let pending: { version: string; notes: string } | null = null;
let recheckTimer: ReturnType<typeof setInterval> | null = null;

function deferUntilIdle(version: string, notes: string): void {
  pending = { version, notes };
  if (recheckTimer) return;
  recheckTimer = setInterval(async () => {
    if (pending && !(await isRecording())) {
      if (recheckTimer) clearInterval(recheckTimer);
      recheckTimer = null;
      const p = pending;
      pending = null;
      showUpdateDialog(p.version, p.notes);
    }
  }, 60_000);
}

async function offerUpdate(version: string, notes: string): Promise<void> {
  if (await isRecording()) {
    deferUntilIdle(version, notes);
    return;
  }
  showUpdateDialog(version, notes);
}

/** Starts an update check. Shared by Settings > About's button (update:check) and Help > Check for
 * updates. Progress and the outcome arrive as 'update:status' pushes. */
export function startUpdateCheck(): { ok: boolean; reason?: string; message?: string } {
  if (!app.isPackaged) return { ok: false, reason: 'not a packaged build', message: 'Updates are only available in the installed app.' };
  // initAutoUpdater() runs only once the recorder is up (createWindow). Before that nothing is
  // listening for the check's progress or result, so it would run and say nothing.
  if (!initialized) {
    const message = recorderStartFailed ? UNAVAILABLE : STARTING;
    return { ok: false, reason: message, message };
  }
  autoUpdater.checkForUpdates().catch((err) => push({ state: 'error', message: err?.message || String(err) }));
  return { ok: true };
}

/** electron-updater needs a real packaged app with publish config to do anything meaningful —
 * calling it in dev throws on the missing dev-update-config.yml, so this is a no-op there. The
 * IPC handlers stay registered either way so the Settings UI can show "dev build" instead of
 * hanging on a renderer call that never resolves. */
// `isRecording` asks the backend, not the renderer: the recording keeps running server-side even
// when the Record page (and its websocket) is gone, so renderer state would read idle. It must
// also be true while a stopped recording is finalizing: the installer kills the backend, and that
// leaves the cut's capture.mat, live cache and summary unwritten.
export function initAutoUpdater(getMainWindow: () => BrowserWindow | null, recordingInProgress: () => Promise<boolean>): void {
  getWindow = getMainWindow;
  isRecording = recordingInProgress;

  // Same origin check as dialog:pickFolder / shell:reveal (main.ts): only the app's own pages may
  // read update state or trigger a check or an install.
  const NOT_ALLOWED = { ok: false, reason: 'not allowed from this page' };
  ipcMain.handle('update:get-info', (event) =>
    isAppSender(event)
      ? { version: app.getVersion(), packaged: app.isPackaged, status }
      : { version: '', packaged: false, status: { state: 'idle' } satisfies UpdateStatus });
  ipcMain.handle('update:check', (event) => {
    if (!isAppSender(event)) return NOT_ALLOWED;
    return startUpdateCheck();
  });
  // Same guard as the automatic prompt — a manual click from Settings must not be able to force
  // a restart mid-cut either. Re-checks live rather than trusting offerUpdate()'s earlier read,
  // since recording could have started in between.
  ipcMain.handle('update:install', async (event) => {
    if (!isAppSender(event)) return NOT_ALLOWED;
    if (status.state !== 'downloaded') return { ok: false, reason: 'no update downloaded yet' };
    if (await isRecording()) return { ok: false, reason: 'a recording is in progress or still being saved — try again once it finishes' };
    performInstall(status.version);
    return { ok: true };
  });

  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.on('checking-for-update', () => push({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => push({ state: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => push({ state: 'not-available' }));
  autoUpdater.on('download-progress', (p) => push({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    push({ state: 'downloaded', version: info.version });
    void offerUpdate(info.version, formatReleaseNotes(info.releaseNotes));
  });
  autoUpdater.on('error', (err) => {
    push({ state: 'error', message: err?.message || String(err) });
    console.error('autoUpdater error', err);
  });
  initialized = true;

  autoUpdater.checkForUpdates().catch((err) => push({ state: 'error', message: err?.message || String(err) }));
}
