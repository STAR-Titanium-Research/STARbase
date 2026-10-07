import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordClient } from './liveClient';
import { createPlaybackEngine } from './playback/engine';
import type { Cache } from '@d1/force-plotting';

// Relay snapshots to pop-out windows (#107): after the first full one, playback sends DELTAS, and
// a pop-out applying them must end up holding exactly what the opener holds.

function makeCache(n = 4000, fs = 400): Cache {
	const t = new Float32Array(n), Fx = new Float32Array(n), Fy = new Float32Array(n);
	const Fz = new Float32Array(n), rpm = new Float32Array(n), revs = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		t[i] = i / fs; Fx[i] = Math.sin(i / 9) * 50; Fy[i] = -Fx[i]; Fz[i] = Math.cos(i / 13) * 80;
		rpm[i] = 600; revs[i] = 10 * (i / fs);
	}
	return { N: n, Fs: fs, feed: 0.1, diam: 80, csSec: 0, ceSec: (n - 1) / fs, t, Fx, Fy, Fz, rpm, revs };
}

function setup() {
	const parent = new RecordClient();
	const engine = createPlaybackEngine(parent, { baseUrl: 'http://x', now: () => 0, schedule: () => 0, cancel: () => {} });
	engine.load(makeCache(), { ppr: 1, stride: 1 });
	const child = new RecordClient();
	const relay = (full = false) => {
		const snap = parent.buildSnapshot(full);
		// postMessage structured-clones; so does this, so nothing is shared by reference.
		child.applySnapshot(structuredClone(snap));
		return snap;
	};
	return { parent, engine, child, relay };
}

function expectSame(a: RecordClient, b: RecordClient) {
	expect(b.frm.count).toBe(a.frm.count);
	expect(Array.from(b.frm.xy.subarray(0, b.frm.count * 2))).toEqual(Array.from(a.frm.xy.subarray(0, a.frm.count * 2)));
	expect(Array.from(b.frm.cz.subarray(0, b.frm.count))).toEqual(Array.from(a.frm.cz.subarray(0, a.frm.count)));
	expect(b.trace.t).toEqual(a.trace.t);
	expect(b.trace.fz).toEqual(a.trace.fz);
	expect(b.trace.sub.Fz3).toEqual(a.trace.sub.Fz3);
	expect(b.fftHistory.map((e) => e.t)).toEqual(a.fftHistory.map((e) => e.t));
}

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ fs: 100, f: [], spectra: {} }) }) as any)); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('relay snapshots (#107)', () => {
	it('sends a full snapshot first, then only what was appended', () => {
		const { parent, engine, child, relay } = setup();
		engine.seek(2);
		expect(relay(true).full).toBe(true);
		const before = parent.frm.count;
		const lastT = parent.trace.t[parent.trace.t.length - 1];
		engine.seek(3);
		parent.pushFft('Fz', [1], 100, { Fz: [1] }, 3);
		const d = relay();
		expect(d.full).toBe(false);
		expect(d.frm.from).toBe(before);
		expect(d.frm.xy.length).toBe((parent.frm.count - before) * 2);
		expect(d.trace.t.length).toBeGreaterThan(0);
		expect(d.trace.t.every((t) => t > lastT)).toBe(true);
		expect(d.fftHistory.length).toBe(1);
		expectSame(parent, child);
	});

	it('a delta with nothing new carries no bulk data', () => {
		const { engine, relay } = setup();
		engine.seek(2);
		relay(true);
		const d = relay();
		expect(d.full).toBe(false);
		expect(d.frm.xy.length).toBe(0);
		expect(d.trace.t.length).toBe(0);
		expect(d.fftHistory.length).toBe(0);
	});

	it('sends a full snapshot after a backward seek, and the pop-out follows it', () => {
		const { parent, engine, child, relay } = setup();
		engine.seek(6);
		relay(true);
		engine.seek(2);
		expect(relay().full).toBe(true);
		expectSame(parent, child);
		engine.seek(4);
		expect(relay().full).toBe(false);
		expectSame(parent, child);
	});

	it('sends a full snapshot after the trace was rebuilt for a wider window', () => {
		const { parent, engine, child, relay } = setup();
		parent.retainFloorSec = 1;
		engine.seek(8);
		relay(true);
		parent.setWindowDemand('panel', 5);
		expect(relay().full).toBe(true);
		expectSame(parent, child);
	});

	it('clears the pop-out spiral when the opener reset (a full snapshot of nothing)', () => {
		const { parent, engine, child, relay } = setup();
		engine.seek(5);
		relay(true);
		expect(child.frm.count).toBeGreaterThan(0);
		parent.reset();
		relay();
		expect(child.frm.count).toBe(0);
	});

	it('a pop-out does not apply a delta that does not line up with what it holds', () => {
		const { parent, engine, child } = setup();
		engine.seek(2);
		parent.buildSnapshot(true);            // a full snapshot this pop-out never received
		engine.seek(3);
		child.applySnapshot(structuredClone(parent.buildSnapshot(false)));
		expect(child.frm.count).toBe(0);       // ignored (and a resync requested) rather than misplaced
	});
});

