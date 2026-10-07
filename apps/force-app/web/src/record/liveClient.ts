// Live recording client: opens the recorder WebSocket, decodes D1LF binary frames, and keeps
// rolling buffers the live widgets draw from. Scalars are reactive (readouts); the bulk trace/FRM
// buffers are plain arrays (redrawn each animation frame) to avoid per-sample reactivity overhead.
import { reactive, ref } from 'vue';
import { getConfig } from '../config';
import { authHeaders } from '../directusClient';
import type { RecordConfig } from './types';
import { firstAtOrAfter, WINDOW_MAX_SEC, WINDOW_SLIDER_MAX_SEC } from './plotWindow';
import { RELAY_HEARTBEAT_MS, RelayPeers } from './relayPeers';
import { createEmitThrottle } from './emitThrottle';
import { parseStartError } from './recordingErrors';
import type { TachoKind } from './tachoSignal';
import { parseRailed } from './railing';

// Playback relays to pop-outs at most this often (see relayTick).
const RELAY_TICK_MS = 200;

const STREAM_ERROR = 'stream connection error';
const MAGIC = 0x46_4c_31_44; // 'D1LF' bytes D,1,L,F read little-endian as a u32
// The 8 dyno sub-channels the frame streams (min/max envelope), in raw-file column order.
export const SUB_NAMES = ['Fx1', 'Fx2', 'Fy1', 'Fy2', 'Fz1', 'Fz2', 'Fz3', 'Fz4', 'Tacho'] as const;
export type SubName = (typeof SUB_NAMES)[number];

// Raw-file geometry, for size/bandwidth estimates. The writer emits float32 rows (d1rw.py dtype
// "<f4"; recovery.py reads row_bytes = n_cols * 4) of Time + 8 dyno channels + Tacho. Keep these
// in step with backend/app/storage.py's RAW_BYTES_PER_SAMPLE — guessing float64 here silently
// doubled every size readout and disk-space warning.
export const RAW_BYTES_PER_SAMPLE = 4;
export const RAW_COLUMNS = 10;
type Env = [number, number][];
function emptyTrace() {
	const sub: Record<string, Env> = {};
	for (const n of SUB_NAMES) sub[n] = [];
	return { t: [] as number[], fx: [] as Env, fy: [] as Env, fz: [] as Env, sub };
}

export interface LiveStatus {
	connected: boolean;
	state: 'idle' | 'recording' | 'finalizing' | 'done' | 'error';
	seq: number;
	tSec: number;
	rpm: number;
	/** null until the first chunk is processed; false => tacho not producing readable pulses. */
	tachoOk: boolean | null;
	/**
	 * What the Tacho channel in `trace.sub` holds: the raw pulse train of a live recording
	 * ('signal'), the stored RPM series of a replayed cut ('rpm'), or nothing because the replayed
	 * cache has none ('none'). See tachoSignal.ts.
	 */
	tachoKind: TachoKind;
	peaks: { Fx: number; Fy: number; Fz: number };
	nTotal: number;
	error: string | null;
	/** Which stage failed when state is 'error' — 'start' | 'acquisition' | 'finalize' (#84). */
	errorKind: string | null;
	captureId: string | null;
	summary: any | null;
	cutStartSec: number | null;   // detected cut start (2f) — null until the cut begins
	diskAction: { action: 'backup_started' | 'backup_unavailable' | 'forced_stop'; freeGb: number } | null;
	/** Sensor channels (0-7 = Fx1..Fz4, see railing.ts) that reached full scale this cut. Latched
	 *  by the backend per cut, cleared by reset(). Always empty without per-channel gains. */
	railed: number[];
}

export class RecordClient {
	status = reactive<LiveStatus>({
		connected: false, state: 'idle', seq: 0, tSec: 0, rpm: 0, tachoOk: null, tachoKind: 'signal',
		peaks: { Fx: 0, Fy: 0, Fz: 0 }, nTotal: 0, error: null, errorKind: null, captureId: null, summary: null, cutStartSec: null,
		diskAction: null, railed: [],
	});
	// bump each frame so widgets can watch cheaply
	frameSeq = ref(0);
	// latest live spectra (published a few times a second by the backend); fftSeq bumps on update.
	// `spectra` holds an amplitude spectrum per channel (Fx/Fy/Fz + the 8 dyno subs); `axis` stays
	// for the single-axis fallback. `fftHistory` is a rolling stack of recent spectra frames the
	// spectrogram/waterfall views draw from (accumulated client-side; only current frames cross).
	fft: { axis: string; f: number[]; fs: number; spectra: Record<string, number[]> } | null = null;
	fftHistory: { t: number; spectra: Record<string, number[]> }[] = [];
	fftHistCap = 220;
	fftSeq = ref(0);

