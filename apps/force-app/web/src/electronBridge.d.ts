// Ambient type for the bridge apps/force-app/desktop/src/preload.ts exposes. `window.forceApp` is
// only present when the SPA runs inside the Electron shell — the same bundle also serves the
// read-only /app/ browser surface (infra/caddy/Caddyfile), where it is undefined.
export {};

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string; notes: string }
  | { state: 'installing'; version: string }
  | { state: 'error'; message: string };

declare global {
  interface Window {
    forceApp?: {
      testHooks: boolean;
      /** Returns the function that removes the listener. */
      onNavigate: (callback: (path: string) => void) => () => void;
      getUpdateInfo: () => Promise<{ version: string; packaged: boolean; status: UpdateStatus }>;
      checkForUpdates: () => Promise<{ ok: boolean; reason?: string }>;
      installUpdate: () => Promise<{ ok: boolean; reason?: string }>;
      /** Returns the function that removes the listener; call it when the view goes away. */
      onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void;
      /** Native folder picker (#101); the chosen folder, or null if cancelled. */
      pickFolder: (defaultPath?: string) => Promise<string | null>;
      /** Notify about updates while the app is closed (#197): a Windows scheduled task the desktop shell
       * creates and removes. `supported` is false outside the installed Windows app. */
      getUpdateNotifyWhenClosed: () => Promise<{ supported: boolean; enabled: boolean; active: boolean }>;
      setUpdateNotifyWhenClosed: (enabled: boolean) => Promise<{ ok: boolean; enabled: boolean; reason?: string }>;
      /** Stops and respawns the recorder backend (R11). Refused while a recording is running or
       * being saved; `reason` says why. Resolves once the backend is healthy again, or failed to be. */
      restartRecorder: () => Promise<{ ok: boolean; reason?: string }>;
      /** Opens a local capture's folder in the file browser (#96). Only paths inside the backend's
       * captures folder are allowed; `reason` says why when not. */
      revealPath: (target: string) => Promise<{ ok: boolean; reason?: string }>;
      /** Rig-test prompts and questions: a desktop notification and a flashing taskbar button, only
       * while the window is not focused. Both strings are at most 200 characters. */
      notify: (title: string, body: string) => Promise<{ ok: boolean; reason?: string }>;
    };
  }
}
