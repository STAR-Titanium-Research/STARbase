import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

import { shell } from 'electron';
import { classifyWindowOpen, guardNavigation, isAppSender, popoutKey } from './windowOpen';
import type { WindowStateStore } from './windowState';

function fakeStore(bounds: Record<string, unknown>): WindowStateStore {
  return { get: (key: string) => bounds[key] } as unknown as WindowStateStore;
}

function details(url: string) {
  return { url } as Electron.HandlerDetails;
}

describe('classifyWindowOpen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('allows app://force URLs to open as a new Electron window', () => {
    const result = classifyWindowOpen(details('app://force/live/frm?x=1'));
    expect(result.action).toBe('allow');
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('routes an external Directus admin URL to the system browser and denies the Electron window', () => {
    const url = 'https://d1-server.tail54eeb6.ts.net/admin/content/x/1';
    const result = classifyWindowOpen(details(url));
    expect(result.action).toBe('deny');
    expect(shell.openExternal).toHaveBeenCalledWith(url);
  });

  it('denies an unparsable URL without throwing', () => {
    const result = classifyWindowOpen(details('not a url'));
    expect(result.action).toBe('deny');
  });

  it('denies non-http(s) schemes (e.g. file://) without calling shell.openExternal', () => {
    const result = classifyWindowOpen(details('file:///etc/passwd'));
    expect(result.action).toBe('deny');
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('applies remembered size/position for a pop-out that has been opened before', () => {
    const store = fakeStore({ '/live/force': { x: 40, y: 60, width: 1400, height: 900 } });
    const result = classifyWindowOpen(details('app://force/live/force?mode=psd'), store);
    expect(result.overrideBrowserWindowOptions).toMatchObject({ x: 40, y: 60, width: 1400, height: 900 });
  });

  it('leaves bounds unset (falls back to the window.open() features string) when nothing is saved yet', () => {
    const result = classifyWindowOpen(details('app://force/live/frm'), fakeStore({}));
    expect(result.overrideBrowserWindowOptions).not.toHaveProperty('width');
    expect(result.overrideBrowserWindowOptions).not.toHaveProperty('height');
  });

  it('keys pop-outs by pathname only, so mode/axis query params share one remembered geometry', () => {
    expect(popoutKey('app://force/live/force?mode=psd&channels=Fz')).toBe('/live/force');
    expect(popoutKey('app://force/live/force?mode=time&channels=Fx,Fy,Fz')).toBe('/live/force');
    expect(popoutKey('app://force/live/frm')).toBe('/live/frm');
  });
});

describe('guardNavigation (review 2.11)', () => {
  function attach() {
    const handlers = new Map<string, (e: { preventDefault(): void }, url?: string) => void>();
    guardNavigation({ on: (ev, fn) => { handlers.set(ev, fn); } });
    const run = (ev: string, url?: string) => {
      const e = { preventDefault: vi.fn() };
      handlers.get(ev)!(e, url);
      return e.preventDefault.mock.calls.length > 0;
    };
    return run;
  }

  it('lets the app navigate within app://force', () => {
    const run = attach();
    expect(run('will-navigate', 'app://force/plot?operation=1')).toBe(false);
    expect(run('will-redirect', 'app://force/record')).toBe(false);
  });

  it.each([
    'https://evil.example/',
    'http://localhost:8200/',
    'file:///C:/Windows/win.ini',
    'app://other/index.html',
    'javascript:alert(1)',
    'not a url',
  ])('denies %s', (url) => {
    const run = attach();
    expect(run('will-navigate', url)).toBe(true);
    expect(run('will-redirect', url)).toBe(true);
  });

  it('never lets a webview attach', () => {
    expect(attach()('will-attach-webview')).toBe(true);
  });
});

describe('isAppSender', () => {
  it('accepts only frames served from app://force', () => {
    expect(isAppSender({ senderFrame: { url: 'app://force/settings' } })).toBe(true);
    expect(isAppSender({ senderFrame: { url: 'https://x.example/' } })).toBe(false);
    expect(isAppSender({ senderFrame: null })).toBe(false);
    expect(isAppSender({})).toBe(false);
  });
});
