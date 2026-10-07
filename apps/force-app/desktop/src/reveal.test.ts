import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRevealTarget } from './reveal';

let base: string;
let root: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'reveal-test-'));
  root = path.join(base, 'captures');
  fs.mkdirSync(path.join(root, '20261002-100000-abc'), { recursive: true });
  fs.writeFileSync(path.join(root, '20261002-100000-abc', 'summary.json'), '{}');
  fs.mkdirSync(path.join(base, 'captures-evil'));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('checkRevealTarget', () => {
  it('allows a capture folder inside the captures root', () => {
    const dir = path.join(root, '20261002-100000-abc');
    expect(checkRevealTarget(dir, root)).toEqual({ ok: true, path: fs.realpathSync(dir), isDir: true });
  });

  it('allows the captures root itself, and files inside it', () => {
    expect(checkRevealTarget(root, root)).toMatchObject({ ok: true, isDir: true });
    const file = path.join(root, '20261002-100000-abc', 'summary.json');
    expect(checkRevealTarget(file, root)).toMatchObject({ ok: true, isDir: false });
  });

  it('refuses anything outside the root, including a sibling that shares its prefix', () => {
    expect(checkRevealTarget(base, root).ok).toBe(false);
    expect(checkRevealTarget(path.join(base, 'captures-evil'), root).ok).toBe(false);
    expect(checkRevealTarget(path.join(root, '..', 'captures-evil'), root).ok).toBe(false);
  });

  it('refuses a path outside the root before touching the filesystem', () => {
    const real = vi.spyOn(fs, 'realpathSync');
    try {
      // A UNC share is only "absolute" on Windows; elsewhere it is refused even earlier.
      for (const outside of ['\\\\attacker\\share\\x', path.join(base, 'captures-evil')]) {
        expect(checkRevealTarget(outside, root).ok).toBe(false);
      }
      expect(checkRevealTarget(path.join(root, '..', '..', 'etc'), root).ok).toBe(false);
      expect(real).not.toHaveBeenCalled();
    } finally {
      real.mockRestore();
    }
  });

  it('refuses a link inside the root that points outside it', () => {
    const link = path.join(root, 'escape');
    fs.symlinkSync(path.join(base, 'captures-evil'), link, 'dir');
    expect(checkRevealTarget(link, root).ok).toBe(false);
  });

  it('refuses relative, missing and non-string paths', () => {
    expect(checkRevealTarget('captures/20261002-100000-abc', root).ok).toBe(false);
    expect(checkRevealTarget(path.join(root, 'gone'), root).ok).toBe(false);
    expect(checkRevealTarget(42, root).ok).toBe(false);
    expect(checkRevealTarget('', root).ok).toBe(false);
  });

  it('refuses everything when the captures root itself is unavailable', () => {
    const dir = path.join(root, '20261002-100000-abc');
    expect(checkRevealTarget(dir, path.join(base, 'offline-drive')).ok).toBe(false);
  });
});
