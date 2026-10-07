import { describe, expect, it, vi } from 'vitest';
import { restartBridge, runRestart } from './recorderRestart';

describe('restartBridge', () => {
	it('is undefined in a browser or dev build (no window.forceApp)', () => {
		expect(restartBridge({})).toBeUndefined();
		expect(restartBridge(undefined)).toBeUndefined();
	});
	it('is undefined for an older shell without restartRecorder', () => {
		expect(restartBridge({ forceApp: {} })).toBeUndefined();
	});
	it('returns the bridge inside the Electron shell', () => {
		const forceApp = { restartRecorder: vi.fn() };
		expect(restartBridge({ forceApp })).toBe(forceApp);
	});
});

describe('runRestart', () => {
	it('reports success', async () => {
		expect(await runRestart({ restartRecorder: async () => ({ ok: true }) })).toEqual({ ok: true, message: '' });
	});
	it('passes on the refusal reason (a recording is running)', async () => {
		const r = await runRestart({ restartRecorder: async () => ({ ok: false, reason: 'A recording is in progress' }) });
		expect(r).toEqual({ ok: false, message: 'A recording is in progress' });
	});
	it('has a fallback message when no reason is given', async () => {
		expect((await runRestart({ restartRecorder: async () => ({ ok: false }) })).message).toMatch(/did not restart/);
	});
	it('turns a rejected IPC call into a message', async () => {
		const r = await runRestart({ restartRecorder: async () => { throw new Error('ipc gone'); } });
		expect(r).toEqual({ ok: false, message: 'ipc gone' });
	});
});
