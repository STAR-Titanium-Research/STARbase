import { describe, expect, it, vi } from 'vitest';
import { confirmQuit, fetchBusySession, fetchRecorderActivity, quitDialogOptions } from './quitGuard';

const status = (body: unknown, ok = true) => async () => ({ ok, json: async () => body }) as unknown as Response;

describe('fetchBusySession', () => {
  it('reports a recording', async () => {
    const b = await fetchBusySession(status({ state: 'recording', elapsed_sec: 75, n_total: 1000, config: { sample_name: 'S-1' } }));
    expect(b).toEqual({ kind: 'recording', sample: 'S-1', elapsed: 75, samples: 1000 });
  });

  it('treats finalizing as busy (review 2.3: quitting then leaves capture.mat/summary.json unwritten)', async () => {
    const b = await fetchBusySession(status({ state: 'finalizing', elapsed_sec: 8, n_total: 200000 }));
    expect(b?.kind).toBe('finalizing');
    expect(b?.sample).toBe('the current run');
  });

  it.each(['idle', 'done', 'error'])('is not busy when the state is %s', async (state) => {
    expect(await fetchBusySession(status({ state }))).toBeNull();
  });

  it('fails open when the backend cannot be asked', async () => {
    expect(await fetchBusySession(async () => { throw new Error('ECONNREFUSED'); })).toBeNull();
    expect(await fetchBusySession(async () => null)).toBeNull();
    expect(await fetchBusySession(status({}, false))).toBeNull();
  });
});

describe('fetchRecorderActivity', () => {
  it('tells idle apart from "could not ask"', async () => {
    expect(await fetchRecorderActivity(status({ state: 'idle' }))).toEqual({ status: 'idle' });
    expect(await fetchRecorderActivity(async () => { throw new Error('timeout'); })).toEqual({ status: 'unknown' });
    expect(await fetchRecorderActivity(async () => null)).toEqual({ status: 'unknown' });
    expect(await fetchRecorderActivity(status({}, false))).toEqual({ status: 'unknown' });
  });
  it('reports a busy session', async () => {
    const a = await fetchRecorderActivity(status({ state: 'recording', elapsed_sec: 5, n_total: 9, config: { sample_name: 'S-2' } }));
    expect(a).toEqual({ status: 'busy', session: { kind: 'recording', sample: 'S-2', elapsed: 5, samples: 9 } });
  });
});

describe('quit dialog', () => {
  it('says the recording is being saved while finalizing, with wait / quit anyway', () => {
    const o = quitDialogOptions({ kind: 'finalizing', sample: 'S-1', elapsed: 8, samples: 5 });
    expect(o.buttons).toEqual(['Wait for it to finish', 'Quit anyway']);
    expect(o.message).toMatch(/being saved/);
    expect(o.defaultId).toBe(0);
  });

  it('keeps the existing wording while recording', () => {
    const o = quitDialogOptions({ kind: 'recording', sample: 'S-1', elapsed: 75, samples: 5 });
    expect(o.buttons).toEqual(['Keep recording', 'Stop recording and quit']);
    expect(o.detail).toContain('1:15 elapsed');
  });
});

describe('confirmQuit', () => {
  const busy = { kind: 'finalizing' as const, sample: 'S', elapsed: 1, samples: 1 };

  it('quits without asking when nothing is running', async () => {
    const show = vi.fn();
    expect(await confirmQuit({ getBusy: async () => null, showMessageBox: show })).toBe(true);
    expect(show).not.toHaveBeenCalled();
  });

  it('asks while finalizing: waiting keeps the app open, quit anyway proceeds', async () => {
    const wait = vi.fn(async () => ({ response: 0 }));
    expect(await confirmQuit({ getBusy: async () => busy, showMessageBox: wait })).toBe(false);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(await confirmQuit({ getBusy: async () => busy, showMessageBox: async () => ({ response: 1 }) })).toBe(true);
  });
});
