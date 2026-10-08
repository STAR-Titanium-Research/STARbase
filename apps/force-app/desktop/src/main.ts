import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { ConfigStore } from './config';
import { applyMenuBarMode, buildMenu } from './menu';
import { findAvailablePort } from './port';
import { registerAppScheme, handleAppProtocol } from './protocol';
import { checkRevealTarget } from './reveal';
import { isCrashRecovery, restartRecorder, unknownStatusDialog } from './restart';
import { watchRenderer } from './rendererWatch';
import { PopoutTracker } from './popouts';
import { fetchBusySession, fetchRecorderActivity, confirmQuit, type BusySession } from './quitGuard';
import { offerScheduledTaskCleanup } from './scheduledTask';
import { SidecarSupervisor, type SidecarState } from './sidecar';
import { initAutoUpdater, markRecorderStartFailed, startUpdateCheck } from './updater';
import { classifyWindowOpen, guardNavigation, isAppSender, popoutKey } from './windowOpen';
import { DEFAULT_MAIN_SIZE, DEFAULT_POPOUT_SIZE, WindowStateStore, placementFor } from './windowState';

const PREFERRED_PORT = 8200;
const HEALTH_PATH = '/health';

// Single-instance lock. A second launch would spawn a second sidecar (the port probe would push
// it to 8201) with both instances writing the same <userData>/config.json and, worse, the same
// capture storage root — a data-integrity hazard for an instrument. Focus the running window
// instead. `mainWindow` is assigned later; this closure only runs once the app is up.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    restorePopouts();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

registerAppScheme();

let mainWindow: BrowserWindow | null = null;
// #108: which pop-outs are open, so the ones open at quit come back on the next start.
let popouts: PopoutTracker<BrowserWindow> | null = null;
let supervisor: SidecarSupervisor | null = null;
let recorderPort: number | null = null;
// Set once the operator has confirmed quitting mid-recording (or once there was nothing to confirm).
// Both the window 'close' and app 'before-quit' paths check it, so the prompt appears exactly once
// however the quit was triggered — window X, Alt+F4, or the application menu.
let quitConfirmed = false;

/** A request to the local recorder backend, or null when it has no port yet (not started, or
 * between restarts). Rejects like `fetch` on a network error or timeout, so callers keep their own
 * "couldn't ask" handling. */
