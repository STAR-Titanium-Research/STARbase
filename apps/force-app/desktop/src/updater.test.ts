import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Review 2.4: "Update now" must re-check for a running/finalizing recording at the click.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  showMessageBox: vi.fn(),
  quitAndInstall: vi.fn(),
  updater: null as any,
  windows: [] as any[],
  toasts: [] as any[],
  toastsSupported: false,
}));

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.0.0' },
  dialog: { showMessageBox: (...a: unknown[]) => h.showMessageBox(...a) },
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { h.handlers.set(ch, fn); } },
  BrowserWindow: { getAllWindows: () => h.windows },
  Notification: class {
    static isSupported() { return h.toastsSupported; }
    handlers = new Map<string, () => void>();
    shown = false;
    constructor(public opts: any) { h.toasts.push(this); }
    on(ev: string, fn: () => void) { this.handlers.set(ev, fn); }
    show() { this.shown = true; }
  },
}));
vi.mock('electron-updater', () => {
  const u: any = new EventEmitter();
  u.checkForUpdates = vi.fn(async () => undefined);
  u.quitAndInstall = (...a: unknown[]) => h.quitAndInstall(...a);
  h.updater = u;
  return { autoUpdater: u };
});

const APP = { senderFrame: { url: 'app://force/settings/about' } };
const FOREIGN = { senderFrame: { url: 'https://evil.example/' } };

async function boot(isRecording: () => Promise<boolean>) {
  vi.resetModules();
  h.handlers.clear();
  const { initAutoUpdater } = await import('./updater');
  initAutoUpdater(() => null, isRecording);
}

async function downloaded() {
  h.updater.emit('update-downloaded', { version: '2.0.0' });
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  h.showMessageBox.mockReset();
  h.quitAndInstall.mockReset();
  h.updater?.removeAllListeners();
  h.windows = [];
  h.toasts = [];
  h.toastsSupported = false;
});
afterEach(() => { vi.useRealTimers(); });

