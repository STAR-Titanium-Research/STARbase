import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, MessageBoxOptions } from 'electron';
import { watchRenderer, type RendererWatchDeps } from './rendererWatch';

// A stand-in BrowserWindow: just the events and methods watchRenderer touches, so this runs
// without the Electron binary.
function fakeWindow() {
  const contents = Object.assign(new EventEmitter(), {
    getURL: () => 'app://force/record',
    reload: vi.fn(),
    forcefullyCrashRenderer: vi.fn(),
  });
  const win = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
    close: vi.fn(),
  });
  return { win, contents, asWindow: win as unknown as BrowserWindow };
}

function deps(response: number | ((opts: MessageBoxOptions) => Promise<number>)) {
  const log = vi.fn();
  const showMessageBox = vi.fn(async (_w: BrowserWindow, opts: MessageBoxOptions) => ({
    response: typeof response === 'number' ? response : await response(opts),
    checkboxChecked: false,
  }));
  return { log, showMessageBox } satisfies RendererWatchDeps;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('watchRenderer', () => {
  it('logs a renderer crash and reloads when the operator picks Reload', async () => {
    const { contents, asWindow } = fakeWindow();
    const d = deps(0);
    watchRenderer(asWindow, 'main', d);

    contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 3 });
    await flush();

    expect(d.log).toHaveBeenCalledWith('ERROR', expect.stringContaining('main renderer gone at /record: crashed'));
    expect(d.showMessageBox).toHaveBeenCalledTimes(1);
    expect(contents.reload).toHaveBeenCalled();
  });

  it('closes the window when the operator picks Close window', async () => {
    const { win, contents, asWindow } = fakeWindow();
    watchRenderer(asWindow, 'pop-out', deps(1));
    contents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 0 });
    await flush();
    expect(win.close).toHaveBeenCalled();
    expect(contents.reload).not.toHaveBeenCalled();
  });

  it("labels the crash dialog's exit button 'Quit app' for the main window only", async () => {
    const labels: Record<string, string[]> = {};
    for (const label of ['main', 'pop-out']) {
      const { contents, asWindow } = fakeWindow();
      const d = deps(0);
      watchRenderer(asWindow, label, d);
      contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 3 });
      await flush();
      labels[label] = d.showMessageBox.mock.calls[0][1].buttons as string[];
    }
    expect(labels.main).toEqual(['Reload', 'Quit app']);
    expect(labels['pop-out']).toEqual(['Reload', 'Close window']);
  });

  it('ignores a clean renderer exit', async () => {
    const { contents, asWindow } = fakeWindow();
    const d = deps(0);
    watchRenderer(asWindow, 'main', d);
    contents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
    await flush();
    expect(d.log).not.toHaveBeenCalled();
    expect(d.showMessageBox).not.toHaveBeenCalled();
  });

  it('dismisses the hang dialog by itself when the page recovers', async () => {
    const { win, contents, asWindow } = fakeWindow();
    let signal: AbortSignal | undefined;
    // Resolves as Electron does for an aborted dialog: as if cancelled (cancelId 0 = Wait).
    const d = deps((opts) => {
      signal = opts.signal;
      return new Promise((resolve) => opts.signal?.addEventListener('abort', () => resolve(0)));
    });
    watchRenderer(asWindow, 'main', d);

    win.emit('unresponsive');
    win.emit('unresponsive'); // a repeat does not stack a second dialog
    expect(d.showMessageBox).toHaveBeenCalledTimes(1);
    win.emit('responsive');
    await flush();

    expect(signal?.aborted).toBe(true);
    expect(contents.reload).not.toHaveBeenCalled();
  });

  it('crashes and reloads a hung page on Reload, without a second crash dialog for it', async () => {
    const { win, contents, asWindow } = fakeWindow();
    const d = deps(1);
    watchRenderer(asWindow, 'main', d);

    win.emit('unresponsive');
    await flush();
    expect(contents.forcefullyCrashRenderer).toHaveBeenCalled();
    expect(contents.reload).toHaveBeenCalled();

    // The deliberate crash reports back as render-process-gone: logged, but not prompted again.
    contents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 1 });
    await flush();
    expect(d.showMessageBox).toHaveBeenCalledTimes(1);
  });
});
