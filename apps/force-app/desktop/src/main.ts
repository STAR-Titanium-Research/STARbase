import { app, BrowserWindow, dialog, Menu, screen } from 'electron';
import path from 'node:path';
import { ConfigStore } from './config';
import { buildMenu } from './menu';
import { findAvailablePort } from './port';
import { registerAppScheme, handleAppProtocol } from './protocol';
import { offerScheduledTaskCleanup } from './scheduledTask';
import { SidecarSupervisor, type SidecarState } from './sidecar';
import { initAutoUpdater } from './updater';
import { classifyWindowOpen, popoutKey } from './windowOpen';
import { WindowStateStore, isOnSomeDisplay } from './windowState';

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
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

registerAppScheme();

let mainWindow: BrowserWindow | null = null;
let supervisor: SidecarSupervisor | null = null;
let recorderPort: number | null = null;
// Set once the operator has confirmed quitting mid-recording (or once there was nothing to confirm).
// Both the window 'close' and app 'before-quit' paths check it, so the prompt appears exactly once
// however the quit was triggered — window X, Alt+F4, or the application menu.
let quitConfirmed = false;

/** Is the backend mid-recording, and what has it captured so far? Null when it is not.
 *
 * Asks the backend rather than the renderer: recording is server-side and keeps running even when
 * RecordPage is unmounted (navigating away tears down its websocket), so renderer state would
 * report "idle" for a recording that is very much still going.
 */
async function activeRecording(): Promise<{ sample: string; elapsed: number; samples: number } | null> {
  if (recorderPort == null) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${recorderPort}/record/status`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const s = (await res.json()) as {
      state?: string;
      elapsed_sec?: number;
      n_total?: number;
      config?: { sample_name?: string };
    };
    if (s.state !== 'recording') return null;
    return {
      sample: s.config?.sample_name || 'the current run',
      elapsed: Number(s.elapsed_sec ?? 0),
      samples: Number(s.n_total ?? 0),
    };
  } catch {
    // Backend unreachable => fail OPEN and allow the quit. Failing closed would trap the operator
    // in an app they cannot close whenever the sidecar has already died, which is precisely when
    // they most want to restart it.
    return null;
  }
}

/** True if it is safe to proceed with quitting. Prompts only when a recording is actually running. */
async function confirmQuitDuringRecording(): Promise<boolean> {
  // Native dialogs are invisible to Playwright's CDP dialog interception and would hang the e2e
  // suite for its full timeout — the same trap window.confirm() gates fell into (commit d0b075c).
  if (process.env.FORCE_APP_TEST_HOOKS === '1') return true;
  const rec = await activeRecording();
  if (!rec) return true;
  const mins = Math.floor(rec.elapsed / 60);
  const secs = Math.floor(rec.elapsed % 60);
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Keep recording', 'Stop recording and quit'],
    defaultId: 0, // safe option focused, so a stray Enter does not end a run
    cancelId: 0,
    title: 'A recording is in progress',
    message: `"${rec.sample}" is still recording.`,
    detail:
      `${mins}:${String(secs).padStart(2, '0')} elapsed, ${rec.samples.toLocaleString()} samples captured.\n\n` +
      'Quitting stops acquisition now. Data captured so far is written to disk and can be recovered, ' +
      'but the rest of the cut will not be recorded.',
  });
  return response === 1;
}
Menu.setApplicationMenu(buildMenu(() => mainWindow));

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
    args: ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)],
    cwd: backendDir,
    env: recorderEnv(),
  };
}

function onSidecarStateChange(state: SidecarState, detail?: string): void {
  if (state === 'crashed') {
    dialog.showErrorBox('Recorder backend stopped responding', detail ?? 'See logs for details.');
  }
  // A restart (not the initial start) means the backend crashed mid-session — route the
  // operator back to Record, where the existing recovery banner (RecordPage.vue) picks up any
  // incomplete session via GET /recovery/check on mount.
  if (state === 'ready' && supervisor && supervisor.getRestartCount() > 0) {
    mainWindow?.webContents.send('navigate', '/record');
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

async function createWindow(): Promise<void> {
  const configStore = new ConfigStore(app.getPath('userData'));
  configStore.seedIfMissing();
  const windowState = new WindowStateStore(app.getPath('userData'));

  const mainKey = 'main';
  const savedMain = windowState.get(mainKey);
  // A remembered position is only usable if the machine still has a screen there. Undock the
  // monitor a window was last on and the saved coordinates point into empty space, which reopens
  // the app somewhere the operator cannot see or drag it back from. Drop just the position in that
  // case and let Electron place the window; the remembered SIZE is still good.
  const mainOnScreen = savedMain ? isOnSomeDisplay(savedMain, currentDisplayAreas()) : false;
  mainWindow = new BrowserWindow({
    width: savedMain?.width ?? 1500,
    height: savedMain?.height ?? 950,
    x: mainOnScreen ? savedMain?.x : undefined,
    y: mainOnScreen ? savedMain?.y : undefined,
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
    const maximized = mainWindow.isMaximized();
    // getNormalBounds() for minimized too, not just maximized: Windows reports x/y ≈ -32000 for a
    // minimized window, so closing while minimized would persist an off-screen position and the
    // next launch would open out of view.
    const restoring = maximized || mainWindow.isMinimized();
    const bounds = restoring ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    windowState.save(mainKey, { ...bounds, maximized });
  });
  mainWindow.webContents.setWindowOpenHandler((details) => classifyWindowOpen(details, windowState));
  // setWindowOpenHandler only returns creation OPTIONS, not a handle to the window itself — this
  // is the hook that actually gets one, so a pop-out's size/position can be saved when it closes.
  mainWindow.webContents.on('did-create-window', (win, details) => {
    const key = popoutKey(details.url);
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

  if (supervisor.getState() !== 'ready') {
    dialog.showErrorBox(
      'Recorder backend failed to start',
      supervisor.lastDetail() ?? 'The backend did not become healthy in time.',
    );
    return;
  }

  await mainWindow.loadURL('app://force/');
  void offerScheduledTaskCleanup();
  initAutoUpdater(() => mainWindow, async () => (await activeRecording()) != null);
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
    void createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // The View/Help bar is redundant now — both menu items just navigate to Settings tabs already
  // reachable from the in-app sidebar. Hiding (not removing) it keeps the Menu registered, so
  // Reload/Toggle DevTools still work via their normal accelerators; only the visible bar goes
  // away. Covers every window the app creates, including the "open in a second window" popouts
  // from AppShell.vue, not just the main one.
  app.on('browser-window-created', (_event, window) => {
    window.setMenuBarVisibility(false);
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
    if (!supervisor || supervisor.getState() === 'stopped') return;
    event.preventDefault();
    void supervisor.stop().then(() => app.quit());
  });
}
