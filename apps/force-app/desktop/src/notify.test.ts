import { describe, expect, it, vi } from 'vitest';
import { MAX_RIG_TOASTS, NOTIFY_MAX_CHARS, ToastKeeper, checkNotifyArgs, handleNotify, type NotifyDeps } from './notify';

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

describe('ToastKeeper: the held toasts stay bounded', () => {
  const toast = () => ({ close: vi.fn() });

  it('keeps at most the cap, closing the oldest ones first (a Windows toast may never emit close)', () => {
    const keeper = new ToastKeeper(3);
    const all = Array.from({ length: 5 }, toast);
    all.forEach((t) => keeper.add(t));
    expect(keeper.size).toBe(3);
    expect(all[0].close).toHaveBeenCalledTimes(1);
    expect(all[1].close).toHaveBeenCalledTimes(1);
    expect(all[2].close).not.toHaveBeenCalled();
    expect(all[4].close).not.toHaveBeenCalled();
  });
  it('the default cap is 10', () => {
    const keeper = new ToastKeeper();
    for (let i = 0; i < 100; i++) keeper.add(toast());
    expect(keeper.size).toBe(MAX_RIG_TOASTS);
    expect(MAX_RIG_TOASTS).toBe(10);
  });
  it('a toast that closed itself is forgotten without being closed again', () => {
    const keeper = new ToastKeeper(3);
    const a = toast();
    keeper.add(a);
    keeper.forget(a);
    expect(keeper.size).toBe(0);
    expect(a.close).not.toHaveBeenCalled();
  });
  it('closeAll (the operator is back at the window) closes and releases every toast', () => {
    const keeper = new ToastKeeper(3);
    const all = [toast(), toast()];
    all.forEach((t) => keeper.add(t));
    keeper.closeAll();
    expect(keeper.size).toBe(0);
    all.forEach((t) => expect(t.close).toHaveBeenCalledTimes(1));
  });
  it('a toast that is already gone does not stop the others closing', () => {
    const keeper = new ToastKeeper(3);
    const gone = { close: vi.fn(() => { throw new Error('Object has been destroyed'); }) };
    const other = toast();
    keeper.add(gone);
    keeper.add(other);
    keeper.closeAll();
    expect(other.close).toHaveBeenCalled();
    expect(keeper.size).toBe(0);
  });
});
