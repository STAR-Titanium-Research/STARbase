// Video-style playback of an archived cut. The playhead lives here, in the browser, and fills the
// SAME RecordClient buffers the live WebSocket fills — so every panel renders a replay exactly as
// it renders a live recording, with no panel changes at all.
//
// Nothing is written to disk and no RecordingSession is opened: playback is a viewer, not a
// recording. That is also what makes scrubbing possible — RawWriter is append-only and
// FrmIntegrator carries theta/rho across chunks, so seeking backwards through a real session
// would either corrupt the capture or need integrator state unwound that was never built to unwind.
//
// DETERMINISM: a sample's envelope bin and its FRM point are pure functions of its INDEX, never of
// when it was drawn. That is the whole trick — it makes "seek to t" and "play through to t"
// produce byte-identical buffers, which is the invariant engine.test.ts pins down.
import { reactive } from 'vue';
import { axisAutoLimits, idxOfTime as firstIdxAtOrAfter, type Axis, type Cache } from '@d1/force-plotting';
import { SUB_NAMES, type RecordClient } from '../liveClient';
import { createSpectrumClient, type SpectrumClient } from './spectrum';

export interface PlaybackOpts {
	baseUrl: string;
	now?: () => number;
	schedule?: (cb: () => void) => number;
	cancel?: (h: number) => void;
}
export interface PlaybackState {
	loaded: boolean; playing: boolean; tSec: number; duration: number; speed: number; error: string | null;
}
export interface PlaybackEngine {
	load(cache: Cache, o: { ppr: number; innerDiam?: number; stride: number; axis?: Axis; cropStartSec?: number }): void;
	play(): void; pause(): void; toggle(): void;
	seek(tSec: number, o?: { commit?: boolean }): void;
	setSpeed(x: number): void;
	setAxis(axis: Axis): void;
	/**
	 * Stop the frame loop but keep the loaded cut, the playhead and the spectrum transport intact,
	 * so returning to the Record page resumes exactly where the user left off. There is
	 * deliberately no destructive teardown: the workspace that owns this engine is an app-lifetime
	 * module singleton (#25), so a "dispose" here could only ever run once and would poison replay
	 * for the rest of the session -- which is precisely what #63/#66/#50 were.
	 */
	suspend(): void;
	state: PlaybackState;
}

// Envelope bins per second of CUT time. Fixed in cut time (not wall time) so the plot has the same
// density at 0.25x as at 20x, and so bin boundaries fall on fixed sample indices.
const BINS_PER_SEC = 200;
// Trailing window handed to /dsp/spectrum, capped like session.py's _fft_cap.
const FFT_WINDOW_SEC = 1.0;
const FFT_MAX = 200_000;

