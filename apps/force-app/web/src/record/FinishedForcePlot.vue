<script setup lang="ts">
// Static full-resolution force trace for a completed cut — draws every sample of the finished
// live-cache (Fx/Fy/Fz vs t) once, unlike LiveForcePlot which streams a rolling window. Used
// wherever a finished recording's full time series needs to be shown (ForcePanel post-stop,
// SaveCutDialog).
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Cache } from '@d1/force-plotting';
import { channelColor } from './types';
import { theme } from '../theme';

const props = defineProps<{
	cache: Cache;
	channels?: string[];
	// Override the cache's own auto-detected csSec/ceSec for the shaded cut window — the
	// end-of-cut save dialog seeds these from csSec/ceSec but lets the operator drag them before
	// saving (#7). Falls back to the cache's own values when not given, same shading as before.
	cropStartSec?: number | null;
	cropEndSec?: number | null;
	cropEditable?: boolean;
}>();
const emit = defineEmits<{
	(e: 'update:cropStartSec', v: number): void;
	(e: 'update:cropEndSec', v: number): void;
}>();
const canvasEl = ref<HTMLCanvasElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;
let ro: ResizeObserver | null = null;

// MB fits the tick labels (4-14px below the plot) AND the axis title under them; at 22 the
// title was drawn top-aligned 4px above the canvas edge and always clipped to half its height.
const ML = 48, MR = 10, MT = 10, MB = 32;
// Updated every draw() so pointer handlers can convert canvas-local px <-> data seconds without
// redoing the layout math.
let lastT0 = 0, lastT1 = 0, lastW = 0;
function xToSec(px: number): number {
	if (lastW <= 0) return lastT0;
	const t = lastT0 + ((px - ML) / lastW) * (lastT1 - lastT0);
	return Math.min(lastT1, Math.max(lastT0, t));
}
let lastHandles: { startX: number; endX: number; top: number; bottom: number } | null = null;
let dragging: 'start' | 'end' | null = null;

function localPx(ev: PointerEvent): { x: number; y: number } {
	const r = canvasEl.value!.getBoundingClientRect();
	return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}
function onPointerDown(ev: PointerEvent) {
	if (!props.cropEditable || !lastHandles) return;
	const { x, y } = localPx(ev);
	if (y < lastHandles.top - 6 || y > lastHandles.bottom + 6) return;
	const ds = Math.abs(x - lastHandles.startX), de = Math.abs(x - lastHandles.endX);
	const nearest = ds <= de ? 'start' : 'end';
	if (Math.min(ds, de) > 10) return;   // clicked well away from either handle — not a drag
	dragging = nearest;
	(ev.target as Element).setPointerCapture(ev.pointerId);
}
function onPointerMove(ev: PointerEvent) {
	if (!dragging) return;
	const sec = xToSec(localPx(ev).x);
	if (dragging === 'start') emit('update:cropStartSec', Math.min(sec, props.cropEndSec ?? sec));
	else emit('update:cropEndSec', Math.max(sec, props.cropStartSec ?? sec));
}
function onPointerUp() { dragging = null; }

function resize() {
	const c = canvasEl.value;
	if (!c) return;
	const r = c.getBoundingClientRect();
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	c.width = Math.max(1, Math.floor(r.width * dpr));
	c.height = Math.max(1, Math.floor(r.height * dpr));
	ctx = c.getContext('2d');
	if (ctx) ctx.scale(dpr, dpr);
	draw();
}

function palette() {
	const s = getComputedStyle(document.documentElement);
	return {
		bg: s.getPropertyValue('--plot-bg').trim() || '#0b1020',
		grid: s.getPropertyValue('--border').trim() || 'rgba(255,255,255,0.06)',
		axisLine: s.getPropertyValue('--border-2').trim() || 'rgba(255,255,255,0.2)',
		text: s.getPropertyValue('--text-dim').trim() || 'rgba(226,232,240,0.55)',
		textFaint: s.getPropertyValue('--text-faint').trim() || 'rgba(226,232,240,0.45)',
	};
}

function niceStep(range: number, ticks: number): number {
	const raw = range / ticks;
	const mag = Math.pow(10, Math.floor(Math.log10(raw)));
	const r = raw / mag;
	return (r <= 1.5 ? 1 : r <= 3 ? 2 : r <= 7 ? 5 : 10) * mag;
}

function seriesOf(key: string): Float32Array | undefined {
	const c = props.cache;
	return key === 'Fx' ? c.Fx : key === 'Fy' ? c.Fy : key === 'Fz' ? c.Fz : undefined;
}

