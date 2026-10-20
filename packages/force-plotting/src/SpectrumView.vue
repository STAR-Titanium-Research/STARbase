<script setup lang="ts">
// Finished-cut spectral view for the plotting dashboard: fetches the STFT of one axis from the
// filter-service (/spectrogram) and renders it three ways — a time × frequency heatmap
// (spectrogram), recent spectra stacked with an offset (waterfall), or the time-averaged power
// spectrum (power, dB). Mirrors the live recording views so plotting stays at feature parity.
// The power spectrum follows the chart rules (DESIGN.md 5b): one dB axis, a log frequency axis with
// decade labels and faint minor lines, and, with a filter chain on, the stop bands shaded and
// labelled with the raw spectrum faint behind the filtered one.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { type FilterChain, chainActive, defaultChain, fetchSpectrogram } from './filterChain';
import { debounce } from './debounce';
import { axisLabels, fmtFreq, logTicks, niceScale } from './chartAxis';
import { fmtHz, stopBands } from './filterResponse';
import { nearestIndex } from './hoverIndex';
import { resolveColor } from './cssColor';

const props = withDefaults(defineProps<{
	cacheFileId: string | null | undefined;
	chain: FilterChain;
	axis: string;
	mode: 'psd' | 'spectrogram' | 'waterfall';
	color?: string;
	filterBands?: boolean;     // power spectrum: shade the chain's stop bands (default on)
	rpm?: number | null;       // mean rotation speed; the notch harmonics are multiples of rpm / 60
}>(), { filterBands: true });

const canvasEl = ref<HTMLCanvasElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;
let ro: ResizeObserver | null = null;
const off = document.createElement('canvas');
const offCtx = off.getContext('2d');

type Grid = { f: number[]; t: number[]; S: number[][]; fmax: number; ref_db?: number };
const grid = ref<Grid | null>(null);
// The unfiltered spectrum, loaded once per file and axis and only for the power view with a chain on.
const rawGrid = ref<Grid | null>(null);
let rawKey = '';
let rawAbort: AbortController | null = null;
const loading = ref(false);
const err = ref<string | null>(null);
let reqId = 0;

// ---- hover readout (value under the cursor, mirroring ForceChart.vue's crosshair) ----
const hover = ref<{ x: number; y: number; text: string } | null>(null);
// Same rAF-coalescing rationale as ForceChart.vue's onMove fix: don't redraw on every raw
// mousemove event, only once per animation frame.
let hoverRafId = 0;
let pendingHoverEv: MouseEvent | null = null;
function computeHover(ev: MouseEvent) {
	setMargins();
	const c = canvasEl.value, g = grid.value;
	if (!c || !g || !g.f.length || !g.t.length) { hover.value = null; draw(); return; }
	const r = c.getBoundingClientRect();
	const px = ev.clientX - r.left, py = ev.clientY - r.top;
	const plotW = Math.max(1, r.width - ML - MR), plotH = Math.max(1, r.height - MT - MB);
	if (px < ML || px > ML + plotW || py < MT || py > MT + plotH) { hover.value = null; draw(); return; }
	const nF = g.f.length, nT = g.t.length;
	if (props.mode === 'spectrogram') {
		const ti = Math.min(nT - 1, Math.max(0, Math.round(((px - ML) / plotW) * (nT - 1))));
		const fi = Math.min(nF - 1, Math.max(0, Math.round((1 - (py - MT) / plotH) * (nF - 1))));
		const db = g.S[fi]?.[ti];
		hover.value = { x: px, y: py, text: `${g.t[ti].toFixed(1)}s · ${Math.round(g.f[fi])}Hz · ${db != null ? db.toFixed(1) : '?'}dB` };
	} else if (props.mode === 'psd') {
		const fi = nearestIndex(g.f, psdFreqAt(g, (px - ML) / plotW), 0, nF - 1);
		const db = psdOf(g)[fi] + psdOffset(g);
		hover.value = { x: px, y: py, text: `${fmtHz(g.f[fi])}${db != null ? ` · ${db.toFixed(1)} dB` : ''}` };
	} else {   // waterfall — no numeric y-axis (vertical offset encodes recency, not a value)
		const fi = Math.min(nF - 1, Math.max(0, Math.round(((px - ML) / plotW) * (nF - 1))));
		hover.value = { x: px, y: py, text: `${Math.round(g.f[fi])}Hz` };
	}
	draw();
}
function onHoverMove(ev: MouseEvent) {
	pendingHoverEv = ev;
	if (!hoverRafId) hoverRafId = requestAnimationFrame(() => { hoverRafId = 0; if (pendingHoverEv) computeHover(pendingHoverEv); });
}
function onHoverLeave() { hover.value = null; draw(); }

