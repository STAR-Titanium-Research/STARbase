import { describe, expect, it, vi } from 'vitest';
import { NOTIFY_MAX_CHARS, checkNotifyArgs, handleNotify, type NotifyDeps } from './notify';

function deps(over: Partial<NotifyDeps> = {}): NotifyDeps & { show: ReturnType<typeof vi.fn>; flash: ReturnType<typeof vi.fn> } {
  return { isFocused: () => false, show: vi.fn(), flash: vi.fn(), ...over } as any;
}

describe('checkNotifyArgs', () => {
  it('accepts two short strings, and an empty body', () => {
    expect(checkNotifyArgs('Rig test #5 needs you', 'Did the chip warn?')).toEqual({ ok: true, title: 'Rig test #5 needs you', body: 'Did the chip warn?' });
    expect(checkNotifyArgs('t', '')).toMatchObject({ ok: true });
  });
  it('accepts exactly the limit and refuses one over, on either argument', () => {
    const at = 'x'.repeat(NOTIFY_MAX_CHARS);
    expect(checkNotifyArgs(at, at).ok).toBe(true);
    expect(checkNotifyArgs(at + 'x', 'b').ok).toBe(false);
    expect(checkNotifyArgs('t', at + 'x').ok).toBe(false);
  });
  it('refuses anything that is not a string, and an empty title', () => {
    for (const bad of [undefined, null, 5, {}, ['a'], true]) {
      expect(checkNotifyArgs(bad, 'b').ok).toBe(false);
      expect(checkNotifyArgs('t', bad).ok).toBe(false);
    }
    expect(checkNotifyArgs('', 'b').ok).toBe(false);
  });
});

describe('handleNotify', () => {
  it('shows the toast and flashes the taskbar when the window is not focused', () => {
    const d = deps();
    expect(handleNotify(d, 'Title', 'Body')).toEqual({ ok: true });
    expect(d.show).toHaveBeenCalledWith({ title: 'Title', body: 'Body' });
    expect(d.flash).toHaveBeenCalledTimes(1);
  });
  it('does neither while the window is focused', () => {
    const d = deps({ isFocused: () => true });
    expect(handleNotify(d, 'Title', 'Body')).toEqual({ ok: true });
    expect(d.show).not.toHaveBeenCalled();
    expect(d.flash).not.toHaveBeenCalled();
  });
  it('does nothing at all for bad arguments', () => {
    const d = deps();
    expect(handleNotify(d, 'x'.repeat(201), 'b').ok).toBe(false);
    expect(handleNotify(d, 1, 'b').ok).toBe(false);
    expect(d.show).not.toHaveBeenCalled();
    expect(d.flash).not.toHaveBeenCalled();
  });
  it('still flashes when notifications are not supported, and says so', () => {
    const d = deps({ show: () => { throw new Error('notifications are not supported'); } });
    expect(handleNotify(d, 'Title', 'Body')).toEqual({ ok: false, reason: 'notifications are not supported' });
    expect(d.flash).toHaveBeenCalledTimes(1);
  });
  it('a window that is gone does not stop the toast', () => {
    const d = deps({ flash: () => { throw new Error('Object has been destroyed'); } });
    expect(handleNotify(d, 'Title', 'Body')).toEqual({ ok: true });
    expect(d.show).toHaveBeenCalled();
  });
});