describe('updater recording gate', () => {
  it('installs when "Update now" is clicked and nothing is recording', async () => {
    await boot(async () => false);
    h.showMessageBox.mockResolvedValue({ response: 0 });
    await downloaded();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('does not install when a recording (or finalize) started while the dialog was open', async () => {
    let busy = false;
    await boot(async () => busy);
    h.showMessageBox.mockImplementationOnce(async () => { busy = true; return { response: 0 }; });
    h.showMessageBox.mockResolvedValue({ response: 0 });   // the "postponed" notice
    await downloaded();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.quitAndInstall).not.toHaveBeenCalled();
    // and it is offered again once the cut is over
    h.showMessageBox.mockClear();
    h.showMessageBox.mockResolvedValue({ response: 1 });
    busy = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.showMessageBox.mock.calls[0][0].title).toBe('Update ready');
  });

  it('defers the first prompt while busy', async () => {
    await boot(async () => true);
    await downloaded();
    expect(h.showMessageBox).not.toHaveBeenCalled();
  });

  it('update:install refuses while busy', async () => {
    let busy = true;
    await boot(async () => busy);
    h.showMessageBox.mockResolvedValue({ response: 1 });
    await downloaded();   // status becomes "downloaded" (prompt deferred)
    const install = h.handlers.get('update:install')!;
    expect(await install(APP)).toMatchObject({ ok: false });
    busy = false;
    expect(await install(APP)).toEqual({ ok: true });
  });

  // Review 2.11: the update:* handlers check the sender like dialog:pickFolder / shell:reveal.
  it('update:* handlers refuse a page that is not app://force', async () => {
    await boot(async () => false);
    h.showMessageBox.mockResolvedValue({ response: 1 });
    await downloaded();
    expect(await h.handlers.get('update:install')!(FOREIGN)).toEqual({ ok: false, reason: 'not allowed from this page' });
    expect(await h.handlers.get('update:check')!(FOREIGN)).toEqual({ ok: false, reason: 'not allowed from this page' });
    expect(await h.handlers.get('update:get-info')!(FOREIGN)).toMatchObject({ version: '', packaged: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.quitAndInstall).not.toHaveBeenCalled();
  });

  it('update:* handlers serve the app\'s own pages', async () => {
    await boot(async () => false);
    expect(await h.handlers.get('update:get-info')!(APP)).toMatchObject({ version: '1.0.0', packaged: true });
    expect(await h.handlers.get('update:check')!(APP)).toEqual({ ok: true });
    expect(await h.handlers.get('update:install')!(APP)).toMatchObject({ ok: false, reason: 'no update downloaded yet' });
  });
});

// #197: with a window the update prompt is drawn in the app (UpdatePrompt.vue), never as a native
// dialog that steals focus from whatever the operator is typing (the login password).
describe('update prompt with a main window (#197)', () => {
  function windowStub() {
    const send = vi.fn();
    return {
      send,
      win: {
        isDestroyed: () => false, isMinimized: () => false, isVisible: () => true, isFocused: () => true,
        flashFrame: () => {}, once: () => {},
        webContents: { send, getURL: () => 'app://force/' },
      },
    };
  }
  async function bootWithWindow(isRecording: () => Promise<boolean>, win: unknown) {
    vi.resetModules();
    h.handlers.clear();
    const { initAutoUpdater } = await import('./updater');
    initAutoUpdater(() => win as never, isRecording);
  }

  it('sends update:status downloaded with the version and notes, and shows no native dialog', async () => {
    const { send, win } = windowStub();
    await bootWithWindow(async () => false, win);
    h.updater.emit('update-downloaded', { version: '2.0.0', releaseNotes: '<ul><li>Fixed flat forces</li></ul>' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.showMessageBox).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('update:status', { state: 'downloaded', version: '2.0.0', notes: '- Fixed flat forces' });
  });

  it('still sends the status, and no dialog, when a recording is running; the dialog never appears later either', async () => {
    let busy = true;
    const { send, win } = windowStub();
    await bootWithWindow(async () => busy, win);
    await downloaded();
    expect(send).toHaveBeenCalledWith('update:status', expect.objectContaining({ state: 'downloaded', version: '2.0.0' }));
    busy = false;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.showMessageBox).not.toHaveBeenCalled();
  });

  it('pushes update:status to the pop-out app windows too, not to destroyed or foreign ones', async () => {
    const { send, win } = windowStub();
    const popSend = vi.fn(), deadSend = vi.fn(), foreignSend = vi.fn();
    h.windows = [
      win,
      { isDestroyed: () => false, webContents: { send: popSend, getURL: () => 'app://force/live-force?mode=1' } },
      { isDestroyed: () => true, webContents: { send: deadSend, getURL: () => 'app://force/' } },
      { isDestroyed: () => false, webContents: { send: foreignSend, getURL: () => 'https://example.com/' } },
    ];
    await bootWithWindow(async () => false, win);
    await downloaded();
    const want = { state: 'downloaded', version: '2.0.0', notes: '' };
    expect(popSend).toHaveBeenCalledWith('update:status', want);
    expect(send).toHaveBeenCalledTimes(1); // the main window is also in getAllWindows(): once only
    expect(deadSend).not.toHaveBeenCalled();
    expect(foreignSend).not.toHaveBeenCalled();
    h.updater.emit('error', new Error('x'));
    expect(popSend).toHaveBeenLastCalledWith('update:status', { state: 'error', message: 'x' });
  });

  it('flashes the taskbar button when the window is minimised or hidden, and stops on focus', async () => {
    for (const [minimized, visible] of [[true, true], [false, false]] as const) {
      const { win } = windowStub();
      const flashFrame = vi.fn();
      let onFocus: (() => void) | undefined;
      Object.assign(win, {
        isMinimized: () => minimized, isVisible: () => visible, flashFrame,
        once: (ev: string, fn: () => void) => { if (ev === 'focus') onFocus = fn; },
      });
      await bootWithWindow(async () => false, win);
      await downloaded();
      expect(flashFrame).toHaveBeenCalledWith(true);
      onFocus!();
      expect(flashFrame).toHaveBeenLastCalledWith(false);
    }
  });

  it('does not flash when the window is visible', async () => {
    const { win } = windowStub();
    const flashFrame = vi.fn();
    Object.assign(win, { isMinimized: () => false, isVisible: () => true, flashFrame, once: vi.fn() });
    await bootWithWindow(async () => false, win);
    await downloaded();
    expect(flashFrame).not.toHaveBeenCalled();
  });

  it('falls back to the native dialog when the window is gone', async () => {
    const { win } = windowStub();
    win.isDestroyed = () => true;
    await bootWithWindow(async () => false, win);
    h.showMessageBox.mockResolvedValue({ response: 1 });
    await downloaded();
    expect(h.showMessageBox).toHaveBeenCalledOnce();
  });

  it('falls back to the native dialog when there is no window at all', async () => {
    await bootWithWindow(async () => false, null);
    h.showMessageBox.mockResolvedValue({ response: 1 });
    await downloaded();
    expect(h.showMessageBox).toHaveBeenCalledOnce();
  });

  it('update:install (the prompt\'s button) still refuses while recording, and installs once idle', async () => {
    let busy = true;
    const { win } = windowStub();
    await bootWithWindow(async () => busy, win);
    await downloaded();
    const install = h.handlers.get('update:install')!;
    expect(await install(APP)).toMatchObject({ ok: false });
    expect(h.quitAndInstall).not.toHaveBeenCalled();
    busy = false;
    expect(await install(APP)).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.quitAndInstall).toHaveBeenCalledWith(true, true);
  });
});

