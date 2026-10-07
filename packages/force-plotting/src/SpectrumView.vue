<script setup lang="ts">
// Finished-cut spectral view for the plotting dashboard: fetches the STFT of one axis from the
// filter-service (/spectrogram) and renders it three ways — a time × frequency heatmap
// (spectrogram), recent spectra stacked with an offset (waterfall), or the time-averaged power
// spectrum (power, dB). Mirrors the live recording views so plotting stays at feature parity.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { type FilterChain, fetchSpectrogram } from './filterChain';
import { debounce } from './debounce';

const props = defineProps<{
	cacheFileId: string | null | undefined;
	chain: FilterChain;
	axis: string;
	mode: 'psd' | 'spectrogram' | 'waterfall';
	color?: string;
}>();

const canvasEl = ref<HTMLCanvasElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;
let ro: ResizeObserver | null = null;
const off = document.createElement('canvas');
const offCtx = off.getContext('2d');

type Grid = { f: number[]; t: number[]; S: number[][]; fmax: number };
const grid = ref<Grid | null>(null);
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
		const fi = Math.min(nF - 1, Math.max(0, Math.round(((px - ML) / plotW) * (nF - 1))));
		const row = g.S[fi];
		let db: number | null = null;
		if (row) { let s = 0; for (let ti = 0; ti < nT; ti++) s += row[ti]; db = s / nT; }
		hover.value = { x: px, y: py, text: `${Math.round(g.f[fi])}Hz${db != null ? ` · ${db.toFixed(1)}dB` : ''}` };
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
	if (!props.cacheFileId) { ++reqId; grid.value = null; loading.value = false; return; }
	const mine = ++reqId;
	const ac = new AbortController(); loadAbort = ac;
	loading.value = true; err.value = null;
	try {
		const g = await fetchSpectrogram(props.cacheFileId, props.chain, props.axis, ac.signal);
		if (mine === reqId) { grid.value = g; }
	} catch (e: any) {
		if (mine === reqId && !ac.signal.aborted) { err.value = e?.message || 'spectrogram failed'; grid.value = null; }
	} finally {
		if (mine === reqId) { loading.value = false; draw(); }
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
const ML = 32, MR = 6, MT = 4, MB = 14;

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

function draw() {
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
	const stroke = props.color || '#38bdf8';
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
		// time-averaged spectrum (mean dB across time) → single line
		ctx.strokeStyle = stroke; ctx.lineWidth = 1.3; ctx.beginPath();
		for (let fi = 0; fi < nF; fi++) {
			let s = 0; const row = g.S[fi]; for (let ti = 0; ti < nT; ti++) s += row[ti];
			const db = s / nT;                     // -80..0
			const x = ML + (fi / (nF - 1)) * plotW;
			const y = MT + plotH - ((db + 80) / 80) * plotH;
			fi ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
		}
		ctx.stroke();
		drawAxes(W, H, plotW, plotH, 0, fMax, -80, 0);
		label(`${props.axis} power (dB) vs Hz`, stroke);
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
function label(text: string, col: string) {
	if (!ctx) return;
	ctx.fillStyle = col; ctx.font = '11px system-ui'; ctx.textAlign = 'left';
	ctx.fillText(text, ML + 4, MT + 12);
	ctx.textAlign = 'left';
}

// Every keystroke in the filter chain editor changes `chain` ("2000" is four edits, 12 requests across
// the three axes, and the intermediate values 422). So a chain-only change waits for the typing to
// settle; a different file, axis or mode is a deliberate switch and loads at once.
const baseKey = () => `${props.cacheFileId}|${props.axis}|${props.mode === 'spectrogram' ? 's' : props.mode}`;
const key = () => `${baseKey()}|${JSON.stringify(props.chain)}`;
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
	loadSoon.cancel(); loadAbort?.abort(); loadAbort = null; ++reqId;   // nothing may land after unmount
});
</script>

<template>
	<div class="spec-view"><canvas ref="canvasEl" @mousemove="onHoverMove" @mouseleave="onHoverLeave"></canvas></div>
</template>

<style scoped>
.spec-view { width: 100%; height: 100%; min-height: 160px; border-radius: 8px; overflow: hidden; background: var(--plot-bg, #0b1020); }
.spec-view canvas { width: 100%; height: 100%; display: block; cursor: crosshair; }
</style>