async function recorderFetch(path: string, timeoutMs: number, init: RequestInit = {}): Promise<Response | null> {
  if (recorderPort == null) return null;
  return fetch(`http://127.0.0.1:${recorderPort}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** Is the backend recording, or finalizing a recording it just stopped? Null when neither.
 *
 * Asks the backend rather than the renderer: recording is server-side and keeps running even when
 * RecordPage is unmounted (navigating away tears down its websocket), so renderer state would
 * report "idle" for a recording that is very much still going. Finalizing counts too: killing the
 * backend then leaves capture.mat, live_cache.bin and summary.json unwritten.
 */
function activeSession(): Promise<BusySession | null> {
  return fetchBusySession((p, t) => recorderFetch(p, t));
}

/** True if it is safe to proceed with quitting. Prompts only when a recording is actually running
 * or still being saved. */
async function confirmQuitDuringRecording(): Promise<boolean> {
  // Native dialogs are invisible to Playwright's CDP dialog interception and would hang the e2e
  // suite for its full timeout — the same trap window.confirm() gates fell into (commit d0b075c).
  if (process.env.FORCE_APP_TEST_HOOKS === '1') return true;
  return confirmQuit({ getBusy: activeSession, showMessageBox: (o) => dialog.showMessageBox(o) });
}
Menu.setApplicationMenu(
  buildMenu(() => mainWindow, {
    checkForUpdates: () => {
      const r = startUpdateCheck();
      // Progress shows on Settings > About; only a check that could not even start needs a box.
      if (!r.ok) {
        void dialog.showMessageBox({
          type: 'info',
          buttons: ['OK'],
          title: 'Check for updates',
          message: r.message ?? 'Updates are unavailable.',
          detail: r.message === r.reason ? undefined : r.reason,
        });
      }
    },
    openCapturesFolder: () => {
      void openCapturesFolder();
    },
  }),
);

function webDistDir(): string {
  // dist-desktop (base '/'), not dist (base '/app/'): the /app/ variant's asset URLs cannot
  // resolve under app://force/. Dev mode uses the same variant the installer ships so what we
  // test is what we ship. Build it with `npm run build:web:desktop` from the repo root.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'web')
    : path.join(__dirname, '..', '..', 'web', 'dist-desktop');
}

// The recorder backend keeps its own CORS allowlist (RECORDER_CORS_ORIGINS, defaulting to the
// Vite dev-server origins). Under Electron the renderer's origin is app://force, which is not in
// that default, so every renderer -> recorder request would be CORS-blocked. Thread it in
// explicitly for both the dev and packaged branches — it's the same backend either way.
//
// FORCE_APP_LOG_DIR pins the backend's log file inside Electron's userData rather than letting it
// fall back to its own per-user default. That keeps the app's logs alongside its other user data,
// and matters most for the packaged build: the backend lives under Program Files there, which a
// standard user cannot write to. Built lazily (not as a module-level const) because
// app.getPath() is only valid once the app is ready.
function recorderEnv(): NodeJS.ProcessEnv {
  return {
    RECORDER_CORS_ORIGINS: 'app://force',
    FORCE_APP_LOG_DIR: path.join(app.getPath('userData'), 'logs'),
  };
}

function backendCommand(port: number): {
  exePath: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
} {
  if (app.isPackaged) {
    return {
      exePath: path.join(process.resourcesPath, 'backend', 'force-app-backend.exe'),
      args: ['--port', String(port)],
      // A packaged install IS an acquisition rig — the backend's own default (main.py:
      // LABAMP_MODE, unset => "mock") exists for dev/CI, where no charge amp is attached, and
      // was never meant to reach a real deployment silently. Without this, a fresh install (or
      // one running on whatever ambient environment the app happened to be launched with) talks
      // to a MOCK amp with no indication anything is wrong — /labamp/status still reports a
      // plausible-looking "MEASURE" mode, just fabricated, not read from the real hardware.
      // `?? 'real'` only supplies the default: an operator who deliberately sets LABAMP_MODE in
      // the environment (e.g. to test without an amp connected) is still respected.
      env: { ...recorderEnv(), LABAMP_MODE: process.env.LABAMP_MODE ?? 'real' },
    };
  }
  // Dev mode: the same venv + uvicorn invocation apps/force-app/backend/scripts/start_recorder.ps1
  // uses, but bound to loopback only — the sidecar is reached solely by this app, on this machine.
  const backendDir = path.join(__dirname, '..', '..', 'backend');
  return {
    exePath: path.join(backendDir, '.venv', 'Scripts', 'python.exe'),
    // --no-access-log: the same per-request stdout flood run_frozen.py turns off (#106).
    args: ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port), '--no-access-log'],
    cwd: backendDir,
    env: recorderEnv(),
  };
}

/** Records a desktop-shell event in the backend's log file (via POST /logs/client), so it lands in
 * Settings > Logs and in a bug report's log tail — this process has no log of its own that an
 * operator can see. Best effort: when the backend is the thing that is down, console is all. */
function logToBackend(level: 'ERROR' | 'WARNING' | 'INFO', message: string): void {
  console.error(`[desktop] ${message}`);
  void recorderFetch('/logs/client', 2000, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, source: 'desktop', message }),
  }).catch(() => {});
}

const rendererWatchDeps = {
  showMessageBox: (win: BrowserWindow, opts: Electron.MessageBoxOptions) => dialog.showMessageBox(win, opts),
  log: logToBackend,
};

// Why the backend last restarted. It is down while 'restarting' is reported, so the log line
// waits for the 'ready' that follows.
let restartCause: string | undefined;
// supervisor.start() settles (ready or crashed) before this is set. A crash during that startup is
// reported once by createWindow() below, so the state callback must stay quiet for it, or the
// operator gets two error boxes for one failure (review 2.9).
let startupSettled = false;
// True only while supervisor.restart() runs for the operator's "Restart recorder": a crash then is
// reported to them as the restart's result, not also as a separate error box. Not set while a
// confirmation dialog is open, so a real crash or auto-restart meanwhile is announced normally.
let manualRestart = false;
// True from the moment "Restart recorder" is invoked until it has finished (including any dialog).
let restartInProgress = false;

function onSidecarStateChange(state: SidecarState, detail?: string): void {
  if (state === 'restarting') restartCause = detail;
  if (state === 'crashed' && startupSettled && !manualRestart) {
    dialog.showErrorBox('Recorder backend stopped responding', detail ?? 'See logs for details.');
  }
  // A restart (not the initial start) means the backend crashed mid-session — route the
  // operator back to Record, where the existing recovery banner (RecordPage.vue) picks up any
  // incomplete session via GET /recovery/check on mount.
  if (supervisor && isCrashRecovery(state, supervisor.getRestartCount(), manualRestart)) {
    logToBackend('WARNING', `recorder backend restarted (${restartCause ?? 'unknown cause'})`);
    mainWindow?.webContents.send('navigate', '/record');
  }
}

/** Only the app's own pages may use the file-system IPC below — never a page some navigation or
 * window.open() slip let into a window. */
function fromApp(event: IpcMainInvokeEvent): boolean {
  return isAppSender(event);
}

function registerShellIpc(): void {
  // #101: Settings > General's "Choose folder…". The browser build has no such dialog and types
  // the path instead; either way the backend validates the choice (POST /storage/config).
  ipcMain.handle('dialog:pickFolder', async (event, defaultPath: unknown) => {
    if (!fromApp(event)) return null;
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose where recordings are saved',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined,
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });

  // #96: "Show in folder" for a local capture. The allowed area is asked of this app's own
  // backend each time rather than taken from the renderer, since the root can change at runtime.
  ipcMain.handle('shell:reveal', async (event, requested: unknown) => {
    if (!fromApp(event)) return { ok: false, reason: 'not allowed from this page' };
    const root = await currentCapturesRoot();
    return root ? revealInFileBrowser(requested, root) : NO_BACKEND;
  });

  // R11: Settings > Connectivity's "Restart recorder". Goes through the same supervisor as launch
  // and the crash restarts. Refused while a recording is running or being saved. When the backend
  // does not answer: restarted at once if the supervisor already knows it is down, otherwise the
  // operator is asked first (a busy recorder can be slow to answer too).
  ipcMain.handle('sidecar:restart', async (event) => {
    if (!fromApp(event)) return { ok: false, reason: 'not allowed from this page' };
    if (restartInProgress) return { ok: false, reason: 'a restart is already in progress' };
    restartInProgress = true;
    try {
      const result = await restartRecorder({
        getActivity: () => fetchRecorderActivity((p, t) => recorderFetch(p, t)),
        // Native dialogs would hang the e2e suite (see confirmQuitDuringRecording).
        // Modal to the window that asked, so the operator can't keep working behind it.
        confirmUnknown: async () => {
          if (process.env.FORCE_APP_TEST_HOOKS === '1') return true;
          const parent = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
          const opts = unknownStatusDialog();
          const res = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
          return res.response === 1;
        },
        restart: supervisor
          ? async () => {
              manualRestart = true;
              try {
                await supervisor!.restart();
              } finally {
                manualRestart = false;
              }
            }
          : null,
        getState: () => supervisor?.getState(),
        lastDetail: () => supervisor?.lastDetail(),
      });
      logToBackend(result.ok ? 'INFO' : 'WARNING', `recorder restart requested from the app: ${result.ok ? 'ok' : result.reason}`);
      return result;
    } finally {
      restartInProgress = false;
    }
  });
}

const NO_BACKEND = { ok: false, reason: "can't reach the recording backend" };

/** Opens `requested` in the file browser if it lies inside the captures folder `root`. */
async function revealInFileBrowser(requested: unknown, root: string): Promise<{ ok: boolean; reason?: string }> {
  const check = checkRevealTarget(requested, root);
  if (!check.ok) return check;
  if (check.isDir) {
    // Opens the folder itself, showing its files. openPath only for directories: on a file it
    // would launch whatever program the file type is associated with.
    const err = await shell.openPath(check.path);
    return err ? { ok: false, reason: err } : { ok: true };
  }
  shell.showItemInFolder(check.path);
  return { ok: true };
}

/** Help > Open Captures Folder: the capture drive the backend is configured with right now
 * (GET /storage/config), the same root "Show in folder" is confined to. */
async function openCapturesFolder(): Promise<void> {
  const root = await currentCapturesRoot();
  const result = root ? await revealInFileBrowser(root, root) : NO_BACKEND;
  if (!result.ok) {
    void dialog.showMessageBox({
      type: 'warning',
      buttons: ['OK'],
      title: 'Open captures folder',
      message: "Couldn't open the captures folder.",
      detail: result.reason,
    });
  }
}

async function currentCapturesRoot(): Promise<string | null> {
  try {
    const res = await recorderFetch('/storage/config', 3000);
    if (!res?.ok) return null;
    const body = (await res.json()) as { captures_root?: unknown };
    return typeof body.captures_root === 'string' && body.captures_root ? body.captures_root : null;
  } catch {
    return null;
  }
}

/** Work areas of every connected screen (excludes taskbars/docks). Wrapped because `screen` is
 * only usable after the app is ready, and a failure here should degrade to "place it yourself"
 * rather than take the window down. */
function currentDisplayAreas() {
  try {
    return screen.getAllDisplays().map((d) => d.workArea);
  } catch {
    return [];
  }
}

/** #187: a pop-out that is minimised (Win+D, or the taskbar) shows in the taskbar as an empty
 * preview and cannot be switched to, so a second launch restores each open one. Where a window
 * opens is decided by placementFor (a stale or off-screen saved position is dropped and Electron
 * centres it), so there is nothing to re-place here. */
function restorePopouts(): void {
  for (const win of popouts?.windows() ?? []) {
    if (win.isDestroyed()) continue;
    try {
      if (win.isMinimized()) win.restore();
    } catch (err) {
      console.error('restoring a pop-out failed', err);
    }
  }
}

async function createWindow(): Promise<void> {
  const configStore = new ConfigStore(app.getPath('userData'));
  configStore.seedIfMissing();
  const windowState = new WindowStateStore(app.getPath('userData'));
  popouts = new PopoutTracker<BrowserWindow>(windowState);

  const mainKey = 'main';
  const savedMain = windowState.get(mainKey);
  // A remembered position is only usable if the machine still has a screen there. Undock the
  // monitor a window was last on and the saved coordinates point into empty space, which reopens
  // the app somewhere the operator cannot see or drag it back from. placementFor drops just the
  // position in that case and lets Electron place the window; the remembered SIZE is still good.
  mainWindow = new BrowserWindow({
    ...DEFAULT_MAIN_SIZE,
    ...placementFor(savedMain, currentDisplayAreas()),
    show: false,
    // Packaged builds get this for free — electron-builder embeds build/icon.ico into the .exe
    // itself, and Windows shows that everywhere (title bar, taskbar, Start Menu) with no runtime
    // help. Only dev mode needs it here: `electron .` runs the plain node_modules Electron binary,
    // which shows Electron's own default icon unless a window explicitly overrides it.
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  if (savedMain?.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  watchRenderer(mainWindow, 'main', rendererWatchDeps);
  // #35: F11 fullscreen, the conventional browser/desktop-app shortcut -- Electron doesn't wire
  // this up on its own. before-input-event (not a Menu accelerator) keeps it working even though
  // this app runs frameless-menu-less; scoped to just the main window, not a global shortcut, so
  // it doesn't fire while a detached panel window has focus instead.
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      mainWindow?.setFullScreen(!mainWindow.isFullScreen());
    }
  });
  // Bounds while maximized are the whole-screen size, not a meaningful "last used" size to
  // restore into next launch — save the pre-maximize bounds instead and just reapply maximize().
  mainWindow.on('close', (event) => {
    if (!mainWindow) return;
    // Guard here, not only in 'before-quit': clicking the window X destroys the window first, so a
    // prompt raised from before-quit would appear with nothing behind it and the app already
    // half torn down. Deferring the close is safe — nothing else has run yet.
    if (!quitConfirmed) {
      event.preventDefault();
      void confirmQuitDuringRecording().then((ok) => {
        if (!ok) return; // operator chose to keep recording; the window simply stays open
        quitConfirmed = true;
        mainWindow?.close(); // re-enter, now past the guard
      });
      return;
    }
    // The app is going: the pop-outs open now are the ones to bring back next time, and the
    // closes that follow are the quit's, not the operator's.
    popouts?.beginQuit();
    const maximized = mainWindow.isMaximized();
    // getNormalBounds() for minimized too, not just maximized: Windows reports x/y ≈ -32000 for a
    // minimized window, so closing while minimized would persist an off-screen position and the
    // next launch would open out of view.
    const restoring = maximized || mainWindow.isMinimized();
    const bounds = restoring ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    windowState.save(mainKey, { ...bounds, maximized });
  });
  // Closing the main window quits the app, pop-outs included. They are fed by this window (the
  // live relay in liveClient.ts) and go blank without it, and the quit prompt above has just told
  // the operator that acquisition stops — which only happens if the app really does quit.
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
  mainWindow.webContents.setWindowOpenHandler((details) => classifyWindowOpen(details, windowState, currentDisplayAreas()));
  // setWindowOpenHandler only returns creation OPTIONS, not a handle to the window itself — this
  // is the hook that actually gets one, so a pop-out's size/position can be saved when it closes.
  mainWindow.webContents.on('did-create-window', (win, details) => {
    const key = popoutKey(details.url);
    watchRenderer(win, 'pop-out', rendererWatchDeps);
    popouts?.track(win, details.url);
    win.on('close', () => windowState.save(key, win.isMinimized() || win.isMaximized() ? win.getNormalBounds() : win.getBounds()));
  });

  handleAppProtocol(webDistDir(), configStore.path);
  await mainWindow.loadFile(path.join(__dirname, '..', 'static', 'loading.html'));

  const port = await findAvailablePort(PREFERRED_PORT);
  recorderPort = port; // so the quit guard can ask the backend whether a recording is running
  configStore.setRecorderPort(port);
  const cmd = backendCommand(port);

  supervisor = new SidecarSupervisor({
    exePath: cmd.exePath,
    args: cmd.args,
    cwd: cmd.cwd,
    env: cmd.env,
    port,
    healthUrl: `http://127.0.0.1:${port}${HEALTH_PATH}`,
    onStateChange: onSidecarStateChange,
  });
  await supervisor.start();
  startupSettled = true;

  if (supervisor.getState() !== 'ready') {
    markRecorderStartFailed();
    dialog.showErrorBox(
      'Recorder backend failed to start',
      supervisor.lastDetail() ?? 'The backend did not become healthy in time.',
    );
    return;
  }

  await mainWindow.loadURL('app://force/');
  reopenPopouts();
  void offerScheduledTaskCleanup();
  initAutoUpdater(() => mainWindow, async () => (await activeSession()) != null);
}

