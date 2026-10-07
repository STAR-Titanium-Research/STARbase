import { describe, expect, it, vi } from 'vitest';
import { isCrashRecovery, restartDecision, restartRecorder, unknownStatusDialog, type RestartDeps } from './restart';
import type { BusySession, RecorderActivity } from './quitGuard';
import type { SidecarState } from './sidecar';

const recording: BusySession = { kind: 'recording', sample: 'S-1', elapsed: 30, samples: 100 };
const finalizing: BusySession = { kind: 'finalizing', sample: 'S-1', elapsed: 30, samples: 100 };
const busy = (session: BusySession): RecorderActivity => ({ status: 'busy', session });
const idle: RecorderActivity = { status: 'idle' };
const unknown: RecorderActivity = { status: 'unknown' };
const states: SidecarState[] = ['starting', 'ready', 'restarting', 'crashed', 'stopped'];

describe('restartDecision', () => {
  it.each(states)('restarts an idle recorder (supervisor %s)', (state) => {
    expect(restartDecision(idle, state)).toEqual({ action: 'restart' });
  });
  it.each(states)('refuses while recording, naming the sample (supervisor %s)', (state) => {
    const r = restartDecision(busy(recording), state);
    expect(r.action).toBe('refuse');
    if (r.action === 'refuse') {
      expect(r.reason).toContain('S-1');
      expect(r.reason).toContain('in progress');
    }
  });
  it('refuses while finalizing', () => {
    const r = restartDecision(busy(finalizing), 'ready');
    expect(r.action).toBe('refuse');
    if (r.action === 'refuse') expect(r.reason).toContain('being saved');
  });
  it('asks first when the status is unknown but the supervisor thinks the backend is ready', () => {
    expect(restartDecision(unknown, 'ready')).toEqual({ action: 'confirm' });
  });
  it.each(states.filter((s) => s !== 'ready'))('restarts without asking when the status is unknown and the supervisor is %s', (state) => {
    expect(restartDecision(unknown, state)).toEqual({ action: 'restart' });
  });
  it('restarts without asking when there is no supervisor state', () => {
    expect(restartDecision(unknown, undefined)).toEqual({ action: 'restart' });
  });
});

describe('isCrashRecovery', () => {
  it('is a recovery when the backend comes back after an automatic restart', () => {
    expect(isCrashRecovery('ready', 1, false)).toBe(true);
  });
  it('is not one for the first start or for states other than ready', () => {
    expect(isCrashRecovery('ready', 0, false)).toBe(false);
    expect(isCrashRecovery('restarting', 1, false)).toBe(false);
    expect(isCrashRecovery('starting', 1, false)).toBe(false);
  });
  it('is not one while a manual restart is under way, even if its first spawn failed to bind', () => {
    expect(isCrashRecovery('ready', 1, true)).toBe(false);
  });
});

describe('unknownStatusDialog', () => {
  it('defaults and cancels to "Don\'t restart"', () => {
    const o = unknownStatusDialog();
    expect(o.buttons?.[o.defaultId ?? -1]).toBe("Don't restart");
    expect(o.buttons?.[o.cancelId ?? -1]).toBe("Don't restart");
    expect(o.buttons).toContain('Restart anyway');
    expect(o.message).toContain('a recording may be in progress');
  });
});

function deps(over: Partial<RestartDeps> = {}): RestartDeps {
  return {
    getActivity: async () => idle,
    confirmUnknown: vi.fn(async () => true),
    restart: vi.fn(async () => {}),
    getState: () => 'ready',
    lastDetail: () => undefined,
    ...over,
  };
}

describe('restartRecorder', () => {
  it('restarts and reports ok once the supervisor is ready', async () => {
    const d = deps();
    expect(await restartRecorder(d)).toEqual({ ok: true });
    expect(d.restart).toHaveBeenCalledOnce();
    expect(d.confirmUnknown).not.toHaveBeenCalled();
  });
  it('does not restart while recording', async () => {
    const d = deps({ getActivity: async () => busy(recording) });
    const r = await restartRecorder(d);
    expect(r.ok).toBe(false);
    expect(d.restart).not.toHaveBeenCalled();
    expect(d.confirmUnknown).not.toHaveBeenCalled();
  });
  it('asks when the backend does not answer but looks ready, and restarts on yes', async () => {
    const d = deps({ getActivity: async () => unknown });
    expect(await restartRecorder(d)).toEqual({ ok: true });
    expect(d.confirmUnknown).toHaveBeenCalledOnce();
    expect(d.restart).toHaveBeenCalledOnce();
  });
  it('leaves the recorder alone when the operator says no', async () => {
    const d = deps({ getActivity: async () => unknown, confirmUnknown: vi.fn(async () => false) });
    const r = await restartRecorder(d);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not restarted');
    expect(d.restart).not.toHaveBeenCalled();
  });
  it('checks again after the operator confirms and refuses if a recording started meanwhile', async () => {
    const answers: RecorderActivity[] = [unknown, busy(recording)];
    const d = deps({ getActivity: async () => answers.shift() ?? idle });
    const r = await restartRecorder(d);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('in progress');
    expect(d.confirmUnknown).toHaveBeenCalledOnce();
    expect(d.restart).not.toHaveBeenCalled();
  });
  it('still restarts after the confirmation when the second check is idle or unknown again', async () => {
    for (const second of [idle, unknown]) {
      const answers: RecorderActivity[] = [unknown, second];
      const d = deps({ getActivity: async () => answers.shift() ?? idle });
      expect(await restartRecorder(d)).toEqual({ ok: true });
      expect(d.restart).toHaveBeenCalledOnce();
    }
  });
  it('does not re-check when no confirmation was needed', async () => {
    const getActivity = vi.fn(async () => idle);
    await restartRecorder(deps({ getActivity }));
    expect(getActivity).toHaveBeenCalledOnce();
  });
  it('restarts without asking when the supervisor already knows the backend is down', async () => {
    let state: SidecarState = 'crashed';
    const d = deps({
      getActivity: async () => unknown,
      getState: () => state,
      restart: vi.fn(async () => { state = 'ready'; }),
    });
    expect(await restartRecorder(d)).toEqual({ ok: true });
    expect(d.confirmUnknown).not.toHaveBeenCalled();
    expect(d.restart).toHaveBeenCalledOnce();
  });
  it('reports the supervisor detail when the backend does not come back', async () => {
    const r = await restartRecorder(deps({ getState: () => 'crashed', lastDetail: () => 'boom' }));
    expect(r).toEqual({ ok: false, reason: 'boom' });
  });
  it('reports a thrown error instead of throwing', async () => {
    const r = await restartRecorder(deps({ restart: async () => { throw new Error('nope'); } }));
    expect(r).toEqual({ ok: false, reason: 'nope' });
  });
  it('says so when there is no supervisor', async () => {
    const r = await restartRecorder(deps({ restart: null }));
    expect(r.ok).toBe(false);
  });
});