export function createPlaybackEngine(client: RecordClient, opts: PlaybackOpts): PlaybackEngine {
	const now = opts.now ?? (() => performance.now());
	const schedule = opts.schedule ?? ((cb: () => void) => requestAnimationFrame(cb));
	const cancel = opts.cancel ?? ((h: number) => cancelAnimationFrame(h));

	const state = reactive<PlaybackState>({
		loaded: false, playing: false, tSec: 0, duration: 0, speed: 1, error: null,
	});

	let cache: Cache | null = null;
	let ppr = 1, stride = 1, innerR = 0;
	let colorAxis: Axis = 'Fz';
	let csIdx = 0, revsCs = 0;         // FRM spiral origin (cache's own detected cut start)
	let binSize = 1;                   // samples per envelope bin
	// Two cursors, because the two buffers advance in different units. FRM points are per-sample,
	// so that cursor tracks the playhead exactly. Trace bins must stay WHOLE — emitting a partial
	// bin at a frame boundary and the rest on the next frame would make the envelope depend on how
	// playback happened to be chopped up, which breaks the seek-equals-play invariant. So the trace
	// cursor only ever advances to a bin boundary, lagging the playhead by under one bin (5 ms).
	let frmCursor = 0;                 // exclusive sample index whose FRM points are drawn
	let traceCursor = 0;               // exclusive sample index, always a multiple of binSize
	let frame: number | null = null;
	let lastTick = 0;
	const spectra: SpectrumClient = createSpectrumClient(opts.baseUrl);
	spectra.onReply = (r) => {
		// A success clears a previous transient failure; otherwise one blip left a permanent error
		// banner on the transport bar for the rest of the session.
		state.error = null;
		if (!r.f.length) return;
		client.pushFft('Fz', r.f, r.fs, r.spectra, state.tSec);
	};
	spectra.onError = (e) => { state.error = e.message; };

	// First sample at or after `sec`; at or past the last sample means "everything", i.e. N.
	function idxOfTime(sec: number): number {
		if (!cache) return 0;
		return sec >= cache.t[cache.N - 1] ? cache.N : firstIdxAtOrAfter(cache.t, sec);
	}

	function load(c: Cache, o: { ppr: number; innerDiam?: number; stride: number; axis?: Axis; cropStartSec?: number }) {
		reset();
		if (!c || c.N < 2 || !(c.Fs > 0)) {
			state.loaded = false;
			state.error = 'this cut has too few samples to play';
			return;
		}
		cache = c;
		ppr = o.ppr > 0 ? o.ppr : 1;
		innerR = Math.max(0, (o.innerDiam || 0) / 2);
		stride = Math.max(1, Math.round(o.stride) || 1);
		colorAxis = o.axis ?? 'Fz';
		// A human-saved crop override (plotting-window "Save crop as official") wins over the cache's
		// own auto-detected start-of-cut. Both are in signal-seconds, so idxOfTime maps either onto
		// the cache's time array regardless of the cache's decimated Fs.
		csIdx = idxOfTime(o.cropStartSec != null ? o.cropStartSec : c.csSec);
		revsCs = c.revs[csIdx] ?? 0;
		// client.frm.xy/c are fixed-size preallocated buffers (RecordClient's cap). Unlike onFrame's
		// live-decode path (which checks room/take per frame), appendFrmPoints below has no per-write
		// bounds check — a stride too fine for a long/dense cut let n run past the buffer's real
		// length. TypedArray writes past the end are silent no-ops, so points kept accumulating in
		// `count` while only the FIRST cap-worth (the spiral's OUTER portion, played first) actually
		// landed in the buffer — the finished view read as a doughnut even for a true full-disc cut,
		// only because it never got the inner points at all. Force the stride fine enough for the
		// requested resolution but never fine enough to overrun the buffer.
		const cap = client.frmCapacity;
		const worstCasePoints = Math.ceil((c.N - csIdx) / stride);
		if (worstCasePoints > cap) stride = Math.ceil((c.N - csIdx) / cap);
		binSize = Math.max(1, Math.round(c.Fs / BINS_PER_SEC));
		// Colour scale, once, over the WHOLE cut: the same prctile(1)/prctile(99) statistic the
		// finished-cut view (liveCloud.ts's buildCloud) uses, via the same axisAutoLimits(). Unlike
		// a true live recording, playback already has the entire cache, so there is no need to
		// track a running max and recolour nothing retroactively (LiveFrm.vue's cAbsMax fallback,
		// which locks in each point's colour against whatever range was known SO FAR — meaning
		// early points read against a narrower range than the cut's real one and never get
		// corrected. That is why a replayed spiral's colours didn't match the finished view's).
		const [lo, hi] = axisAutoLimits(c, colorAxis);
		client.frm.cLo = lo; client.frm.cHi = hi;
		state.loaded = true;
		state.error = null;
		state.duration = c.t[c.N - 1];
		state.tSec = 0;
		renderTo(0, false);
	}

	function reset() {
		pause();
		client.reset();
		frmCursor = 0; traceCursor = 0;
		state.tSec = 0; state.duration = 0; state.loaded = false; state.error = null;
		cache = null;
	}

	// Append WHOLE envelope bins covering [i0, i1). i0 and i1 are both bin boundaries, so a bin is
	// always built from the same samples however playback was chopped up — that is what makes
	// seek-to-t and play-to-t produce identical buffers.
	function appendTraceBins(i0: number, i1: number) {
		if (!cache || i1 <= i0) return;
		const c = cache;
		for (let b0 = i0; b0 < i1; b0 += binSize) {
			const s = b0, e = Math.min(b0 + binSize, i1);
			if (e <= s) continue;
			let fxlo = Infinity, fxhi = -Infinity, fylo = Infinity, fyhi = -Infinity, fzlo = Infinity, fzhi = -Infinity;
			for (let i = s; i < e; i++) {
				const x = c.Fx[i], y = c.Fy[i], z = c.Fz[i];
				if (x < fxlo) fxlo = x; if (x > fxhi) fxhi = x;
				if (y < fylo) fylo = y; if (y > fyhi) fyhi = y;
				if (z < fzlo) fzlo = z; if (z > fzhi) fzhi = z;
			}
			client.trace.t.push(c.t[(s + e - 1) >> 1]);
			client.trace.fx.push([fxlo, fxhi]);
			client.trace.fy.push([fylo, fyhi]);
			client.trace.fz.push([fzlo, fzhi]);
			// The cache carries summed axes only. Sub-channels are the same synthetic split
			// ReplaySource applies server-side (Fx/2, Fy/2, Fz/4); Tacho has no counterpart at all
			// and stays flat — TransportBar labels this so it is never mistaken for real data.
			const sub = client.trace.sub;
			sub.Fx1.push([fxlo / 2, fxhi / 2]); sub.Fx2.push([fxlo / 2, fxhi / 2]);
			sub.Fy1.push([fylo / 2, fyhi / 2]); sub.Fy2.push([fylo / 2, fyhi / 2]);
			for (const k of ['Fz1', 'Fz2', 'Fz3', 'Fz4']) sub[k].push([fzlo / 4, fzhi / 4]);
			sub.Tacho.push([0, 0]);
		}
	}

	// Append the FRM points for samples [i0, i1). Geometry is a pure function of the sample index
	// given the fixed spiral origin, so this matches liveCloud's `measured` branch exactly and
	// needs no carried state — which is why scrubbing backwards is just a count reset.
	function appendFrmPoints(i0: number, i1: number) {
		if (!cache || i1 <= i0) return;
		const c = cache;
		const rho0 = c.diam / 2;
		const F = c.feed;
		let n = client.frm.count;
		// Emit only samples on the global stride lattice measured from csIdx, so which samples
		// become points never depends on where an append happens to begin.
		const first = Math.max(i0, csIdx);
		const rem = (first - csIdx) % stride;
		// All three axis forces are stored per point (not just the currently-selected one) so a
		// later setAxis() can recolour the whole spiral instantly, the same way live recording does.
		for (let i = rem === 0 ? first : first + (stride - rem); i < i1; i += stride) {
			const r = (c.revs[i] - revsCs) / ppr;
			const rho = rho0 - F * r;
			if (rho < innerR) break;
			const th = 2 * Math.PI * r;
			client.frm.xy[n * 2] = rho * Math.cos(th);
			client.frm.xy[n * 2 + 1] = rho * Math.sin(th);
			client.frm.cx[n] = c.Fx[i]; client.frm.cy[n] = c.Fy[i]; client.frm.cz[n] = c.Fz[i];
			n++;
		}
		client.frm.count = n;
	}

	// Running |peak| per axis across [i0, i1), folded into whatever is already there.
	function accumulatePeaks(i0: number, i1: number) {
		if (!cache || i1 <= i0) return;
		const c = cache;
		let px = client.status.peaks.Fx, py = client.status.peaks.Fy, pz = client.status.peaks.Fz;
		for (let i = i0; i < i1; i++) {
			const x = Math.abs(c.Fx[i]); if (x > px) px = x;
			const y = Math.abs(c.Fy[i]); if (y > py) py = y;
			const z = Math.abs(c.Fz[i]); if (z > pz) pz = z;
		}
		client.status.peaks = { Fx: px, Fy: py, Fz: pz };
	}

	function trimWindow(tSec: number) {
		const tMin = tSec - client.windowSec;
		let drop = 0;
		const t = client.trace.t;
		while (drop < t.length && t[drop] < tMin) drop++;
		if (drop <= 0) return;
		client.trace.t.splice(0, drop);
		client.trace.fx.splice(0, drop);
		client.trace.fy.splice(0, drop);
		client.trace.fz.splice(0, drop);
		for (const n of SUB_NAMES) client.trace.sub[n].splice(0, drop);
	}

	// Bring the buffers to exactly represent playhead `tSec`. Forward is an append; backward
	// rebuilds from scratch, which is cheap because it is a straight pass over typed arrays.
	function renderTo(tSec: number, requestSpectrum = true, forceSpectrum = false) {
		if (!cache) return;
		const target = idxOfTime(tSec);
		if (target < frmCursor) {
			client.trace = emptyTrace();
			client.frm.count = 0; client.frm.cAbsMaxByAxis = { Fx: 1, Fy: 1, Fz: 1 };
			client.status.peaks = { Fx: 0, Fy: 0, Fz: 0 };
			frmCursor = 0; traceCursor = 0;
		}
		// fftHistory feeds the spectrogram / waterfall. Anything recorded ahead of the playhead is
		// in the future and must go, or those two views keep showing spectra from later in the cut
		// after a scrub. Checked in both directions (not just on a backward seek) so the invariant
		// "history is never ahead of the playhead" holds however the playhead got here; during
		// steady playback the guard is false and this costs nothing.
		const hist = client.fftHistory;
		if (hist.length && hist[hist.length - 1].t > tSec) {
			client.fftHistory = hist.filter((e) => e.t <= tSec);
			client.fftSeq.value++;
		}
		// Trace advances only to a whole-bin boundary; FRM advances to the playhead itself.
		const binEnd = Math.floor(target / binSize) * binSize;
		appendTraceBins(traceCursor, Math.max(traceCursor, binEnd));
		traceCursor = Math.max(traceCursor, binEnd);
		appendFrmPoints(frmCursor, target);
		accumulatePeaks(frmCursor, target);
		frmCursor = target;
		trimWindow(tSec);

		const c = cache;
		const last = Math.max(0, Math.min(c.N - 1, target - 1));
		client.status.tSec = tSec;
		client.status.rpm = c.rpm[last];        // straight from the cache; never re-derived
		client.status.nTotal = target;
		client.frameSeq.value++;

		if (requestSpectrum && spectra.wouldAccept(forceSpectrum)) {
			const win = Math.min(Math.round(c.Fs * FFT_WINDOW_SEC), FFT_MAX);
			const s0 = Math.max(0, target - win);
			if (target - s0 >= 256) {
				const n = target - s0;
				const buf = new Float32Array(n * 3);
				buf.set(c.Fx.subarray(s0, target), 0);
				buf.set(c.Fy.subarray(s0, target), n);
				buf.set(c.Fz.subarray(s0, target), n * 2);
				spectra.request({ fs: c.Fs, names: ['Fx', 'Fy', 'Fz'], samples: buf, force: forceSpectrum });
			}
		}
	}

	function emptyTrace() {
		const sub: Record<string, [number, number][]> = {};
		for (const n of SUB_NAMES) sub[n] = [];
		return { t: [] as number[], fx: [] as [number, number][], fy: [] as [number, number][], fz: [] as [number, number][], sub };
	}

	function tick() {
		frame = null;
		if (!state.playing || !cache) return;
		const t = now();
		const dt = (t - lastTick) / 1000;
		lastTick = t;
		const next = state.tSec + dt * state.speed;
		if (next >= state.duration) {
			state.tSec = state.duration;
			renderTo(state.duration, true, true);
			client.relayTick();
			pause();
			return;
		}
		state.tSec = next;
		renderTo(next);
		client.relayTick();
		frame = schedule(tick);
	}

	function play() {
		if (!state.loaded || state.playing) return;
		if (state.tSec >= state.duration) { state.tSec = 0; renderTo(0, false); }
		state.playing = true;
		// Panels gate live accumulation on state === 'recording' (see RpmPanel); playback is live
		// data as far as they are concerned. Pausing drops back to 'idle', which is also why the
		// Save dialog never fires — RecordPage only opens it on recording -> finalizing/done/error.
		client.status.state = 'recording';
		lastTick = now();
		frame = schedule(tick);
	}

	function pause() {
		state.playing = false;
		client.status.state = 'idle';
		if (frame !== null) { cancel(frame); frame = null; }
	}

	return {
		state,
		load,
		play,
		pause,
		toggle() { state.playing ? pause() : play(); },
		seek(tSec, o) {
			if (!state.loaded) return;
			const t = Math.max(0, Math.min(state.duration, tSec));
			state.tSec = t;
			renderTo(t, true, o?.commit !== false);
			client.relayTick();
			lastTick = now();
		},
		setSpeed(x) { state.speed = x > 0 ? x : 1; },
		setAxis(axis) {
			// client.frm.cx/cy/cz carry all three axis forces per point already (appendFrmPoints
			// writes all three, not just whichever axis is selected), so unlike before this needs no
			// data rebuild — only the percentile colour scale (cLo/cHi) is axis-specific. LiveFrm.vue
			// itself watches its `axis` prop and recolours the already-uploaded points instantly.
			if (!state.loaded || !cache || axis === colorAxis) return;
			colorAxis = axis;
			const [lo, hi] = axisAutoLimits(cache, axis);
			client.frm.cLo = lo; client.frm.cHi = hi;
		},
		suspend() { pause(); },
	};
}
