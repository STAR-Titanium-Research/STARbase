import { contextBridge, ipcRenderer } from 'electron';
import type { UpdateStatus } from './updater';

/** Subscribes to a main -> renderer channel and returns the function that unsubscribes. Without it
 * every visit to a view that listens (Settings > About) added one more ipcRenderer listener for the
 * life of the window (review 2.10). */
function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: unknown, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('forceApp', {
  // Electron's window.confirm() opens a native OS dialog that Playwright's CDP-based dialog
  // interception cannot see or dismiss (unlike a plain Chromium page) — any confirm() gate in the
  // renderer hangs an automated test forever. Renderer code that gates on confirm() should check
  // this first and skip straight to the non-blocking outcome when true.
  testHooks: process.env.FORCE_APP_TEST_HOOKS === '1',
  onNavigate: (callback: (path: string) => void): (() => void) => subscribe<string>('navigate', callback),
  getUpdateInfo: (): Promise<{ version: string; packaged: boolean; status: UpdateStatus }> =>
    ipcRenderer.invoke('update:get-info'),
  checkForUpdates: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('update:check'),
  installUpdate: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (callback: (status: UpdateStatus) => void): (() => void) =>
    subscribe<UpdateStatus>('update:status', callback),
  /** Native folder picker; resolves to the chosen folder, or null if cancelled. */
  pickFolder: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder', defaultPath),
  /** Stops and respawns the recorder backend (R11). Refused while a recording is running or being
   * saved; `reason` says why. */
  restartRecorder: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('sidecar:restart'),
  /** Opens a local capture's folder in the file browser. Main only allows paths inside the
   * backend's captures folder. */
  revealPath: (target: string): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('shell:reveal', target),
});
