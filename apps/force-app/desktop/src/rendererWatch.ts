import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron';

export interface RendererWatchDeps {
  showMessageBox: (win: BrowserWindow, opts: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  /** Where the event is recorded — main.ts sends it to the backend log, so a bug report has it. */
  log: (level: 'ERROR' | 'WARNING', message: string) => void;
}

const RECORDING_NOTE =
  'The recorder backend runs separately, so a recording in progress keeps going and is not affected.';

/** #106: a renderer that crashes or hangs used to leave a blank or frozen window with nothing said
 * and nothing recorded. Logs both, and offers a reload. Attached to the main window and to every
 * pop-out. */
export function watchRenderer(win: BrowserWindow, label: string, deps: RendererWatchDeps): void {
  // One crash dialog and one hang dialog at most. Separate flags because a crash can arrive while
  // the hang dialog is up: that dialog is then dismissed and the crash one shown in its place.
  let crashPrompt = false;
  // Set when the hang dialog's Reload crashes the renderer on purpose, so that crash is not then
  // reported back to the operator as a second, separate failure.
  let crashRequested = false;
  let hangDialog: AbortController | null = null;

  const where = () => {
    try {
      return new URL(win.webContents.getURL()).pathname;
    } catch {
      return '?';
    }
  };

  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    deps.log('ERROR', `${label} renderer gone at ${where()}: ${details.reason} (exit code ${details.exitCode})`);
    hangDialog?.abort();
    if (crashRequested) {
      crashRequested = false;
      return;
    }
    if (crashPrompt || win.isDestroyed()) return;
    crashPrompt = true;
    // Closing the main window quits the app (the pop-outs depend on it), so say that.
    const closeLabel = label === 'main' ? 'Quit app' : 'Close window';
    void deps
      .showMessageBox(win, {
        type: 'error',
        buttons: ['Reload', closeLabel],
        defaultId: 0,
        cancelId: 0,
        title: 'This window stopped working',
        message: `The ${label} window's page ${details.reason === 'oom' ? 'ran out of memory' : 'crashed'}.`,
        detail: `${RECORDING_NOTE} Reload to bring the window back.`,
      })
      .then(({ response }) => {
        if (win.isDestroyed()) return;
        if (response === 0) win.webContents.reload();
        else win.close();
      })
      .finally(() => {
        crashPrompt = false;
      });
  });

  win.on('unresponsive', () => {
    deps.log('WARNING', `${label} renderer unresponsive at ${where()}`);
    if (crashPrompt || hangDialog || win.isDestroyed()) return;
    const dialog = new AbortController();
    hangDialog = dialog;
    void deps
      .showMessageBox(win, {
        type: 'warning',
        buttons: ['Wait', 'Reload'],
        defaultId: 0, // waiting is the safe choice: a long redraw may still finish
        cancelId: 0,
        title: 'This window is not responding',
        message: `The ${label} window is not responding.`,
        detail: `${RECORDING_NOTE} Wait for it, or reload the window.`,
        // Closes the dialog by itself if the page recovers — see 'responsive' below.
        signal: dialog.signal,
      })
      .then(({ response }) => {
        if (response !== 1 || win.isDestroyed()) return;
        // A hung page will not run a normal reload; crashing its renderer first is Electron's
        // documented way out, and the reload then starts a fresh one.
        crashRequested = true;
        win.webContents.forcefullyCrashRenderer();
        win.webContents.reload();
      })
      .finally(() => {
        if (hangDialog === dialog) hangDialog = null;
      });
  });

  win.on('responsive', () => {
    if (hangDialog) deps.log('WARNING', `${label} renderer responsive again at ${where()}`);
    hangDialog?.abort();
  });
}
