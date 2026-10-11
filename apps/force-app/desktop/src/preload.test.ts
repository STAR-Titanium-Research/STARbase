import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Review 2.10: onUpdateStatus / onNavigate must hand back an unsubscribe function.

const h = vi.hoisted(() => ({ bus: new (require('node:events').EventEmitter)() as any, exposed: null as any }));
vi.mock('electron', () => {
  const bus = h.bus;
  return {
    contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { h.exposed = api; } },
    ipcRenderer: {
      on: (ch: string, fn: (...a: unknown[]) => void) => bus.on(ch, fn),
      removeListener: (ch: string, fn: (...a: unknown[]) => void) => bus.removeListener(ch, fn),
      invoke: vi.fn(),
    },
  };
});

beforeEach(async () => {
  vi.resetModules();
  (h.bus as EventEmitter).removeAllListeners();
  await import('./preload');
});

describe('preload subscriptions', () => {
  it('onUpdateStatus delivers statuses until unsubscribed, then removes its listener', () => {
    const got: unknown[] = [];
    const off = h.exposed.onUpdateStatus((s: unknown) => got.push(s));
    expect(typeof off).toBe('function');
    h.bus.emit('update:status', {}, { state: 'checking' });
    off();
    h.bus.emit('update:status', {}, { state: 'idle' });
    expect(got).toEqual([{ state: 'checking' }]);
    expect(h.bus.listenerCount('update:status')).toBe(0);
  });

  it('repeated subscribe/unsubscribe (visiting About again and again) does not accumulate listeners', () => {
    for (let i = 0; i < 5; i++) h.exposed.onUpdateStatus(() => {})();
    expect(h.bus.listenerCount('update:status')).toBe(0);
  });

  it('onNavigate returns a working disposer too', () => {
    const got: string[] = [];
    const off = h.exposed.onNavigate((p: string) => got.push(p));
    h.bus.emit('navigate', {}, '/record');
    off();
    h.bus.emit('navigate', {}, '/plot');
    expect(got).toEqual(['/record']);
  });

  it('restartRecorder invokes the sidecar:restart channel', async () => {
    const { ipcRenderer } = await import('electron');
    (ipcRenderer.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    await expect(h.exposed.restartRecorder()).resolves.toEqual({ ok: true });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('sidecar:restart');
  });
});

describe('update-notify bridge (#197)', () => {
  it('get/set go through the updateNotify channels', async () => {
    const { ipcRenderer } = await import('electron');
    const invoke = ipcRenderer.invoke as ReturnType<typeof vi.fn>;
    invoke.mockResolvedValueOnce({ supported: true, enabled: true, active: true });
    await expect(h.exposed.getUpdateNotifyWhenClosed()).resolves.toEqual({ supported: true, enabled: true, active: true });
    expect(invoke).toHaveBeenCalledWith('updateNotify:get');
    invoke.mockResolvedValueOnce({ ok: true, enabled: false });
    await h.exposed.setUpdateNotifyWhenClosed(false);
    expect(invoke).toHaveBeenCalledWith('updateNotify:set', false);
  });
});

describe('rig-test notify bridge', () => {
  it('invokes notify:show with the two strings and hands back the shell\'s answer', async () => {
    const { ipcRenderer } = await import('electron');
    const invoke = ipcRenderer.invoke as ReturnType<typeof vi.fn>;
    invoke.mockResolvedValueOnce({ ok: true });
    await expect(h.exposed.notify('Rig test #5 needs you', 'Did the chip warn?')).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith('notify:show', 'Rig test #5 needs you', 'Did the chip warn?');
  });

  it('exposes nothing beyond the call itself (no way to read or hold a notification)', () => {
    expect(typeof h.exposed.notify).toBe('function');
    expect(h.exposed.notify.length).toBe(2);
  });
});