	// rolling trace envelope (min/max per axis + per dyno sub-channel), capped to retainSec.
	trace = emptyTrace();
	// How much trace history to keep. This used to be the plot's window itself (windowSec), so the
	// window only took effect as data arrived, widening it could never bring back what had been
	// dropped, and every panel shared one window (#105/#76/#34). Now each plot slices its own
	// window (plotWindow.ts) out of a history at least as long as the slider's maximum; a view
	// that wants more (a typed-in window, up to WINDOW_MAX_SEC) registers a demand for it.
	retainFloorSec = WINDOW_SLIDER_MAX_SEC;
	private windowDemand = new Map<unknown, number>();
	// Called when retainSec grows, so playback can rebuild the trace history it has already
	// trimmed (engine.ts). The live path has nothing to rebuild from: it just keeps more from now on.
	onRetentionGrow: (() => void) | null = null;
	get retainSec(): number {
		let m = this.retainFloorSec;
		for (const v of this.windowDemand.values()) if (v > m) m = v;
		return Math.min(WINDOW_MAX_SEC, m);
	}
	/** A view asks for `sec` of trace history under `key` (any stable identity); null withdraws it. */
	setWindowDemand(key: unknown, sec: number | null) {
		const before = this.retainSec;
		if (sec == null || !Number.isFinite(sec)) this.windowDemand.delete(key);
		else this.windowDemand.set(key, sec);
		if (this.retainSec > before) this.onRetentionGrow?.();
	}

	// FRM points, preallocated; filled incrementally. count = live points; cCap for colour scaling.
	// cx/cy/cz carry ALL three axis forces per point (not just whichever axis was selected when the
	// point was drawn) so the FRM colour axis can be switched at any time and instantly recolour the
	// whole accumulated spiral — see LiveFrm.vue, which picks one of the three at render time.
	private cap = 2_000_000;
	// cLo/cHi: optional percentile-based colour bounds, set once by playback (which has the whole
	// cut up front and can match the finished-cut view's colour scale exactly) and left undefined
	// for a true live recording (which cannot know its own final range ahead of time and falls
	// back to cAbsMaxByAxis's running-max, symmetric-about-zero scheme — see LiveFrm.vue's frame()).
	frm = {
		xy: new Float32Array(this.cap * 2), cx: new Float32Array(this.cap), cy: new Float32Array(this.cap), cz: new Float32Array(this.cap),
		count: 0, cAbsMaxByAxis: { Fx: 1, Fy: 1, Fz: 1 } as Record<'Fx' | 'Fy' | 'Fz', number>,
		cLo: undefined as number | undefined, cHi: undefined as number | undefined,
	};

	private ws: WebSocket | null = null;
	// Reconnect state (#2.1): the stream drops whenever the backend restarts (the desktop shell's
	// supervisor does that after a crash) or the Record page is left and re-entered, and nothing
	// used to reopen it. `wantConnected` is the page's intent (connect() .. disconnect()); a close
	// while it holds schedules a retry with backoff.
	private wantConnected = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempts = 0;
	/** Backoff before reconnect attempt n (0-based): 0.5 s doubling to a 10 s ceiling. */
	static reconnectDelayMs(attempt: number): number { return Math.min(10_000, 500 * 2 ** attempt); }
	/** Called after every stream (re)open and once its reconcile with /record/status finished. */
	onStreamOpen: (() => void) | null = null;
	/**
	 * Whether this client reflects the recorder. The workspace turns it off in playback mode, where
	 * the playback engine drives `status` itself and the recorder's state is irrelevant.
	 */
	canReconcile: () => boolean = () => true;
	private base = getConfig().recorderUrl;
	get baseUrl() { return this.base; }
	// Playback (engine.ts) has no per-frame room check like onFrame's below — it needs to know the
	// buffer's real size up front so it can pick a stride that can never overflow it.
	get frmCapacity() { return this.cap; }
	private relay: BroadcastChannel | null = null;
	// Pop-out windows listening right now (#107). With none, relaying every decoded frame is pure
	// overhead on the acquisition PC (a structured clone per frame, at full frame rate, that nothing
	// receives) — and the common case is that no pop-out is open. This used to be a flag latched by
	// the first sync-request and never cleared, so closing a pop-out did not stop the relaying.
	// A pop-out that vanished without a 'bye' (crashed, killed) also stops asking for trace history
	// once it expires; its retainSec demand would otherwise stay registered for good.
	private peers = new RelayPeers(undefined, () => this.syncPeerDemand());
	// Keep the history this window retains at least as long as the widest pop-out asks for.
	private syncPeerDemand() { this.setWindowDemand(this.peers, this.peers.maxRetainSec(performance.now())); }
	private get hasRelayPeer() { return this.peers.alive(performance.now()); }
	private relayThrottle = createEmitThrottle(RELAY_TICK_MS);
	private relayTrailing: ReturnType<typeof setTimeout> | null = null;
	// Snapshots after the first are DELTAS (#107): only the FRM points, trace bins and spectra added
	// since the last one. A full snapshot (every point, up to 2M of them, structured-cloned 5x a
	// second) is sent only when a peer asks to sync or the buffers changed other than by appending
	// — which is what relayEpoch counts (see markDiscontinuity).
	relayEpoch = 0;
	private fftTotal = 0;   // spectra pushed since construction; deltas send the new ones
	private sent = { epoch: -1, frm: 0, traceT: -Infinity, fftTotal: 0 };
	// Pop-out side: this window's id, the epoch of the data it holds, and its heartbeat.
	private peerId = '';
	private heldEpoch = -1;
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	private lastSyncRequestAt = -Infinity;
	private onPageHide: (() => void) | null = null;

