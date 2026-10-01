import { beforeEach, describe, expect, it, vi } from 'vitest';

const LS_KEY = 'force-app.recording.prefs';

// vitest's default (node) test environment has no localStorage global at all — alarms.ts's own
// tests never notice because its loadCfg() wraps the call in try/catch and silently falls back to
// defaults, but this file asserts on persistence directly, so it needs a real (if minimal) store.
function makeLocalStorageStub() {
	let store: Record<string, string> = {};
	return {
		getItem: (k: string) => (k in store ? store[k] : null),
		setItem: (k: string, v: string) => { store[k] = v; },
		removeItem: (k: string) => { delete store[k]; },
		clear: () => { store = {}; },
	};
}

// Fresh module instance per test — the singleton would otherwise carry state (and its watcher)
// across tests, since it's created once at import time.
async function freshPrefs() {
	vi.resetModules();
	return import('./recordingPrefs');
}

describe('recordingPrefs', () => {
	beforeEach(() => { (globalThis as any).localStorage = makeLocalStorageStub(); });

	it('defaults to everything off / adaptive when nothing is stored', async () => {
		const { recordingPrefs } = await freshPrefs();
		expect(recordingPrefs.frmFromCut).toBe(false);
		expect(recordingPrefs.driftComp).toBe(false);
		expect(recordingPrefs.convergeEnabled).toBe(false);
		expect(recordingPrefs.cutDetectForce).toBe(0);
	});

	it('loads previously saved values', async () => {
		localStorage.setItem(LS_KEY, JSON.stringify({ frmFromCut: true, cutDetectForce: 25 }));
		const { recordingPrefs } = await freshPrefs();
		expect(recordingPrefs.frmFromCut).toBe(true);
		expect(recordingPrefs.cutDetectForce).toBe(25);
		expect(recordingPrefs.driftComp).toBe(false); // defaults fill in whatever wasn't stored
	});

	it('persists a change automatically, from either surface that edits it', async () => {
		// Regression-shaped: this object is mutated from BOTH the Record page's toggle switches and
		// Settings > Recording. A manual save-button pattern (like alarms.ts's) would mean forgetting
		// it in one of the two places silently drops the other's edits on next launch — so this must
		// persist on every change with no explicit save call required.
		const { recordingPrefs } = await freshPrefs();
		recordingPrefs.cutDetectForce = 40;
		await new Promise((r) => setTimeout(r, 0)); // the watcher is not synchronous
		expect(JSON.parse(localStorage.getItem(LS_KEY)!).cutDetectForce).toBe(40);
	});

	it('survives corrupt stored JSON by falling back to defaults', async () => {
		localStorage.setItem(LS_KEY, '{not json');
		const { recordingPrefs } = await freshPrefs();
		expect(recordingPrefs.frmFromCut).toBe(false);
	});
});