describe('opener handling of pop-out messages (#107)', () => {
	function opener() {
		const { parent, engine } = setup();
		const posted: any[] = [];
		(parent as any).relay = { postMessage: (m: any) => posted.push(m), close() {} };
		const snaps = () => posted.filter((m) => m.type === 'snapshot');
		return { parent, engine, posted, snaps };
	}

	it('answers a sync-request with a full snapshot', () => {
		const { parent, snaps } = opener();
		parent.onPeerMessage({ type: 'sync-request', id: 'a' });
		expect(snaps().map((s) => s.full)).toEqual([true]);
	});

	it('resyncs a heartbeat from a peer it does not know, but not from one it does', () => {
		const { parent, snaps } = opener();
		parent.onPeerMessage({ type: 'heartbeat', id: 'a' });          // opener reloaded / peer expired
		expect(snaps().map((s) => s.full)).toEqual([true]);
		parent.onPeerMessage({ type: 'heartbeat', id: 'a' });
		expect(snaps()).toHaveLength(1);
		parent.onPeerMessage({ type: 'bye', id: 'a' });
		parent.onPeerMessage({ type: 'heartbeat', id: 'a' });          // bfcache restore after a bye
		expect(snaps().map((s) => s.full)).toEqual([true, true]);
	});
});

describe('pop-out history demand (#107)', () => {
	it('drops the demand of a pop-out that expired without saying bye', () => {
		vi.useFakeTimers();
		try {
			const { parent } = setup();
			parent.retainFloorSec = 1;
			parent.onPeerMessage({ type: 'heartbeat', id: 'a', retainSec: 200 });
			expect(parent.retainSec).toBe(200);
			vi.advanceTimersByTime(10_000);
			void (parent as any).hasRelayPeer;                   // the opener's next frame or tick checks liveness
			expect(parent.retainSec).toBe(1);
		} finally { vi.useRealTimers(); }
	});
});

describe('relayTick throttle (#107)', () => {
	it('sends at most one snapshot per interval, and a trailing one so the last state is not lost', () => {
		vi.useFakeTimers();
		try {
			const { parent, engine } = setup();
			const posted: any[] = [];
			(parent as any).relay = { postMessage: (m: any) => posted.push(m), close() {} };
			parent.onPeerMessage({ type: 'sync-request', id: 'a' });
			posted.length = 0;
			vi.advanceTimersByTime(1000);
			parent.onPeerMessage({ type: 'heartbeat', id: 'a' });
			engine.seek(2);                       // leading: sent now
			expect(posted).toHaveLength(1);
			engine.seek(4);                       // inside the interval: held back
			expect(posted).toHaveLength(1);
			parent.onPeerMessage({ type: 'heartbeat', id: 'a' });
			vi.advanceTimersByTime(250);
			expect(posted).toHaveLength(2);       // trailing: the state the scrub ended on
			expect(posted[1].frm.count).toBe(parent.frm.count);
			vi.advanceTimersByTime(1000);
			expect(posted).toHaveLength(2);       // nothing pending, nothing more sent
		} finally { vi.useRealTimers(); }
	});

	it('does not send a trailing snapshot after the pop-out is gone', () => {
		vi.useFakeTimers();
		try {
			const { parent, engine } = setup();
			const posted: any[] = [];
			(parent as any).relay = { postMessage: (m: any) => posted.push(m), close() {} };
			parent.onPeerMessage({ type: 'sync-request', id: 'a' });
			posted.length = 0;
			vi.advanceTimersByTime(1000);
			parent.onPeerMessage({ type: 'heartbeat', id: 'a' });
			engine.seek(2); engine.seek(4);
			parent.onPeerMessage({ type: 'bye', id: 'a' });
			vi.advanceTimersByTime(500);
			expect(posted).toHaveLength(1);
		} finally { vi.useRealTimers(); }
	});
});
