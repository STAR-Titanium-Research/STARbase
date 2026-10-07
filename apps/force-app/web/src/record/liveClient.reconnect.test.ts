import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordClient } from './liveClient';

// Review 2.1: the Record page never reconciled with /record/status, never reopened a dropped
// stream, and RecordClient.stop() swallowed a refused stop.

class FakeWS {
	static all: FakeWS[] = [];
	binaryType = '';
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	closed = false;
	constructor(public url: string) { FakeWS.all.push(this); }
	close() { this.closed = true; }
	open() { this.onopen?.(); }
	drop() { this.onclose?.(); }
}

type Reply = { ok?: boolean; status?: number; body?: unknown; text?: string };
let replies: Record<string, Reply | (() => Reply)>;
const calls: string[] = [];
function reply(path: string, r: Reply | (() => Reply)) { replies[path] = r; }

beforeEach(() => {
	vi.useFakeTimers();
	FakeWS.all = [];
	calls.length = 0;
	replies = {};
	vi.stubGlobal('WebSocket', FakeWS);
	vi.stubGlobal('location', { protocol: 'http:', host: 'x' });
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
		const path = new URL(url, 'http://x').pathname;
		calls.push(`${init?.method ?? 'GET'} ${path}`);
		const r0 = replies[path];
		const r = (typeof r0 === 'function' ? r0() : r0) ?? { ok: false, status: 404 };
		return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body, text: async () => r.text ?? '' };
	}));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const flush = async () => { await vi.advanceTimersByTimeAsync(0); };

describe('RecordClient reconcile with /record/status', () => {
	it('adopts a "done" it missed while the page was away, with the saved summary', async () => {
		reply('/record/status', { body: { state: 'done', id: 'cap-1' } });
		reply('/captures/cap-1/summary', { body: { duration_sec: 8, mat_written: true } });
		const c = new RecordClient();
		c.status.state = 'recording'; c.status.captureId = 'cap-1';
		await c.reconcile();
		expect(c.status.state).toBe('done');
		expect(c.status.summary).toEqual({ duration_sec: 8, mat_written: true });
	});

	it('retries the summary fetch once after a blip', async () => {
		reply('/record/status', { body: { state: 'done', id: 'cap-1' } });
		let n = 0;
		reply('/captures/cap-1/summary', () => (++n === 1 ? { ok: false, status: 503 } : { body: { mat_written: false } }));
		const c = new RecordClient();
		c.status.state = 'recording'; c.status.captureId = 'cap-1';
		await c.reconcile();
		expect(c.status.state).toBe('done');
		expect(c.status.summary).toEqual({ mat_written: false });
	});

	it('adopts a recording it was never told about (page mounted mid-cut)', async () => {
		reply('/record/status', { body: { state: 'recording', id: 'cap-2', n_total: 500, elapsed_sec: 3.5, peaks: { Fx: 1, Fy: 2, Fz: 3 } } });
		const c = new RecordClient();
		await c.reconcile();
		expect(c.status.state).toBe('recording');
		expect(c.status.captureId).toBe('cap-2');
		expect(c.status.tSec).toBe(3.5);
		expect(c.status.peaks.Fz).toBe(3);
	});

	it('turns a cut the recorder no longer knows (restart) into an error instead of "recording" forever', async () => {
		reply('/record/status', { body: { state: 'idle' } });
		const c = new RecordClient();
		c.status.state = 'recording'; c.status.captureId = 'cap-3';
		await c.reconcile();
		expect(c.status.state).toBe('error');
		expect(c.status.error).toMatch(/restarted/);
	});

	it('does not resurrect a finished run the operator already dismissed', async () => {
		reply('/record/status', { body: { state: 'done', id: 'cap-4' } });
		const c = new RecordClient();   // idle, as after newRun()
		await c.reconcile();
		expect(c.status.state).toBe('idle');
	});

	it('is off while canReconcile says so (playback drives the status itself)', async () => {
		reply('/record/status', { body: { state: 'idle' } });
		const c = new RecordClient();
		c.canReconcile = () => false;
		c.status.state = 'recording';
		await c.reconcile();
		expect(c.status.state).toBe('recording');
		expect(calls).toEqual([]);
	});

	it('drops an answer that arrives after local state moved on', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		vi.stubGlobal('fetch', vi.fn(async () => { await gate; return { ok: true, status: 200, json: async () => ({ state: 'idle' }) }; }));
		const c = new RecordClient();
		c.status.state = 'recording'; c.status.captureId = 'cap-5';
		const p = c.reconcile();
		c.status.state = 'finalizing';   // the stream delivered a transition meanwhile
		release(); await p;
		expect(c.status.state).toBe('finalizing');
	});

	it('keeps the old state when the recorder cannot be reached', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
		const c = new RecordClient();
		c.status.state = 'recording';
		await c.reconcile();
		expect(c.status.state).toBe('recording');
	});
});