function palette() {
	const s = getComputedStyle(document.documentElement);
	return {
		grid: s.getPropertyValue('--d1-grid').trim(),
		bg: s.getPropertyValue('--plot-bg').trim() || '#0b1020',
		text: s.getPropertyValue('--text-dim').trim() || 'rgba(148,163,184,0.75)',
		textFaint: s.getPropertyValue('--text-faint').trim() || 'rgba(226,232,240,0.55)',
	};
}
// This package has no import path into the host app's theme.ts, so watch the DOM attribute
// the host toggles directly instead — cheap, and correct regardless of which app embeds this.
let themeObserver: MutationObserver | null = null;

// A newer load aborts the one still in flight (so the server stops an STFT nobody will look at) and
// stale results are dropped by reqId either way.
let loadAbort: AbortController | null = null;
async function load() {
	loadAbort?.abort(); loadAbort = null;
	if (!props.cacheFileId) {
		++reqId; grid.value = null; loading.value = false;
		rawAbort?.abort(); rawKey = ''; rawGrid.value = null;
		return;
	}
	const mine = ++reqId;
	const ac = new AbortController(); loadAbort = ac;
	loading.value = true; err.value = null;
	try {
		void loadRaw();   // in parallel; the filtered trace never waits for it
		const g = await fetchSpectrogram(props.cacheFileId, props.chain, props.axis, ac.signal);
		if (mine === reqId) { grid.value = g; }
	} catch (e: any) {
		if (mine === reqId && !ac.signal.aborted) { err.value = e?.message || 'spectrogram failed'; grid.value = null; }
	} finally {
		if (mine === reqId) { loading.value = false; draw(); }
	}
}

// The raw spectrum for the faint line behind a filtered one. It does not depend on the chain, so it
// loads once per file and axis; its failure costs only that line (and is retried on the next load).
async function loadRaw() {
	if (props.mode !== 'psd' || !chainActive(props.chain) || !props.cacheFileId) return;
	const key = `${props.cacheFileId}|${props.axis}`;
	if (key === rawKey) return;
	rawAbort?.abort(); rawKey = key; rawGrid.value = null;
	const ac = new AbortController(); rawAbort = ac;
	try {
		const raw = await fetchSpectrogram(props.cacheFileId, defaultChain(), props.axis, ac.signal);
		if (rawKey === key) { rawGrid.value = raw; draw(); }
	} catch {
		if (rawKey === key && !ac.signal.aborted) rawKey = '';
	}
}

// dB (-80..0) → RGB, inferno-ish (dark → magenta → yellow).
function color(db: number, out: Uint8ClampedArray, o: number) {
	const x = Math.max(0, Math.min(1, (db + 80) / 80));
	out[o] = Math.round(255 * Math.min(1, Math.max(0, 1.6 * x - 0.35)));
	out[o + 1] = Math.round(255 * Math.min(1, Math.max(0, 1.7 * x - 0.6)));
	out[o + 2] = Math.round(255 * Math.min(1, Math.max(0, 1.1 - 1.8 * Math.abs(x - 0.4))));
	out[o + 3] = 255;
}

function resize() {
	const c = canvasEl.value; if (!c) return;
	const r = c.getBoundingClientRect();
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	c.width = Math.max(1, Math.floor(r.width * dpr));
	c.height = Math.max(1, Math.floor(r.height * dpr));
	ctx = c.getContext('2d');
	if (ctx) ctx.scale(dpr, dpr);
	draw();
}