	// Build the absolute ws(s):// stream URL. `base` may be an absolute http(s) URL (dev, e.g.
	// http://localhost:8200) or a same-origin relative path (deploy, /recorder proxied by Caddy).
	// WebSocket() rejects relative URLs, so resolve a relative base against the page origin.
	private streamUrl(): string {
		const path = this.base + '/record/stream';
		if (/^wss?:/.test(path)) return path;
		if (/^https?:/.test(path)) return path.replace(/^http/, 'ws');
		const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
		return `${scheme}://${location.host}${path.startsWith('/') ? '' : '/'}${path}`;
	}

	connect() {
		this.wantConnected = true;
		this.reconnectAttempts = 0;
		if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
		this.openSocket();
		// Close any channel from a previous connect() before replacing it — reconnecting otherwise
		// leaks the old BroadcastChannel, which stays subscribed and keeps its handler alive.
		this.relay?.close();
		this.relay = new BroadcastChannel('force-app-live');
		this.relay.onmessage = (ev) => this.onPeerMessage(ev.data);
		// Pop-outs that opened before this source did (reopened at app start, #108, while the main
		// window is not yet on Record) sent their sync-request to nobody. Ask them to send again.
		this.relay.postMessage({ type: 'source-ready' });
	}

	private openSocket() {
		let ws: WebSocket;
		try { ws = new WebSocket(this.streamUrl()); } catch { this.scheduleReconnect(); return; }
		ws.binaryType = 'arraybuffer';
		ws.onopen = () => {
			if (this.ws !== ws) return;
			this.reconnectAttempts = 0;
			this.status.connected = true;
			if (this.status.error === STREAM_ERROR) this.status.error = null;
			// The stream sends no state on connect and anything that happened while it was down
			// (a cut that auto-stopped, a backend restart) was never delivered: ask the recorder.
			void this.reconcile().finally(() => { if (this.ws === ws) this.onStreamOpen?.(); });
		};
		ws.onclose = () => {
			// A socket we already replaced or disconnected must not touch the live one's state.
			if (this.ws !== ws) return;
			this.status.connected = false;
			this.ws = null;
			this.scheduleReconnect();
		};
		ws.onerror = () => { if (this.ws === ws) this.status.error = STREAM_ERROR; };
		ws.onmessage = (ev) => {
			if (typeof ev.data === 'string') this.onControl(JSON.parse(ev.data));
			else this.onFrame(ev.data as ArrayBuffer);
			if (this.hasRelayPeer) {
				this.relay?.postMessage(ev.data instanceof ArrayBuffer ? { bin: new Uint8Array(ev.data) } : { txt: ev.data });
			}
		};
		this.ws = ws;
	}

