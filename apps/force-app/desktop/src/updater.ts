import { app, dialog, ipcMain, Notification, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';

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

function showUpdateDialog(version: string): void {
  void dialog
    .showMessageBox({
      type: 'info',
      buttons: ['Update now', 'Not now'],
      defaultId: 0,
      title: 'Update ready',
      message: `Version ${version} has been downloaded and is ready to install.`,
      detail: 'Choose "Not now" to keep working on the current version — you can install it anytime from Settings > About.',
    })
    .then(({ response }) => {
      if (response === 0) performInstall(version);
    });
}

// Set once a downloaded update is deferred because a cut was running when it finished; re-checked
// on a slow poll rather than wired to a push event, since nothing pushes "recording just stopped"
// to the main process either.
let pendingVersion: string | null = null;
let recheckTimer: ReturnType<typeof setInterval> | null = null;

async function offerUpdate(version: string): Promise<void> {
  if (await isRecording()) {
    pendingVersion = version;
    if (!recheckTimer) {
      recheckTimer = setInterval(async () => {
        if (pendingVersion && !(await isRecording())) {
          if (recheckTimer) clearInterval(recheckTimer);
          recheckTimer = null;
          const v = pendingVersion;
          pendingVersion = null;
          showUpdateDialog(v);
        }
      }, 60_000);
    }
    return;
  }
  showUpdateDialog(version);
}

/** electron-updater needs a real packaged app with publish config to do anything meaningful —
 * calling it in dev throws on the missing dev-update-config.yml, so this is a no-op there. The
 * IPC handlers stay registered either way so the Settings UI can show "dev build" instead of
 * hanging on a renderer call that never resolves. */
// `isRecording` asks the backend, not the renderer: the recording keeps running server-side even
// when the Record page (and its websocket) is gone, so renderer state would read idle.
export function initAutoUpdater(getMainWindow: () => BrowserWindow | null, recordingInProgress: () => Promise<boolean>): void {
  getWindow = getMainWindow;
  isRecording = recordingInProgress;

  ipcMain.handle('update:get-info', () => ({ version: app.getVersion(), packaged: app.isPackaged, status }));
  ipcMain.handle('update:check', () => {
    if (!app.isPackaged) return { ok: false, reason: 'not a packaged build' };
    autoUpdater.checkForUpdates().catch((err) => push({ state: 'error', message: err?.message || String(err) }));
    return { ok: true };
  });
  // Same guard as the automatic prompt — a manual click from Settings must not be able to force
  // a restart mid-cut either. Re-checks live rather than trusting offerUpdate()'s earlier read,
  // since recording could have started in between.
  ipcMain.handle('update:install', async () => {
    if (status.state !== 'downloaded') return { ok: false, reason: 'no update downloaded yet' };
    if (await isRecording()) return { ok: false, reason: 'a recording is in progress — try again once it finishes' };
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
    void offerUpdate(info.version);
  });
  autoUpdater.on('error', (err) => {
    push({ state: 'error', message: err?.message || String(err) });
    console.error('autoUpdater error', err);
  });

  autoUpdater.checkForUpdates().catch((err) => push({ state: 'error', message: err?.message || String(err) }));
}
