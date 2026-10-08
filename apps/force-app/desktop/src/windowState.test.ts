import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WindowStateStore, isOnSomeDisplay, isSaneBounds, placementFor, saneSize } from './windowState';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-state-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('WindowStateStore', () => {
  it('returns undefined for a key that was never saved', () => {
    const store = new WindowStateStore(dir);
    expect(store.get('main')).toBeUndefined();
  });

  it('round-trips saved bounds', () => {
    const store = new WindowStateStore(dir);
    store.save('main', { x: 10, y: 20, width: 1500, height: 950 });

    expect(store.get('main')).toEqual({ x: 10, y: 20, width: 1500, height: 950 });
  });

  it('keeps different keys independent, e.g. main window vs. a pop-out', () => {
    const store = new WindowStateStore(dir);
    store.save('main', { width: 1500, height: 950 });
    store.save('/live/force', { width: 1400, height: 900 });

    expect(store.get('main')).toEqual({ width: 1500, height: 950 });
    expect(store.get('/live/force')).toEqual({ width: 1400, height: 900 });
  });

  it('persists across separate store instances (same file on disk)', () => {
    new WindowStateStore(dir).save('main', { width: 1600, height: 1000, maximized: true });

    expect(new WindowStateStore(dir).get('main')).toEqual({ width: 1600, height: 1000, maximized: true });
  });

  it('never persists minimised-origin or zero-size bounds, and keeps the previous good entry (#187)', () => {
    const store = new WindowStateStore(dir);
    store.save('/live/force', { x: 40, y: 60, width: 1400, height: 900 });
    store.save('/live/force', { x: -32000, y: -32000, width: 1400, height: 900 });
    store.save('/live/force', { x: 100, y: -32000, width: 1400, height: 900 });
    store.save('/live/force', { x: 100, y: 100, width: 0, height: 900 });
    store.save('/live/force', { x: 100, y: 100, width: 1400, height: 0 });
    expect(store.get('/live/force')).toEqual({ x: 40, y: 60, width: 1400, height: 900 });
    store.save('/live/frm', { x: -32000, y: -32000, width: 160, height: 28 });
    expect(store.get('/live/frm')).toBeUndefined();
  });

  it('does not throw when the underlying file is missing or corrupt', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'window-state.json'), '{ not valid json');

    expect(new WindowStateStore(dir).get('main')).toBeUndefined();
  });
});

describe('isOnSomeDisplay', () => {
  // A typical single-monitor desktop, minus the taskbar.
  const one = [{ x: 0, y: 0, width: 1920, height: 1080 }];
  // Plus a second monitor placed to the left, as Windows reports it (negative origin).
  const two = [...one, { x: -1920, y: 0, width: 1920, height: 1080 }];

  it('accepts a window fully inside a display', () => {
    expect(isOnSomeDisplay({ x: 100, y: 100, width: 800, height: 600 }, one)).toBe(true);
  });

  it('accepts a window straddling two displays', () => {
    expect(isOnSomeDisplay({ x: -200, y: 100, width: 800, height: 600 }, two)).toBe(true);
  });

  it('rejects a window on a monitor that is no longer connected', () => {
    // Saved while the left-hand monitor was attached; now only the primary remains.
    expect(isOnSomeDisplay({ x: -1800, y: 100, width: 800, height: 600 }, one)).toBe(false);
  });

  it('rejects the off-screen origin Windows reports for a minimized window', () => {
    expect(isOnSomeDisplay({ x: -32000, y: -32000, width: 800, height: 600 }, one)).toBe(false);
  });

  it('treats bounds with no saved position as acceptable (Electron will place it)', () => {
    expect(isOnSomeDisplay({ width: 800, height: 600 }, one)).toBe(true);
  });

  it('accepts anything when no displays are reported, rather than discarding placement', () => {
    expect(isOnSomeDisplay({ x: 10, y: 10, width: 800, height: 600 }, [])).toBe(true);
  });

  it('rejects a window that only overlaps a display by a pixel or two', () => {
    expect(isOnSomeDisplay({ x: 1919, y: 100, width: 800, height: 600 }, one)).toBe(false);
    expect(isOnSomeDisplay({ x: -799, y: 100, width: 800, height: 600 }, one)).toBe(false);
  });

  it('rejects a window whose title bar is above or below the screen though its body overlaps', () => {
    expect(isOnSomeDisplay({ x: 100, y: -300, width: 800, height: 600 }, one)).toBe(false);
    expect(isOnSomeDisplay({ x: 100, y: 1075, width: 800, height: 600 }, one)).toBe(false);
  });

  it('accepts a window with enough of its title bar visible to grab', () => {
    expect(isOnSomeDisplay({ x: 1820, y: 100, width: 800, height: 600 }, one)).toBe(true);
    expect(isOnSomeDisplay({ x: 100, y: -10, width: 800, height: 600 }, one)).toBe(true);
    expect(isOnSomeDisplay({ x: -700, y: 100, width: 800, height: 600 }, one)).toBe(true);
  });
});