// Plot-area margins for axis ticks — mirrors ForceChart.vue's ML/MR/MT/MB convention at a
// smaller scale (this is a compact canvas panel, not a full chart). ML holds the y-axis
// (Hz or dB) numbers, MB holds the x-axis (time or Hz) numbers.
let ML = 32, MR = 6, MT = 4, MB = 14;
// The power spectrum has axis titles (a row above the plot, one below it) and wider tick labels.
function setMargins() {
	const psd = props.mode === 'psd';
	ML = psd ? 50 : 32; MR = psd ? 12 : 6; MT = psd ? 22 : 4; MB = psd ? 34 : 14;
}

// A handful of evenly-spaced tick values — simpler than ForceChart's "nice round step" search,
// which isn't worth importing here for 3-4 ticks over a small, fixed-shape panel.
function tickVals(min: number, max: number, count: number): number[] {
	if (!(max > min)) return [min];
	const out: number[] = [];
	for (let k = 0; k <= count; k++) out.push(min + (k / count) * (max - min));
	return out;
}
function fmtTick(v: number): string {
	const av = Math.abs(v);
	if (av >= 1000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`;
	if (av >= 10 || Number.isInteger(v)) return String(Math.round(v));
	return v.toFixed(1);
}
// Draws tick marks + numbers along the left (y) and bottom (x) edges of the plot rect
// [ML, MT, ML+plotW, MT+plotH]. yUnit label goes above the y ticks (there's no separate
// chart-head row here, unlike ForceChart.vue, so it shares the corner with the mode label).
function drawAxes(W: number, H: number, plotW: number, plotH: number, xMin: number, xMax: number, yMin: number, yMax: number) {
	if (!ctx) return;
	const pal = palette();
	ctx.strokeStyle = pal.text; ctx.fillStyle = pal.text; ctx.font = '9px system-ui'; ctx.lineWidth = 0.75;
	for (const v of tickVals(yMin, yMax, 3)) {
		const y = MT + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
		ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + plotW, y); ctx.stroke();
		ctx.globalAlpha = 1; ctx.textAlign = 'right'; ctx.fillText(fmtTick(v), ML - 3, y + 3);
	}
	for (const v of tickVals(xMin, xMax, 4)) {
		const x = ML + ((v - xMin) / (xMax - xMin || 1)) * plotW;
		ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, MT + plotH); ctx.stroke();
		ctx.globalAlpha = 1; ctx.textAlign = 'center'; ctx.fillText(fmtTick(v), x, H - 3);
	}
	ctx.strokeStyle = pal.textFaint; ctx.globalAlpha = 0.6;
	ctx.beginPath(); ctx.moveTo(ML, MT); ctx.lineTo(ML, MT + plotH); ctx.lineTo(ML + plotW, MT + plotH); ctx.stroke();
	ctx.globalAlpha = 1; ctx.textAlign = 'left';
}

// Crosshair + value readout under the cursor, drawn last (on top of everything else) so it's
// always visible. `hover` is null whenever the cursor is outside the plot rect or has left.
function drawHover(W: number, H: number) {
	if (!ctx || !hover.value) return;
	const pal = palette();
	const plotW = Math.max(1, W - ML - MR), plotH = Math.max(1, H - MT - MB);
	const { x, y, text } = hover.value;
	ctx.strokeStyle = pal.textFaint; ctx.globalAlpha = 0.5; ctx.lineWidth = 0.75;
	ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, MT + plotH); ctx.stroke();
	if (y >= MT && y <= MT + plotH) { ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + plotW, y); ctx.stroke(); }
	ctx.globalAlpha = 1;
	ctx.font = '10px system-ui';
	const tw = ctx.measureText(text).width;
	const tx = Math.min(W - tw - 6, Math.max(ML + 2, x + 6));
	const ty = Math.max(MT + 10, y - 6);
	ctx.fillStyle = pal.bg; ctx.globalAlpha = 0.75; ctx.fillRect(tx - 3, ty - 10, tw + 6, 13);
	ctx.globalAlpha = 1; ctx.fillStyle = pal.text; ctx.textAlign = 'left'; ctx.fillText(text, tx, ty);
}

// Time-averaged dB per frequency bin (what the power view plots), cached per grid.
const psdCache = new WeakMap<Grid, number[]>();
function psdOf(g: Grid): number[] {
	let v = psdCache.get(g);
	if (!v) {
		const nT = g.t.length;
		v = g.S.map((row) => { let s = 0; for (let ti = 0; ti < nT; ti++) s += row[ti]; return s / nT; });
		psdCache.set(g, v);
	}
	return v;
}
// Each grid is in dB relative to its own peak, so a filtered grid is moved onto the raw one's scale
// with the services' `ref_db` (filtered_db + filtered_ref - raw_ref); without it (an older service)
// the filtered trace is drawn alone, relative to its own peak.
function usableRaw(): Grid | null {
	const r = rawGrid.value, g = grid.value;
	return r && r.S.length && g && r.ref_db != null && g.ref_db != null && chainActive(props.chain) ? r : null;
}
function psdOffset(g: Grid): number {
	const r = usableRaw();
	return r && g !== r ? g.ref_db! - r.ref_db! : 0;
}
// Log frequency axis from the decade of the first non-zero bin (never below 1 Hz) to Nyquist.
function psdFreqRange(g: Grid): [number, number] {
	const lo = Math.max(1, 10 ** Math.floor(Math.log10(g.f.find((v) => v > 0) ?? 1)));
	return [lo, Math.max(lo * 10, g.f[g.f.length - 1] ?? g.fmax)];
}
function psdFreqAt(g: Grid, frac: number): number {
	const [a, b] = psdFreqRange(g);
	return 10 ** (Math.log10(a) + Math.min(1, Math.max(0, frac)) * (Math.log10(b) - Math.log10(a)));
}

// The power spectrum: dB against log frequency on one axis pair, stop bands under the lines.
function drawPsd(g: Grid, W: number, H: number, plotW: number, plotH: number, stroke: string) {
	if (!ctx) return;
	const pal = palette();
	const [xLo, xHi] = psdFreqRange(g);
	const l0 = Math.log10(xLo), l1 = Math.log10(xHi);
	const sx = (f: number) => ML + ((Math.log10(Math.max(f, xLo)) - l0) / (l1 - l0)) * plotW;
	const yScale = niceScale(-80, 0, 5);
	const sy = (db: number) => MT + plotH - ((Math.max(db, yScale.lo) - yScale.lo) / (yScale.hi - yScale.lo)) * plotH;
	const gridCol = pal.grid || pal.text;
	ctx.font = '11px system-ui'; ctx.lineWidth = 1;
	// filter stop bands
	if (props.filterBands && chainActive(props.chain)) {
		let lastEnd = -Infinity;
		for (const b of stopBands(props.chain, { nyquist: xHi, rpm: props.rpm })) {
			const xa = b.f0 <= xLo ? ML : sx(b.f0), xb = Math.min(ML + plotW, sx(b.f1));
			if (!(xb - xa >= 1)) continue;
			ctx.fillStyle = pal.text; ctx.globalAlpha = 0.12; ctx.fillRect(xa, MT, xb - xa, plotH);
			const tw = ctx.measureText(b.label).width, atEnd = tw > ML + plotW - xa - 8;
			const tx = atEnd ? ML + plotW - 4 - tw : xa + 4;
			if (tx > lastEnd + 4) {
				ctx.globalAlpha = 1; ctx.textAlign = 'left'; ctx.fillStyle = pal.text; ctx.fillText(b.label, tx, MT + 13);
				lastEnd = tx + tw;
			}
		}
		ctx.globalAlpha = 1;
	}
	// grid: faint 2-9 lines, then a line at every labelled tick
	const lt = logTicks(xLo, xHi);
	ctx.strokeStyle = gridCol;
	ctx.globalAlpha = 0.12;
	for (const f of lt.minor) { const x = sx(f); ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, MT + plotH); ctx.stroke(); }
	ctx.globalAlpha = 0.25;
	for (const f of lt.major) { const x = sx(f); ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, MT + plotH); ctx.stroke(); }
	for (const v of yScale.ticks) { const y = sy(v); ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + plotW, y); ctx.stroke(); }
	ctx.globalAlpha = 1;
	// traces: raw faint behind, filtered (or the only one) solid
	const trace = (db: number[], gf: number[], alpha: number, offset: number) => {
		ctx!.strokeStyle = stroke; ctx!.globalAlpha = alpha; ctx!.lineWidth = 1.5; ctx!.beginPath();
		let started = false;
		for (let fi = 0; fi < gf.length; fi++) {
			if (!(gf[fi] >= xLo)) continue;
			const x = sx(gf[fi]), y = sy(db[fi] + offset);
			started ? ctx!.lineTo(x, y) : ctx!.moveTo(x, y); started = true;
		}
		ctx!.stroke(); ctx!.globalAlpha = 1; ctx!.lineWidth = 1;
	};
	const raw = usableRaw();
	if (raw) trace(psdOf(raw), raw.f, 0.35, 0);
	trace(psdOf(g), g.f, 1, psdOffset(g));
	// axes with 4px outward ticks, labels, titles
	ctx.strokeStyle = pal.textFaint; ctx.fillStyle = pal.text; ctx.globalAlpha = 1;
	ctx.beginPath(); ctx.moveTo(ML, MT); ctx.lineTo(ML, MT + plotH); ctx.lineTo(ML + plotW, MT + plotH); ctx.stroke();
	ctx.textAlign = 'right';
	const yl = axisLabels(yScale.ticks);
	yScale.ticks.forEach((v, i) => { const y = sy(v); ctx!.beginPath(); ctx!.moveTo(ML - 4, y); ctx!.lineTo(ML, y); ctx!.stroke(); ctx!.fillText(yl[i], ML - 7, y + 4); });
	ctx.textAlign = 'center';
	for (const f of lt.major) { const x = sx(f); ctx.beginPath(); ctx.moveTo(x, MT + plotH); ctx.lineTo(x, MT + plotH + 4); ctx.stroke(); ctx.fillText(fmtFreq(f), x, MT + plotH + 16); }
	ctx.font = '600 11px system-ui';
	ctx.fillText('Frequency (Hz)', ML + plotW / 2, H - 6);
	ctx.textAlign = 'left'; ctx.fillText(raw ? 'Magnitude (dB re raw peak)' : 'Magnitude (dB re peak)', 4, 13);
	ctx.font = '11px system-ui';
	label(`${props.axis}${raw ? ' · filtered, raw faint' : ''}`, stroke, W - MR, 'right');
}

function draw() {
	setMargins();
	const c = canvasEl.value; if (!c || !ctx) return;
	const W = c.clientWidth, H = c.clientHeight;
	const pal = palette();
	ctx.clearRect(0, 0, W, H);
	ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H);
	const g = grid.value;
	if (loading.value && !g) return note('computing spectrum…');
	if (err.value) return note(err.value);
	if (!g || !g.S.length || !g.t.length) return note('no spectrum');

	const nF = g.f.length, nT = g.t.length;
	const stroke = resolveColor(props.color) || '#38bdf8';
	const plotW = Math.max(1, W - ML - MR), plotH = Math.max(1, H - MT - MB);
	const fMax = g.f[nF - 1] ?? g.fmax;

	if (props.mode === 'spectrogram') {
		if (!offCtx) return;
		off.width = nT; off.height = nF;
		const img = offCtx.createImageData(nT, nF);
		for (let fi = 0; fi < nF; fi++) {
			const row = g.S[fi];
			const y = nF - 1 - fi;                 // low freq at the bottom
			for (let ti = 0; ti < nT; ti++) color(row[ti], img.data, (y * nT + ti) * 4);
		}
		offCtx.putImageData(img, 0, 0);
		ctx.imageSmoothingEnabled = true;
		ctx.drawImage(off, 0, 0, nT, nF, ML, MT, plotW, plotH);
		drawAxes(W, H, plotW, plotH, g.t[0], g.t[nT - 1], 0, fMax);
		label(`${props.axis} spectrogram · Hz vs s · colour dB`, stroke);
		drawHover(W, H);
		return;
	}

	if (props.mode === 'psd') {
		drawPsd(g, W, H, plotW, plotH, stroke);
		drawHover(W, H);
		return;
	}

	// waterfall: stack recent time columns as offset line spectra. No numeric y-axis (the
	// vertical offset encodes recency, not a value) — only the shared frequency x-axis applies.
	const MAX = 46;
	const cols: number[] = [];
	const stride = Math.max(1, Math.floor(nT / MAX));
	for (let ti = 0; ti < nT; ti += stride) cols.push(ti);
	const top = MT + 4, bottom = MT + plotH, band = bottom - top, traceH = band * 0.34;
	for (let k = 0; k < cols.length; k++) {
		const ti = cols[k];
		const age = 1 - k / (cols.length - 1);     // newest (last) at the front/bottom
		const yBase = top + age * (band - traceH) + traceH;
		ctx.strokeStyle = stroke; ctx.globalAlpha = 0.25 + 0.75 * (1 - age); ctx.lineWidth = k === cols.length - 1 ? 1.5 : 1;
		ctx.beginPath();
		for (let fi = 0; fi < nF; fi++) {
			const db = g.S[fi][ti];
			const x = ML + (fi / (nF - 1)) * plotW;
			const y = yBase - ((db + 80) / 80) * traceH;
			fi ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
		}
		ctx.stroke();
	}
	ctx.globalAlpha = 1;
	ctx.strokeStyle = pal.text; ctx.fillStyle = pal.text; ctx.font = '9px system-ui'; ctx.lineWidth = 0.75;
	for (const v of tickVals(0, fMax, 4)) {
		const x = ML + (v / (fMax || 1)) * plotW;
		ctx.globalAlpha = 0.2; ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, MT + plotH); ctx.stroke();
		ctx.globalAlpha = 1; ctx.textAlign = 'center'; ctx.fillText(fmtTick(v), x, H - 3);
	}
	ctx.textAlign = 'left';
	label(`${props.axis} waterfall · Hz, stacked over time`, stroke);
	drawHover(W, H);
}

function note(msg: string) {
	if (!ctx) return;
	ctx.fillStyle = palette().text; ctx.font = '12px system-ui';
	ctx.fillText(msg, 12, (canvasEl.value?.clientHeight || 40) / 2);
}
function label(text: string, col: string, x = ML + 4, align: CanvasTextAlign = 'left') {
	if (!ctx) return;
	ctx.fillStyle = col; ctx.font = '11px system-ui'; ctx.textAlign = align;
	ctx.fillText(text, x, align === 'right' ? 13 : MT + 12);
	ctx.textAlign = 'left';
}

// Every keystroke in the filter chain editor changes `chain` ("2000" is four edits, 12 requests across
// the three axes, and the intermediate values 422). So a chain-only change waits for the typing to
// settle; a different file, axis or mode is a deliberate switch and loads at once.
const baseKey = () => `${props.cacheFileId}|${props.axis}|${props.mode === 'spectrogram' ? 's' : props.mode}`;
const key = () => `${baseKey()}|${JSON.stringify(props.chain)}`;
// Bands and the notch's rotation frequency are drawn from props, not loaded: redraw only.
watch(() => [props.filterBands, props.rpm, props.color], () => draw());
const CHAIN_DEBOUNCE_MS = 400;
const loadSoon = debounce(() => { void load(); }, CHAIN_DEBOUNCE_MS);
let lastBase = baseKey();
watch(key, () => {
	const base = baseKey();
	if (base !== lastBase) { lastBase = base; loadSoon.cancel(); void load(); }
	else loadSoon();
});
onMounted(() => {
	load(); resize(); ro = new ResizeObserver(resize); if (canvasEl.value) ro.observe(canvasEl.value);
	themeObserver = new MutationObserver(draw);
	themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
});
onBeforeUnmount(() => {
	ro?.disconnect(); themeObserver?.disconnect();
	loadSoon.cancel(); loadAbort?.abort(); loadAbort = null; rawAbort?.abort(); ++reqId;   // nothing may land after unmount
});
</script>

<template>
	<div class="spec-view"><canvas ref="canvasEl" @mousemove="onHoverMove" @mouseleave="onHoverLeave"></canvas></div>
</template>

<style scoped>
.spec-view { width: 100%; height: 100%; min-height: 160px; border-radius: 8px; overflow: hidden; background: var(--plot-bg, #0b1020); }
.spec-view canvas { width: 100%; height: 100%; display: block; cursor: crosshair; }
</style>