function draw() {
	const c = canvasEl.value;
	if (!c || !ctx) return;
	const CW = c.clientWidth, CH = c.clientHeight;
	if (CW === 0 || CH === 0) return;
	const pal = palette();
	const W = CW - ML - MR, H = CH - MT - MB;
	ctx.clearRect(0, 0, CW, CH);
	ctx.fillStyle = pal.bg;
	ctx.fillRect(0, 0, CW, CH);

	const cache = props.cache;
	const n = cache.t.length;
	const sel = (props.channels ?? ['Fx', 'Fy', 'Fz']).filter((k) => k === 'Fx' || k === 'Fy' || k === 'Fz');

	if (n < 2) {
		ctx.fillStyle = pal.text; ctx.font = '12px system-ui';
		ctx.fillText('no data', ML + 8, MT + H / 2);
		return;
	}

	const t0 = cache.t[0], t1 = cache.t[n - 1];
	const span = Math.max(1e-3, t1 - t0);
	const series = sel.map((k) => [k, seriesOf(k)!] as const).filter(([, a]) => a && a.length > 0);
	let lo = Infinity, hi = -Infinity;
	for (const [, a] of series) for (let i = 0; i < a.length; i++) { const v = a[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
	if (!isFinite(lo) || !isFinite(hi)) { lo = -1; hi = 1; }
	const pad = 0.1 * (hi - lo || 1);
	lo -= pad; hi += pad;
	const yr = hi - lo || 1;

	const xOf = (t: number) => ML + ((t - t0) / span) * W;
	const yOf = (v: number) => MT + H - ((v - lo) / yr) * H;
	lastT0 = t0; lastT1 = t1; lastW = W;

	ctx.font = '10px system-ui'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
	const yStep = niceStep(yr, Math.max(2, Math.floor(H / 50)));
	const yStart = Math.ceil(lo / yStep) * yStep;
	ctx.strokeStyle = pal.grid; ctx.lineWidth = 1;
	for (let v = yStart; v <= hi; v += yStep) {
		const y = yOf(v);
		if (y < MT || y > MT + H) continue;
		ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + W, y); ctx.stroke();
		ctx.fillStyle = pal.text;
		ctx.fillText(Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : Number.isInteger(v) ? String(v) : v.toFixed(1), ML - 5, y);
	}

	ctx.textAlign = 'center'; ctx.textBaseline = 'top';
	const xStep = niceStep(span, Math.max(2, Math.floor(W / 80)));
	const xStart = Math.ceil(t0 / xStep) * xStep;
	for (let t = xStart; t <= t1; t += xStep) {
		const x = xOf(t);
		if (x < ML || x > ML + W) continue;
		ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, MT + H); ctx.stroke();
		ctx.fillStyle = pal.text;
		ctx.fillText(t.toFixed(t >= 100 ? 0 : 1), x, MT + H + 4);
	}

	ctx.fillStyle = pal.textFaint; ctx.font = '10px system-ui';
	ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
	ctx.fillText('Time (s)', ML + W / 2, CH - 2);
	ctx.save(); ctx.translate(10, MT + H / 2); ctx.rotate(-Math.PI / 2);
	ctx.textBaseline = 'middle'; ctx.fillText('Force (N)', 0, 0); ctx.restore();

	if (lo < 0 && hi > 0) { ctx.strokeStyle = pal.axisLine; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(ML, yOf(0)); ctx.lineTo(ML + W, yOf(0)); ctx.stroke(); }

	// Cut window shading — props override the cache's own auto-detected csSec/ceSec when given
	// (the save dialog's editable crop), otherwise this is exactly the old read-only display.
	const csSec = props.cropStartSec ?? cache.csSec;
	const ceSec = props.cropEndSec ?? cache.ceSec;
	if (ceSec > csSec) {
		ctx.fillStyle = 'rgba(74,222,128,0.06)';
		ctx.fillRect(xOf(csSec), MT, xOf(ceSec) - xOf(csSec), H);
	}

	for (const [key, arr] of series) {
		const col = channelColor(key, theme.value) ?? '#94a3b8';
		ctx.globalAlpha = 0.9; ctx.strokeStyle = col; ctx.lineWidth = 1.2;
		ctx.beginPath();
		for (let i = 0; i < n; i++) { const x = xOf(cache.t[i]); const y = yOf(arr[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
		ctx.stroke();
	}
	ctx.globalAlpha = 1;

	if (props.cropEditable && ceSec > csSec) {
		lastHandles = { startX: xOf(csSec), endX: xOf(ceSec), top: MT, bottom: MT + H };
		for (const [x, col] of [[lastHandles.startX, '#0f766e'], [lastHandles.endX, '#b91c1c']] as const) {
			ctx.strokeStyle = col; ctx.lineWidth = 2;
			ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, MT + H); ctx.stroke();
		}
	} else {
		lastHandles = null;
	}
}

watch(() => props.cache, () => draw());
watch(() => props.channels, () => draw());
watch(() => [props.cropStartSec, props.cropEndSec], () => draw());
watch(theme, () => draw());

onMounted(() => { resize(); window.addEventListener('resize', resize); ro = new ResizeObserver(resize); if (canvasEl.value) ro.observe(canvasEl.value); nextTick(resize); });
onBeforeUnmount(() => { window.removeEventListener('resize', resize); ro?.disconnect(); });
</script>

<template>
	<div class="finished-force" :class="{ editable: cropEditable }">
		<canvas ref="canvasEl" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp"></canvas>
		<div class="legend">
			<span v-for="k in (channels ?? ['Fx', 'Fy', 'Fz'])" :key="k" class="lg" :style="{ color: channelColor(k, theme) }">
				<i :style="{ background: channelColor(k, theme) }"></i>{{ k }}
			</span>
		</div>
	</div>
</template>

<style scoped>
.finished-force { position: relative; width: 100%; height: 100%; min-height: 160px; border-radius: 8px; overflow: hidden; background: var(--plot-bg); }
.finished-force canvas { width: 100%; height: 100%; display: block; }
.finished-force.editable canvas { cursor: ew-resize; }
.legend { position: absolute; top: 6px; right: 8px; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px 8px; font-size: var(--fs-xs); font-weight: 600; max-width: 60%; padding: 2px 6px; border-radius: 6px; background: color-mix(in srgb, var(--plot-bg) 85%, transparent); }
.lg i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 3px; vertical-align: middle; }
</style>