// A later check that fails (Help > Check for updates while offline) must not hide, or disable the
// install of, an update that is already on disk.
describe('a downloaded update survives a later check', () => {
  it('get-info still reports downloaded after an error push, and install proceeds', async () => {
    await boot(async () => false);
    h.showMessageBox.mockResolvedValue({ response: 1 });
    h.updater.emit('update-downloaded', { version: '2.0.0', releaseNotes: 'notes' });
    await vi.advanceTimersByTimeAsync(0);
    h.updater.emit('checking-for-update');
    h.updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    const info = await h.handlers.get('update:get-info')!(APP) as { status: unknown };
    expect(info.status).toEqual({ state: 'downloaded', version: '2.0.0', notes: 'notes' });
    expect(await h.handlers.get('update:install')!(APP)).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('install still refuses while recording after the error push', async () => {
    await boot(async () => true);
    await downloaded();
    h.updater.emit('error', new Error('offline'));
    expect(await h.handlers.get('update:install')!(APP)).toMatchObject({ ok: false, reason: expect.stringContaining('recording') });
  });

  it('once the install has started, get-info reports installing', async () => {
    await boot(async () => false);
    h.showMessageBox.mockResolvedValue({ response: 1 });
    await downloaded();
    await h.handlers.get('update:install')!(APP);
    const info = await h.handlers.get('update:get-info')!(APP) as { status: unknown };
    expect(info.status).toEqual({ state: 'installing', version: '2.0.0' });
  });
});

describe('startUpdateCheck before the updater is initialized', () => {
  it('says updates will be available once the recorder has started, while it is still starting', async () => {
    vi.resetModules();
    h.handlers.clear();
    h.updater.checkForUpdates.mockClear();
    const { startUpdateCheck } = await import('./updater');
    const r = startUpdateCheck();
    expect(r.ok).toBe(false);
    expect(r.message).toBe('Updates will be available once the recorder has started.');
    expect(r.reason).toBe(r.message);
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('says updates are unavailable once the recorder is known to have failed to start', async () => {
    vi.resetModules();
    h.handlers.clear();
    h.updater.checkForUpdates.mockClear();
    const { startUpdateCheck, markRecorderStartFailed } = await import('./updater');
    markRecorderStartFailed();
    const r = startUpdateCheck();
    expect(r.ok).toBe(false);
    expect(r.message).toBe("Updates unavailable: the recorder didn't start.");
    expect(r.reason).toBe(r.message);
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('starts the check once initAutoUpdater has run', async () => {
    vi.resetModules();
    h.handlers.clear();
    const { initAutoUpdater, startUpdateCheck } = await import('./updater');
    initAutoUpdater(() => null, async () => false);
    h.updater.checkForUpdates.mockClear();
    expect(startUpdateCheck()).toEqual({ ok: true });
    expect(h.updater.checkForUpdates).toHaveBeenCalledOnce();
  });
});

describe('update-downloaded dialog release notes (R13)', () => {
  async function dialogDetail(releaseNotes: unknown): Promise<string> {
    await boot(async () => false);
    h.showMessageBox.mockResolvedValue({ response: 1 });
    h.updater.emit('update-downloaded', { version: '2.0.0', releaseNotes });
    await vi.advanceTimersByTimeAsync(0);
    return h.showMessageBox.mock.calls[0][0].detail as string;
  }

  it('shows the notes, as plain text, above the usual hint', async () => {
    const detail = await dialogDetail('<ul><li>Fixed flat forces</li><li>Faster &amp; safer</li></ul>');
    expect(detail).toContain("What's new:");
    expect(detail).toContain('- Fixed flat forces');
    expect(detail).toContain('- Faster & safer');
    expect(detail).not.toContain('<li>');
    expect(detail).toContain('Not now');
  });

  it('accepts the array form', async () => {
    const detail = await dialogDetail([{ version: '2.0.0', note: '<p>Only this</p>' }]);
    expect(detail).toContain('Only this');
  });

  it('keeps the old text when there are no notes', async () => {
    const detail = await dialogDetail(undefined);
    expect(detail).not.toContain("What's new");
    expect(detail).toContain('Not now');
  });

  it('trims very long notes', async () => {
    const detail = await dialogDetail('x '.repeat(5000));
    expect(detail.length).toBeLessThan(2000);
    expect(detail).toContain('full notes: https://github.com/STAR-Titanium-Research/STARbase/releases');
  });
});

// #197: an operator who is not looking at the app (minimised, hidden, another window in front)
// gets a Windows notification that the update is ready; clicking it brings the window back.
describe('update-ready OS notification (#197)', () => {
  function win(over: Record<string, unknown> = {}) {
    return {
      isDestroyed: () => false, isMinimized: () => false, isVisible: () => true, isFocused: () => true,
      flashFrame: () => {}, once: () => {}, restore: vi.fn(), show: vi.fn(), focus: vi.fn(),
      webContents: { send: vi.fn(), getURL: () => 'app://force/' },
      ...over,
    };
  }
  async function bootWin(w: unknown, isRecording: () => Promise<boolean> = async () => false) {
    vi.resetModules();
    h.handlers.clear();
    h.toastsSupported = true;
    const { initAutoUpdater } = await import('./updater');
    initAutoUpdater(() => w as never, isRecording);
  }

  it('shows one notification when the window is not focused, titled with the version', async () => {
    await bootWin(win({ isFocused: () => false, isMinimized: () => true }));
    await downloaded();
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].shown).toBe(true);
    expect(h.toasts[0].opts.title).toBe('Force App 2.0.0 is ready to install');
    expect(h.toasts[0].opts.body).toBeTruthy();
  });

  it('shows none when the window is focused (the in-app card is in front)', async () => {
    await bootWin(win());
    await downloaded();
    expect(h.toasts).toHaveLength(0);
  });

  it('shows none during a recording, and not later once idle either while the window is focused', async () => {
    let busy = true;
    await bootWin(win({ isFocused: () => false }), async () => busy);
    await downloaded();
    expect(h.toasts).toHaveLength(0);
    busy = false;
    await vi.advanceTimersByTimeAsync(60_000);   // the deferred offer fires once idle
    expect(h.toasts).toHaveLength(1);
  });

  it('shows once per version: a second download event of the same version is silent, a newer one is not', async () => {
    await bootWin(win({ isFocused: () => false }));
    await downloaded();
    await downloaded();
    expect(h.toasts).toHaveLength(1);
    h.updater.emit('update-downloaded', { version: '2.1.0' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.toasts).toHaveLength(2);
    expect(h.toasts[1].opts.title).toContain('2.1.0');
  });

  it('shows none when there is no window (the native dialog is the fallback)', async () => {
    await bootWin(null);
    h.showMessageBox.mockResolvedValue({ response: 1 });
    await downloaded();
    expect(h.toasts).toHaveLength(0);
  });

  it('clicking it restores, shows and focuses the window', async () => {
    const w = win({ isFocused: () => false, isMinimized: () => true, isVisible: () => false });
    await bootWin(w);
    await downloaded();
    h.toasts[0].handlers.get('click')!();
    expect(w.restore).toHaveBeenCalled();
    expect(w.show).toHaveBeenCalled();
    expect(w.focus).toHaveBeenCalled();
  });
});