	private scheduleReconnect() {
		if (!this.wantConnected || this.reconnectTimer) return;
		const delay = RecordClient.reconnectDelayMs(this.reconnectAttempts++);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (this.wantConnected && !this.ws) this.openSocket();
		}, delay);
	}

	/**
	 * Bring `status` in line with the recorder's own record of the session (GET /record/status).
	 * The recorder is the source of truth (see invariant 1): the stream only delivers transitions
	 * while it is open, so a missed `done` left a finished cut showing as recording, and a restarted
	 * backend left a dead one. Terminal states are adopted only when this client believed the cut was
	 * still running (so a run the operator already dismissed does not come back), and a result that
	 * arrives after local state moved on is dropped.
	 */
	async reconcile(): Promise<void> {
		if (!this.canReconcile()) return;
		const before = { state: this.status.state, id: this.status.captureId };
		const unchanged = () => this.status.state === before.state && this.status.captureId === before.id;
		let data: any;
		try {
			const res = await fetch(this.base + '/record/status');
			if (!res.ok) return;
			data = await res.json();
		} catch { return; }
		if (!this.canReconcile() || !unchanged()) return;

		const srv = data?.state;
		const local = before.state;
		const live = local === 'recording' || local === 'finalizing';
		if (srv === 'recording' || srv === 'finalizing') {
			if (local !== srv || this.status.captureId !== (data.id ?? null)) {
				if (!live) this.reset();
				this.status.state = srv;
				this.status.captureId = data.id ?? null;
				this.status.error = null;
				this.status.nTotal = Number(data.n_total ?? 0);
				this.status.tSec = Number(data.elapsed_sec ?? 0);
				const p = data.peaks ?? {};
				this.status.peaks = { Fx: Number(p.Fx ?? 0), Fy: Number(p.Fy ?? 0), Fz: Number(p.Fz ?? 0) };
				this.status.railed = parseRailed(data.railed);
				// No WebSocket message carries this transition, so a pop-out would never learn it.
				if (this.hasRelayPeer) this.sendSnapshot(true);
			}
		} else if ((srv === 'done' || srv === 'error') && live) {
			const id: string | null = data.id ?? this.status.captureId;
			let summary: any = null;
			if (srv === 'done' && id) {
				// One retry: a blip here left summary null, which uploads read as "a .mat exists".
				for (let attempt = 0; attempt < 2 && summary === null; attempt++) {
					try {
						const r = await fetch(`${this.base}/captures/${id}/summary`);
						if (r.ok) summary = await r.json();
					} catch { /* the dialog still works from live_cache.bin; summary only adds extras */ }
					if (!unchanged()) return;
				}
			}
			this.status.captureId = id;
			this.status.error = data.error ?? null;
			this.status.errorKind = data.error_kind ?? null;
			this.status.summary = summary;
			this.status.state = srv;
			this.relayDone();
		} else if (live && (srv === 'idle' || srv == null)) {
			// The recorder has no such session any more: it restarted mid-cut. Whatever it had
			// written is on disk (raw.d1raw), recoverable from the banner.
			this.status.error = 'The recorder restarted while this recording was running. What was captured so far is on disk: use "Recover" in the banner at the top of this page.';
			this.status.errorKind = 'acquisition';
			this.status.state = 'error';
			this.relayDone();
		}
	}

	/**
	 * Pop-outs have their own RecordClient and only learn terminal state from the `done` control
	 * message the opener relays off its WebSocket. A reconcile that adopts one itself (missed
	 * message, recorder restart) relays the same message, so they converge too.
	 */
	private relayDone() {
		if (!this.hasRelayPeer) return;
		const s = this.status;
		this.relay?.postMessage({ txt: JSON.stringify({
			type: 'done', id: s.captureId, state: s.state, error: s.error, error_kind: s.errorKind, summary: s.summary,
		}) });
	}

	// Opener side: a pop-out spoke. Public for tests; the relay is its only real caller.
	onPeerMessage(d: any) {
		if (d?.type === 'sync-request' || d?.type === 'heartbeat') {
			const isNew = this.peers.seen(String(d.id ?? 'anon'), performance.now(), Number(d.retainSec) || 0);
			// A pop-out wider than our own history needs more of it kept here, or the snapshots
			// it is sent could never cover its window.
			this.syncPeerDemand();
			// A pop-out exists: send it the backlog, and start relaying live frames from here on.
			// A heartbeat from a peer we had dropped (it expired while throttled, said bye and came
			// back from the bfcache, or this window reloaded) means it holds stale buffers: resync
			// it too, or the deltas that follow would be applied onto the wrong data.
			if (d.type === 'sync-request' || isNew) this.sendSnapshot(true);
		} else if (d?.type === 'bye') {
			this.peers.bye(String(d.id ?? 'anon'));
			this.syncPeerDemand();
		}
	}

	snapshotReady = ref(false);

	connectViaRelay() {
		this.relay?.close();  // same leak guard as connect()
		this.relay = new BroadcastChannel('force-app-live');
		this.relay.onmessage = (ev) => {
			const d = ev.data;
			if (d?.bin) { const u8 = new Uint8Array(d.bin); this.onFrame(u8.buffer as ArrayBuffer); }
			else if (d?.txt) this.onControl(JSON.parse(d.txt));
			else if (d?.type === 'snapshot') {
				this.applySnapshot(d);
				this.snapshotReady.value = true;
			}
			// A new source has never heard from us, so a request we made moments ago does not count.
			else if (d?.type === 'source-ready') this.requestSync(true);
		};
		this.status.connected = true;
		this.peerId = Math.random().toString(36).slice(2) + Date.now().toString(36);
		this.relay.postMessage({ type: 'sync-request', id: this.peerId, retainSec: this.retainSec });
		// Liveness for the opener (#107): it stops relaying a few seconds after the last heartbeat,
		// and at once on 'bye'. pagehide covers closing the window, which never unmounts the app.
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = setInterval(() => {
			this.relay?.postMessage({ type: 'heartbeat', id: this.peerId, retainSec: this.retainSec });
		}, RELAY_HEARTBEAT_MS);
		if (typeof window !== 'undefined' && !this.onPageHide) {
			this.onPageHide = () => this.relay?.postMessage({ type: 'bye', id: this.peerId });
			window.addEventListener('pagehide', this.onPageHide);
		}
		// The parent might not exist/respond (e.g. this window was opened standalone, or the parent
		// tab closed) — don't leave the pop-out stuck on "Syncing…" forever if no snapshot ever comes.
		setTimeout(() => { this.snapshotReady.value = true; }, 2000);
	}

	// `this.status` is a Vue reactive() proxy — its nested objects (peaks/summary/diskAction) are
	// themselves lazily-wrapped reactive proxies on access, so a shallow `{ ...this.status }` copies
	// those nested PROXIES by reference, not plain objects. Proxies aren't structured-clonable, so
	// postMessage()ing that shape throws DataCloneError — which was silently swallowed by the catch
	// below (whose OWN fallback made the exact same mistake, so it threw too, uncaught, and the
	// child never got anything at all, just its 2s timeout). A full JSON round-trip strips every
	// level of proxy-ness at once; safe here since LiveStatus is plain JSON-shaped data (no Dates,
	// Maps, or typed arrays inside it — those live in frm/trace/fft, which are already plain class
	// fields, not reactive-wrapped, so their own .slice()s were never the problem).
	private plainStatus(): LiveStatus {
		return JSON.parse(JSON.stringify(this.status));
	}

	// Playback (engine.ts) never touches `ws` — it writes frm/trace directly and bumps frameSeq
	// itself — so the ws.onmessage raw-frame relay above, which only fires on real WebSocket
	// traffic, never runs during a replay. That left a pop-out/cloned window frozen on whatever
	// frame it had when playback started. Called from the playback tick loop instead, throttled
	// to at most 5x/sec — plenty for a viewer window. Each one is a delta (see buildSnapshot).
	relayTick() {
		if (!this.hasRelayPeer) return;
		if (this.relayThrottle.mark(performance.now())) { this.sendSnapshot(false); return; }
		// Throttled: this may be the LAST tick (a scrub released, the cut ended, playback paused),
		// after which nothing would ever send the state it left, and the pop-out would stay stale.
		// A trailing send delivers it once the interval has passed.
		if (this.relayTrailing === null) this.scheduleRelayTrailing(RELAY_TICK_MS);
	}
	private scheduleRelayTrailing(ms: number) {
		this.relayTrailing = setTimeout(() => {
			this.relayTrailing = null;
			if (!this.relayThrottle.pending) return;           // a later tick already sent it
			if (!this.hasRelayPeer) return;
			if (this.relayThrottle.flush(performance.now())) this.sendSnapshot(false);
			else this.scheduleRelayTrailing(10);               // the timer fired a hair early
		}, ms);
	}

	/**
	 * The buffers changed other than by appending (a reset, a backward seek, a trace rebuild, the
	 * spectrum history filtered): the next snapshot must be a full one. Anything that replaces or
	 * truncates trace/frm/fftHistory has to call this, or pop-outs would apply a delta onto data
	 * that no longer matches.
	 */
	markDiscontinuity() { this.relayEpoch++; }

	/** Drop trace bins older than tMin (the front of the rolling history). */
	trimTrace(tMin: number) {
		const t = this.trace.t;
		const drop = firstAtOrAfter(t, tMin);
		if (drop <= 0) return;
		t.splice(0, drop); this.trace.fx.splice(0, drop);
		this.trace.fy.splice(0, drop); this.trace.fz.splice(0, drop);
		for (const n of SUB_NAMES) this.trace.sub[n]?.splice(0, drop);
	}

	/**
	 * The next relay message. Full on request, after a discontinuity, or when frm shrank; otherwise
	 * only what was appended since the previous one: FRM points [sent, count), trace bins newer than
	 * the last one sent, spectra pushed since. Public for tests; the relay is its only real caller.
	 */
	buildSnapshot(forceFull: boolean) {
		const fm = this.frm;
		const n = fm.count;
		const full = forceFull || this.sent.epoch !== this.relayEpoch || n < this.sent.frm;
		const from = full ? 0 : this.sent.frm;
		const tr = this.trace;
		const ti = full ? 0 : firstAtOrAfter(tr.t, this.sent.traceT + 1e-9);
		const sliceEnv = (a: [number, number][]) => a.slice(ti);
		const newFft = full ? this.fftHistory.length : Math.min(this.fftHistory.length, this.fftTotal - this.sent.fftTotal);
		const snap = {
			type: 'snapshot' as const,
			full,
			epoch: this.relayEpoch,
			status: this.plainStatus(),
			frm: {
				from, count: n,
				xy: fm.xy.slice(from * 2, n * 2), cx: fm.cx.slice(from, n), cy: fm.cy.slice(from, n), cz: fm.cz.slice(from, n),
				cAbsMaxByAxis: { ...fm.cAbsMaxByAxis }, cLo: fm.cLo, cHi: fm.cHi,
			},
			trace: { t: tr.t.slice(ti), fx: sliceEnv(tr.fx), fy: sliceEnv(tr.fy), fz: sliceEnv(tr.fz),
				sub: Object.fromEntries(Object.entries(tr.sub).map(([k, v]) => [k, sliceEnv(v)])) },
			fft: full || newFft > 0 ? (this.fft ? { ...this.fft } : null) : undefined,
			fftHistory: newFft > 0 ? this.fftHistory.slice(this.fftHistory.length - newFft) : [],
		};
		this.sent = { epoch: this.relayEpoch, frm: n, traceT: tr.t.length ? tr.t[tr.t.length - 1] : this.sent.traceT, fftTotal: this.fftTotal };
		if (full && !tr.t.length) this.sent.traceT = -Infinity;
		return snap;
	}

	private sendSnapshot(forceFull: boolean) {
		try {
			this.relay?.postMessage(this.buildSnapshot(forceFull));
		} catch (e) {
			console.warn('[force-app] snapshot sync to pop-out window failed:', e);
			this.sent.epoch = -1;   // whatever was half-built, the next one must be full
			this.relay?.postMessage({ type: 'snapshot', full: true, epoch: -1, status: this.plainStatus(), frm: { from: 0, xy: new Float32Array(0), cx: new Float32Array(0), cy: new Float32Array(0), cz: new Float32Array(0), count: 0, cAbsMaxByAxis: { Fx: 1, Fy: 1, Fz: 1 } }, trace: null, fft: null, fftHistory: [] });
		}
	}

	// Pop-out side: ask the opener for a full snapshot, at most twice a second.
	private requestSync(force = false) {
		const now = performance.now();
		if (!force && now - this.lastSyncRequestAt < 500) return;
		this.lastSyncRequestAt = now;
		this.relay?.postMessage({ type: 'sync-request', id: this.peerId, retainSec: this.retainSec });
	}

	/** Apply a relay message (full or delta). Public for tests; the relay is its only real caller. */
	applySnapshot(snap: any) {
		if (snap.status) { Object.assign(this.status, snap.status); }
		if (snap.full === false) {
			// A delta only makes sense on top of exactly the data it was cut from. Anything else (a
			// missed message, or joining mid-stream before our own sync was answered): ask again.
			if (snap.epoch !== this.heldEpoch || !snap.frm || snap.frm.from !== this.frm.count) {
				this.requestSync();
				this.frameSeq.value++;
				return;
			}
			this.applyDelta(snap);
			this.frameSeq.value++;
			return;
		}
		this.heldEpoch = snap.epoch ?? -1;
		if (snap.frm) {
			const n = snap.frm.count || 0;
			const f32 = (a: ArrayLike<number> | undefined) => (a instanceof Float32Array ? a : Float32Array.from(a ?? []));
			const xy = f32(snap.frm.xy);
			const cx = f32(snap.frm.cx);
			const cy = f32(snap.frm.cy);
			const cz = f32(snap.frm.cz);
			if (xy.length >= n * 2 && cx.length >= n && cy.length >= n && cz.length >= n) {
				this.frm.xy.set(xy.subarray(0, n * 2), 0);
				this.frm.cx.set(cx.subarray(0, n), 0); this.frm.cy.set(cy.subarray(0, n), 0); this.frm.cz.set(cz.subarray(0, n), 0);
				// Set even when n is 0: a full snapshot after a reset must clear the old spiral here too.
				this.frm.count = n;
				this.frm.cAbsMaxByAxis = snap.frm.cAbsMaxByAxis ?? { Fx: 1, Fy: 1, Fz: 1 };
				this.frm.cLo = snap.frm.cLo; this.frm.cHi = snap.frm.cHi;
			} else {
				console.warn('[force-app] snapshot frm data too small: need xy[', n * 2, '], cx/cy/cz[', n, ']');
			}
		}
		if (snap.trace) {
			this.trace.t = snap.trace.t; this.trace.fx = snap.trace.fx;
			this.trace.fy = snap.trace.fy; this.trace.fz = snap.trace.fz;
			this.trace.sub = snap.trace.sub;
		}
		if (snap.fft !== undefined) this.fft = snap.fft;
		if (snap.fftHistory) { this.fftHistory = snap.fftHistory; this.fftSeq.value++; }
		this.frameSeq.value++;
	}

	private applyDelta(snap: any) {
		const f = snap.frm;
		const n = Math.min(this.cap, f.count || 0);
		const k = n - f.from;
		if (k > 0) {
			this.frm.xy.set(f.xy.subarray(0, k * 2), f.from * 2);
			this.frm.cx.set(f.cx.subarray(0, k), f.from); this.frm.cy.set(f.cy.subarray(0, k), f.from); this.frm.cz.set(f.cz.subarray(0, k), f.from);
		}
		this.frm.count = n;
		this.frm.cAbsMaxByAxis = f.cAbsMaxByAxis ?? this.frm.cAbsMaxByAxis;
		this.frm.cLo = f.cLo; this.frm.cHi = f.cHi;
		const tr = snap.trace;
		if (tr?.t?.length) {
			for (let i = 0; i < tr.t.length; i++) {
				this.trace.t.push(tr.t[i]);
				this.trace.fx.push(tr.fx[i]); this.trace.fy.push(tr.fy[i]); this.trace.fz.push(tr.fz[i]);
			}
			for (const name of SUB_NAMES) {
				const add = tr.sub?.[name];
				if (!add) continue;
				(this.trace.sub[name] ??= []).push(...add);
			}
			this.trimTrace(this.trace.t[this.trace.t.length - 1] - this.retainSec);
		}
		if (snap.fft !== undefined) this.fft = snap.fft;
		if (snap.fftHistory?.length) {
			this.fftHistory.push(...snap.fftHistory);
			if (this.fftHistory.length > this.fftHistCap) this.fftHistory.splice(0, this.fftHistory.length - this.fftHistCap);
			this.fftSeq.value++;
		}
	}

	// Latest spectra frame + the rolling history the spectrogram/waterfall draw from. Shared by the
	// live stream and the playback engine.
	pushFft(axis: string, f: number[], fs: number, spectra: Record<string, number[]>, t: number) {
		this.fft = { axis, f, fs, spectra };
		this.fftHistory.push({ t, spectra });
		if (this.fftHistory.length > this.fftHistCap) this.fftHistory.shift();
		this.fftTotal++;
		this.fftSeq.value++;
	}

	disconnect() {
		this.wantConnected = false;
		if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
		// A pop-out says goodbye so the opener stops relaying at once rather than on expiry.
		if (this.peerId) this.relay?.postMessage({ type: 'bye', id: this.peerId });
		if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
		if (this.onPageHide) { window.removeEventListener('pagehide', this.onPageHide); this.onPageHide = null; }
		const ws = this.ws; this.ws = null; ws?.close();
		this.status.connected = false;
		this.relay?.close(); this.relay = null; this.peers.clear();
		if (this.relayTrailing !== null) { clearTimeout(this.relayTrailing); this.relayTrailing = null; }
	}

	private onControl(msg: any) {
		if (msg.type === 'done') {
			this.status.state = msg.state;
			this.status.error = msg.error ?? null;
			this.status.errorKind = msg.error_kind ?? null;
			this.status.captureId = msg.id ?? this.status.captureId;
			this.status.summary = msg.summary ?? null;
		} else if (msg.type === 'fft') {
			const spectra: Record<string, number[]> = msg.spectra ?? (msg.axis ? { [msg.axis]: msg.amp ?? [] } : {});
			this.pushFft(msg.axis, msg.f, msg.fs ?? 0, spectra, this.status.tSec);
		} else if (msg.type === 'cutstart') {
			this.status.cutStartSec = msg.t;
		} else if (msg.type === 'disk_action') {
			this.status.diskAction = { action: msg.action, freeGb: msg.free_gb };
		} else if (msg.type === 'railed') {
			// The backend's latched set, re-sent every couple of seconds while any channel is railed.
			this.status.railed = parseRailed(msg.channels);
		} else if (msg.type === 'tacho') {
			// Sent only on a transition. false => the tacho produced no timable pulse pair, so the
			// rpm field in the binary frames is 0 because nothing was measured — NOT because the
			// spindle is confirmed stopped. The distinction matters: the backend used to report the
			// configured spindle speed here, which looked healthy while the sensor was dead.
			this.status.tachoOk = msg.ok === true;
		}
	}

	private onFrame(buf: ArrayBuffer) {
		const dv = new DataView(buf);
		if (dv.getUint32(0, true) !== MAGIC) return;
		const seq = dv.getUint32(8, true);
		const tSec = dv.getFloat32(12, true);
		const rpm = dv.getFloat32(16, true);
		const pfx = dv.getFloat32(20, true), pfy = dv.getFloat32(24, true), pfz = dv.getFloat32(28, true);
		const nTotal = dv.getUint32(32, true);
		const nTrace = dv.getUint32(36, true);
		const nSub = dv.getUint32(40, true);
		const nPts = dv.getUint32(44, true);

		this.status.seq = seq; this.status.tSec = tSec; this.status.rpm = rpm;
		this.status.peaks = { Fx: pfx, Fy: pfy, Fz: pfz }; this.status.nTotal = nTotal;
		if (this.status.state === 'idle') this.status.state = 'recording';

		let off = 48;
		const trace = new Float32Array(buf, off, nTrace * 7);
		off += nTrace * 7 * 4;
		const sub = nSub ? new Float32Array(buf, off, nTrace * nSub * 2) : null;
		off += nSub ? nTrace * nSub * 2 * 4 : 0;
		const pts = new Float32Array(buf, off, nPts * 5); // x, y, cx, cy, cz (D1LF v3)

		const nSubUse = Math.min(nSub, SUB_NAMES.length);
		for (let i = 0; i < nTrace; i++) {
			const b = i * 7;
			this.trace.t.push(trace[b]);
			this.trace.fx.push([trace[b + 1], trace[b + 2]]);
			this.trace.fy.push([trace[b + 3], trace[b + 4]]);
			this.trace.fz.push([trace[b + 5], trace[b + 6]]);
			if (sub) {
				const sb = i * nSub * 2;
				for (let j = 0; j < nSubUse; j++) this.trace.sub[SUB_NAMES[j]].push([sub[sb + j * 2], sub[sb + j * 2 + 1]]);
			}
		}
		// drop points older than the retained history (each plot slices its own, shorter, window)
		this.trimTrace(tSec - this.retainSec);

		const start = this.frm.count;
		const room = this.cap - start;
		const take = Math.min(nPts, room);
		const peaksByAxis = this.frm.cAbsMaxByAxis;
		for (let i = 0; i < take; i++) {
			const s = i * 5;
			this.frm.xy[(start + i) * 2] = pts[s];
			this.frm.xy[(start + i) * 2 + 1] = pts[s + 1];
			const cx = pts[s + 2], cy = pts[s + 3], cz = pts[s + 4];
			this.frm.cx[start + i] = cx; this.frm.cy[start + i] = cy; this.frm.cz[start + i] = cz;
			const ax = Math.abs(cx), ay = Math.abs(cy), az = Math.abs(cz);
			if (ax > peaksByAxis.Fx) peaksByAxis.Fx = ax;
			if (ay > peaksByAxis.Fy) peaksByAxis.Fy = ay;
			if (az > peaksByAxis.Fz) peaksByAxis.Fz = az;
		}
		this.frm.count = start + take;
		this.frameSeq.value++;
	}

	// ---- control REST ----
	async start(cfg: RecordConfig) {
		this.reset();
		const res = await fetch(this.base + '/record/start', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify(cfg),
		});
		// Structured when the backend names the offending field (#84) — see recordingErrors.ts.
		if (!res.ok) throw parseStartError(res.status, await res.text());
		const j = await res.json();
		this.status.state = 'recording';
		this.status.captureId = j.id;
	}

	// NOTE: there is deliberately no startReplay() here any more. Replaying an archived cut is
	// PLAYBACK — a local playhead over the cut (record/playback/engine.ts) that writes nothing —
	// not a recording session, so nothing in the app posts /record/start_replay. That endpoint does
	// still exist and stays covered by backend/tests/test_replay.py: it drives real data through
	// the whole acquisition pipeline, which is useful as a pipeline test. This client method was
	// its only caller and had none of its own left, so it went rather than lingering as a second,
	// untested way to start a replay that behaves nothing like the transport controls.

	async stop() {
		const res = await fetch(this.base + '/record/stop', { method: 'POST', headers: { ...authHeaders() } });
		// Not ok means the stop did NOT happen (409 = nothing is recording, e.g. the cut already
		// auto-stopped; 4xx/5xx = refused). It used to be ignored, leaving the UI in "recording".
		if (!res.ok) throw new Error(`stop failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim());
		const j = await res.json();
		this.status.state = j.state;
		this.status.captureId = j.id ?? this.status.captureId;
		this.status.summary = j.summary ?? this.status.summary;
	}

	reset() {
		this.markDiscontinuity();
		this.trace = emptyTrace();
		// Keep the preallocated FRM buffers (~40 MB): `count` alone bounds what anything reads.
		const fm = this.frm;
		fm.count = 0; fm.cAbsMaxByAxis = { Fx: 1, Fy: 1, Fz: 1 }; fm.cLo = undefined; fm.cHi = undefined;
		this.fft = null; this.fftHistory = []; this.fftSeq.value++;
		this.status.state = 'idle'; this.status.error = null; this.status.errorKind = null; this.status.summary = null;
		this.status.captureId = null; this.status.nTotal = 0; this.status.tSec = 0;
		this.status.peaks = { Fx: 0, Fy: 0, Fz: 0 }; this.status.cutStartSec = null;
		this.status.diskAction = null; this.status.tachoKind = 'signal'; this.status.railed = [];
		this.frameSeq.value++;
	}

	cacheUrl(id: string) { return `${this.base}/captures/${id}/live_cache.bin`; }
	matUrl(id: string) { return `${this.base}/captures/${id}/capture.mat`; }
}