describe('RecordClient stream reconnect', () => {
	it('reconciles on every open and runs onStreamOpen afterwards', async () => {
		reply('/record/status', { body: { state: 'idle' } });
		const c = new RecordClient();
		const opened = vi.fn();
		c.onStreamOpen = opened;
		c.connect();
		FakeWS.all[0].open();
		await flush();
		expect(c.status.connected).toBe(true);
		expect(calls).toContain('GET /record/status');
		expect(opened).toHaveBeenCalledTimes(1);
		c.disconnect();
	});

	it('reopens the stream with backoff after it closes, and the recovery hook reruns', async () => {
		reply('/record/status', { body: { state: 'idle' } });
		const c = new RecordClient();
		const opened = vi.fn();
		c.onStreamOpen = opened;
		c.connect();
		FakeWS.all[0].open(); await flush();
		FakeWS.all[0].drop();
		expect(c.status.connected).toBe(false);
		expect(FakeWS.all).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(499);
		expect(FakeWS.all).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(FakeWS.all).toHaveLength(2);
		// the second attempt fails to open: the next delay doubles
		FakeWS.all[1].drop();
		await vi.advanceTimersByTimeAsync(999);
		expect(FakeWS.all).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(FakeWS.all).toHaveLength(3);
		FakeWS.all[2].open(); await flush();
		expect(c.status.connected).toBe(true);
		expect(opened).toHaveBeenCalledTimes(2);
		c.disconnect();
	});

	it('stops reconnecting once disconnected (page left)', async () => {
		const c = new RecordClient();
		c.connect();
		FakeWS.all[0].drop();           // a retry is now pending
		c.disconnect();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(FakeWS.all).toHaveLength(1);
	});

	it('disconnect closes a live socket and does not reconnect when it then closes', async () => {
		const c = new RecordClient();
		c.connect();
		const ws = FakeWS.all[0];
		c.disconnect();
		expect(ws.closed).toBe(true);
		ws.drop();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(FakeWS.all).toHaveLength(1);
	});

	it('ignores the close of a socket that was already replaced', async () => {
		const c = new RecordClient();
		c.connect();
		const first = FakeWS.all[0];
		c.disconnect();
		c.connect();
		first.drop();                    // late close event of the old socket
		FakeWS.all[1].open();
		expect(c.status.connected).toBe(true);
		c.disconnect();
	});

	it('backoff is capped', () => {
		expect(RecordClient.reconnectDelayMs(0)).toBe(500);
		expect(RecordClient.reconnectDelayMs(20)).toBe(10_000);
	});
});

describe('RecordClient.stop()', () => {
	it('throws on a non-ok answer (409: nothing is recording) and leaves the state alone', async () => {
		reply('/record/stop', { ok: false, status: 409, text: '{"detail":"not recording"}' });
		const c = new RecordClient();
		c.status.state = 'recording';
		await expect(c.stop()).rejects.toThrow(/409/);
		expect(c.status.state).toBe('recording');
	});

	it('takes the state from an ok answer', async () => {
		reply('/record/stop', { body: { state: 'finalizing', id: 'cap-9' } });
		const c = new RecordClient();
		await c.stop();
		expect(c.status.state).toBe('finalizing');
		expect(c.status.captureId).toBe('cap-9');
	});
});

describe('reconcile relays what it adopts to pop-outs', () => {
	// A pop-out has its own RecordClient and only hears what the opener relays.
	function withPopout() {
		const opener = new RecordClient();
		const popout = new RecordClient();
		const sent: unknown[] = [];
		(opener as any).relay = { postMessage: (m: unknown) => { sent.push(m); }, close() {} };
		opener.onPeerMessage({ type: 'sync-request', id: 'p1', retainSec: 60 });
		sent.length = 0;
		(popout as any).relay = { postMessage() {}, close() {} };
		const deliver = () => {
			for (const m of sent as any[]) {
				if (m?.txt) (popout as any).onControl(JSON.parse(m.txt));
				else if (m?.type === 'snapshot') popout.applySnapshot(structuredClone(m));
			}
		};
		return { opener, popout, sent, deliver };
	}

	it('a done adopted from /record/status reaches the pop-out with its summary', async () => {
		reply('/record/status', { body: { state: 'done', id: 'cap-1' } });
		reply('/captures/cap-1/summary', { body: { mat_written: true } });
		const { opener, popout, deliver } = withPopout();
		opener.status.state = 'recording'; opener.status.captureId = 'cap-1';
		popout.status.state = 'recording'; popout.status.captureId = 'cap-1';
		await opener.reconcile();
		deliver();
		expect(popout.status.state).toBe('done');
		expect(popout.status.summary).toEqual({ mat_written: true });
	});

	it('a recorder restart (error) reaches the pop-out', async () => {
		reply('/record/status', { body: { state: 'idle' } });
		const { opener, popout, deliver } = withPopout();
		opener.status.state = 'recording'; opener.status.captureId = 'cap-3';
		popout.status.state = 'recording'; popout.status.captureId = 'cap-3';
		await opener.reconcile();
		deliver();
		expect(popout.status.state).toBe('error');
		expect(popout.status.error).toMatch(/restarted/);
	});

	it('a recording adopted onto an idle client reaches the pop-out', async () => {
		reply('/record/status', { body: { state: 'finalizing', id: 'cap-2', n_total: 5 } });
		const { opener, popout, deliver } = withPopout();
		await opener.reconcile();
		deliver();
		expect(popout.status.state).toBe('finalizing');
		expect(popout.status.captureId).toBe('cap-2');
	});

	it('relays nothing when no pop-out is listening', async () => {
		reply('/record/status', { body: { state: 'idle' } });
		const opener = new RecordClient();
		const post = vi.fn();
		(opener as any).relay = { postMessage: post, close() {} };
		opener.status.state = 'recording';
		await opener.reconcile();
		expect(post).not.toHaveBeenCalled();
	});
});