/** #108: reopens the pop-outs that were open at the last quit. Opened from the main window's own
 * page, exactly as its buttons open them, so each goes through the same window-open handler
 * (remembered size and position) and gets tracked again; it then resyncs over the live relay.
 * Only app://force URLs reach here (PopoutTracker vets the saved list), and JSON.stringify keeps
 * each one a plain string literal in the script. Skipped for the e2e suite, which expects a
 * single window. */
function reopenPopouts(): void {
  if (process.env.FORCE_APP_TEST_HOOKS === '1' || !mainWindow || !popouts) return;
  for (const url of popouts.toRestore()) {
    mainWindow.webContents
      .executeJavaScript(`void window.open(${JSON.stringify(url)}, '_blank', 'noopener,width=${DEFAULT_POPOUT_SIZE.width},height=${DEFAULT_POPOUT_SIZE.height}')`, true)
      .catch((err) => console.error('reopening a pop-out failed', err));
  }
}

export function getSupervisor(): SidecarSupervisor | null {
  return supervisor;
}

// Test-only: lets the Playwright smoke suite (tests/smoke.spec.ts) reach the supervisor through
// app.evaluate(), which has no access to this module's exports otherwise. Inert unless the test
// runner explicitly opts in via the env var.
if (process.env.FORCE_APP_TEST_HOOKS === '1') {
  (global as unknown as { __forceAppTestHooks: unknown }).__forceAppTestHooks = { getSupervisor };
}

