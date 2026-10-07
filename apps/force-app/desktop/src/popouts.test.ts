import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

import { MAX_RESTORED_POPOUTS, PopoutTracker, restorablePopoutUrls, type OpenPopoutStore } from './popouts';
import { WindowStateStore } from './windowState';

function memoryStore(initial: unknown = undefined): OpenPopoutStore & { value: unknown } {
  const s = {
    value: initial,
    getOpenPopouts: () => s.value,
    setOpenPopouts: (urls: string[]) => {
      s.value = urls;
    },
  };
  return s;
}

function fakeWindow(url: string) {
  const win = Object.assign(new EventEmitter(), {
    destroyed: false,
    current: url,
    isDestroyed() {
      return this.destroyed;
    },
    webContents: { getURL: () => win.current },
    close() {
      this.destroyed = true;
      this.emit('closed');
    },
  });
  return win;
}

describe('restorablePopoutUrls', () => {
  it("keeps only the app's own pages, each once", () => {
    const saved = [
      'app://force/live/force?mode=psd',
      'https://example.com/phish',
      'file:///C:/Windows/system32/calc.exe',
      'app://evil/live/force',
      42,
      'app://force/live/force?mode=psd',
      'app://force/live/frm',
    ];
    expect(restorablePopoutUrls(saved)).toEqual(['app://force/live/force?mode=psd', 'app://force/live/frm']);
  });

  it('caps the number reopened', () => {
    const many = Array.from({ length: 20 }, (_, i) => `app://force/live/force?n=${i}`);
    expect(restorablePopoutUrls(many)).toHaveLength(MAX_RESTORED_POPOUTS);
  });

  it('treats anything but a list as nothing saved', () => {
    expect(restorablePopoutUrls(undefined)).toEqual([]);
    expect(restorablePopoutUrls({ url: 'app://force/live/frm' })).toEqual([]);
  });
});

describe('PopoutTracker', () => {
  it('forgets a pop-out the operator closes', () => {
    const store = memoryStore();
    const t = new PopoutTracker(store);
    const a = fakeWindow('app://force/live/force');
    const b = fakeWindow('app://force/live/frm');
    t.track(a, a.current);
    t.track(b, b.current);
    expect(store.value).toEqual(['app://force/live/force', 'app://force/live/frm']);

    a.close();
    expect(store.value).toEqual(['app://force/live/frm']);
  });

  it('keeps the pop-outs that were open when the app quit, at their current URL', () => {
    const store = memoryStore();
    const t = new PopoutTracker(store);
    const a = fakeWindow('app://force/live/force?mode=time');
    t.track(a, a.current);
    a.current = 'app://force/live/force?mode=psd'; // the operator switched mode in the pop-out

    t.beginQuit();
    a.close(); // quitting closes every window: that must not count as the operator closing it
    expect(store.value).toEqual(['app://force/live/force?mode=psd']);
  });

  it('reads the saved list once, before reopening rewrites it', () => {
    const store = memoryStore(['app://force/live/frm', 'https://example.com']);
    const t = new PopoutTracker(store);
    t.track(fakeWindow('app://force/live/frm'), 'app://force/live/frm');
    expect(t.toRestore()).toEqual(['app://force/live/frm']);
  });

  it('round-trips through the window-state file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'popouts-test-'));
    try {
      const store = new WindowStateStore(dir);
      store.save('/live/frm', { width: 1200, height: 1000 });
      const t = new PopoutTracker(store);
      t.track(fakeWindow('app://force/live/frm'), 'app://force/live/frm');
      t.beginQuit();

      const next = new PopoutTracker(new WindowStateStore(dir));
      expect(next.toRestore()).toEqual(['app://force/live/frm']);
      // Pop-out geometry is stored alongside and unaffected.
      expect(new WindowStateStore(dir).get('/live/frm')).toEqual({ width: 1200, height: 1000 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