describe('isSaneBounds / saneSize / placementFor (#187)', () => {
  const screen1 = [{ x: 0, y: 0, width: 1920, height: 1040 }];

  it('rejects the minimised origin and empty sizes, accepts ordinary bounds incl. a left monitor', () => {
    expect(isSaneBounds({ x: -32000, y: -32000, width: 800, height: 600 })).toBe(false);
    expect(isSaneBounds({ x: 10, y: -30000, width: 800, height: 600 })).toBe(false);
    expect(isSaneBounds({ x: 10, y: 10, width: 0, height: 600 })).toBe(false);
    expect(isSaneBounds({ x: 10, y: 10, width: Number.NaN, height: 600 })).toBe(false);
    expect(isSaneBounds({ x: -1500, y: 20, width: 800, height: 600 })).toBe(true);
    expect(isSaneBounds({ width: 800, height: 600 })).toBe(true);
    expect(isSaneBounds(undefined)).toBe(false);
  });

  it('drops x/y for the -32000 origin but keeps a sane size', () => {
    expect(placementFor({ x: -32000, y: -32000, width: 1400, height: 900 }, screen1)).toEqual({ width: 1400, height: 900 });
  });

  it('drops x/y for a rect on a monitor that is no longer there', () => {
    expect(placementFor({ x: -1800, y: 100, width: 1400, height: 900 }, screen1)).toEqual({ width: 1400, height: 900 });
  });

  it('keeps a sane rect that is on a present display', () => {
    expect(placementFor({ x: 40, y: 60, width: 1400, height: 900 }, screen1)).toEqual({ x: 40, y: 60, width: 1400, height: 900 });
  });

  it('clamps a size saved on a bigger display to the biggest display present (#187)', () => {
    // 2560x1440 saved on a big monitor, reopened on a 1920x1080 one with x/y dropped.
    const laptop = [{ x: 0, y: 0, width: 1920, height: 1080 }];
    expect(placementFor({ x: 2600, y: 10, width: 2560, height: 1440 }, laptop)).toEqual({ width: 1920, height: 1080 });
    expect(placementFor({ width: 2560, height: 1440 }, laptop)).toEqual({ width: 1920, height: 1080 });
    // Only the oversized axis shrinks.
    expect(placementFor({ x: 0, y: 0, width: 1500, height: 1440 }, laptop)).toEqual({ x: 0, y: 0, width: 1500, height: 1080 });
  });

  it('clamps to the largest display when several are present, and keeps size when none are reported', () => {
    const mixed = [{ x: 0, y: 0, width: 1366, height: 768 }, { x: 1366, y: 0, width: 2560, height: 1400 }];
    expect(placementFor({ width: 3000, height: 1600 }, mixed)).toEqual({ width: 2560, height: 1400 });
    expect(placementFor({ width: 2560, height: 1440 }, [])).toEqual({ width: 2560, height: 1440 });
  });

  it('does not keep a position whose title bar is not reachable', () => {
    expect(placementFor({ x: 1919, y: 10, width: 1400, height: 900 }, screen1)).toEqual({ width: 1400, height: 900 });
  });

  it('returns nothing when the size itself is unusable or nothing is saved', () => {
    expect(placementFor({ x: 40, y: 60, width: 0, height: 900 }, screen1)).toEqual({});
    expect(placementFor(undefined, screen1)).toEqual({});
    expect(placementFor('junk', screen1)).toEqual({});
  });

  it('saneSize accepts ordinary sizes and rejects zero, tiny, huge and non-numeric ones', () => {
    expect(saneSize(1400, 900)).toBe(true);
    expect(saneSize(0, 900)).toBe(false);
    expect(saneSize(1400, 199)).toBe(false);
    expect(saneSize(20001, 900)).toBe(false);
    expect(saneSize(Number.NaN, 900)).toBe(false);
    expect(saneSize('1400', 900)).toBe(false);
    expect(saneSize(undefined, undefined)).toBe(false);
  });

  it('places the main window the same way: a saved rect on a gone monitor keeps only its size', () => {
    expect(placementFor({ x: 2500, y: 10, width: 1500, height: 950, maximized: true }, screen1)).toEqual({ width: 1500, height: 950 });
    expect(placementFor({ x: 10, y: 10, width: 1500, height: 950, maximized: true }, screen1)).toEqual({ x: 10, y: 10, width: 1500, height: 950 });
  });
});