// Only the lock-holding instance boots a window and a sidecar; the loser already called
// app.quit() above and must not register any of this.
if (gotLock) {
  app.whenReady().then(() => {
    registerShellIpc();
    void createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // The View/Help bar is hidden until Alt is pressed (auto-hide), not removed: Help > Check for
  // Updates, About and Connectivity Doctor have no accelerator, so Alt is how they are reached.
  // Keeping the Menu registered also keeps Reload/Toggle DevTools working via their normal
  // accelerators. Covers every window the app creates, including the "open in a second window"
  // popouts from AppShell.vue, not just the main one.
  // Every window and pop-out (and any WebContents the app might create later) may only navigate
  // within app://force.
  app.on('web-contents-created', (_event, contents) => guardNavigation(contents));

  app.on('browser-window-created', (_event, window) => {
    applyMenuBarMode(window);
  });

  app.on('before-quit', (event) => {
    // Covers the quit paths that never touch the window's own 'close' handler — the application
    // menu and Alt+F4. quitConfirmed makes this a no-op when the window guard already asked.
    if (!quitConfirmed) {
      event.preventDefault();
      void confirmQuitDuringRecording().then((ok) => {
        if (!ok) return;
        quitConfirmed = true;
        app.quit();
      });
      return;
    }
    popouts?.beginQuit();
    if (!supervisor || supervisor.getState() === 'stopped') return;
    event.preventDefault();
    void supervisor.stop().then(() => app.quit());
  });
}
