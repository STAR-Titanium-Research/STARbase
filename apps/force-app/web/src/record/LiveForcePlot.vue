<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { RecordClient } from './liveClient';
import { channelColor } from './types';
import { theme } from '../theme';

const props = defineProps<{ client: RecordClient; channels?: string[] }>();
type Env = [number, number][];
function envOf(key: string): Env {
	const tr = props.client.trace;
	return key === 'Fx' ? tr.fx : key === 'Fy' ? tr.fy : key === 'Fz' ? tr.fz : (tr.sub[key] ?? []);
}
const canvasEl = ref<HTMLCanvasElement | null>(null);
let raf = 0;
let ctx: CanvasRenderingContext2D | null = null;
let ro: ResizeObserver | null = null;

// MB fits the tick labels (4-14px below the plot) AND the axis title under them; at 22 the
// title was drawn top-aligned 4px above the canvas edge and always clipped to half its height.
const ML = 48, MR = 10, MT = 10, MB = 32;

function resize() {
	const c = canvasEl.value;
	if (!c) return;
	const r = c.getBoundingClientRect();
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	c.width = Math.max(1, Math.floor(r.width * dpr));
	c.height = Math.max(1, Math.floor(r.height * dpr));
	ctx = c.getContext('2d');
	if (ctx) ctx.scale(dpr, dpr);
	lastN = -1;   // force the next draw() past the unchanged-data skip so the resized canvas repaints
}

// Resolved once per draw (cheap relative to path-building below) rather than cached across theme
// changes, since getComputedStyle already reflects the DOM's current [data-theme] attribute.
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

// The trace only grows a point every chunk (well under 60Hz), but this redraws the FULL history
// each time — path-building cost climbs with the recording's length. Left running at 60fps
// regardless of whether new data arrived, that's mostly wasted CPU repainting an unchanged plot,
// and on slower hardware it's enough sustained main-thread work to make the live view visibly
// stop keeping up ("doesn't update") as a long cut goes on. Skipping frames where nothing changed
// costs nothing lost (the plot did not change) and removes nearly all of that waste.
let lastN = -1, lastT = NaN, lastSel = '';
function draw() {
	raf = requestAnimationFrame(draw);
	const c = canvasEl.value;
	if (!c || !ctx) return;
	const CW = c.clientWidth, CH = c.clientHeight;
	if (CW === 0 || CH === 0) { resize(); return; }

	const tr = props.client.trace;
	const n = tr.t.length;
	const sel = props.channels ?? ['Fx', 'Fy', 'Fz'];
	const selKey = sel.join(',');
	const lastPt = n ? tr.t[n - 1] : NaN;
	if (n === lastN && lastPt === lastT && selKey === lastSel) return;
	lastN = n; lastT = lastPt; lastSel = selKey;

	const pal = palette();
	const W = CW - ML - MR, H = CH - MT - MB;
	ctx.clearRect(0, 0, CW, CH);
	ctx.fillStyle = pal.bg;
	ctx.fillRect(0, 0, CW, CH);

	if (n < 2) {
		ctx.fillStyle = pal.text; ctx.font = '12px system-ui';
		ctx.fillText('waiting for data…', ML + 8, MT + H / 2);
		return;
	}

	const t0 = tr.t[0], t1 = tr.t[n - 1];
	const span = Math.max(1e-3, t1 - t0);
	const series = sel.map((k) => [k, envOf(k)] as const).filter(([, arr]) => arr.length > 0);
	let lo = Infinity, hi = -Infinity;
	for (const [, arr] of series) for (const [mn, mx] of arr) { if (mn < lo) lo = mn; if (mx > hi) hi = mx; }
	if (!isFinite(lo) || !isFinite(hi)) { lo = -1; hi = 1; }
	const pad = 0.1 * (hi - lo || 1);
	lo -= pad; hi += pad;
	const yr = hi - lo || 1;

	const xOf = (t: number) => ML + ((t - t0) / span) * W;
	const yOf = (v: number) => MT + H - ((v - lo) / yr) * H;

	// Grid + Y-axis ticks
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

	// X-axis ticks
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

	// Axis labels
	ctx.fillStyle = pal.textFaint; ctx.font = '10px system-ui';
	ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
	ctx.fillText('Time (s)', ML + W / 2, CH - 2);
	ctx.save(); ctx.translate(10, MT + H / 2); ctx.rotate(-Math.PI / 2);
	ctx.textBaseline = 'middle'; ctx.fillText('Force (N)', 0, 0); ctx.restore();

	// Zero line
	if (lo < 0 && hi > 0) { ctx.strokeStyle = pal.axisLine; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(ML, yOf(0)); ctx.lineTo(ML + W, yOf(0)); ctx.stroke(); }

	// Plot data
	for (const [key, arr] of series) {
		const col = channelColor(key, theme.value) ?? '#94a3b8';
		ctx.beginPath();
		for (let i = 0; i < n; i++) { const x = xOf(tr.t[i]); const y = yOf(arr[i][1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
		for (let i = n - 1; i >= 0; i--) ctx.lineTo(xOf(tr.t[i]), yOf(arr[i][0]));
		ctx.closePath();
		ctx.globalAlpha = 0.16; ctx.fillStyle = col; ctx.fill();
		ctx.globalAlpha = 0.9; ctx.strokeStyle = col; ctx.lineWidth = 1.4;
		ctx.beginPath();
		for (let i = 0; i < n; i++) { const x = xOf(tr.t[i]); const y = yOf(arr[i][1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
		ctx.stroke();
	}
	ctx.globalAlpha = 1;
}

// Theme toggle changes the resolved palette but not n/t/channels, so the unchanged-data skip in
// draw() would otherwise leave the canvas on the old theme's colours until the next real update.
watch(theme, () => { lastN = -1; });

onMounted(() => { resize(); window.addEventListener('resize', resize); ro = new ResizeObserver(resize); if (canvasEl.value) ro.observe(canvasEl.value); draw(); nextTick(resize); });
onBeforeUnmount(() => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); ro?.disconnect(); });
</script>

<template>
	<div class="live-force">
		<canvas ref="canvasEl"></canvas>
		<div class="legend">
			<span v-for="k in (channels ?? ['Fx', 'Fy', 'Fz'])" :key="k" class="lg" :style="{ color: channelColor(k, theme) }">
				<i :style="{ background: channelColor(k, theme) }"></i>{{ k }}
			</span>
		</div>
	</div>
</template>

<style scoped>
.live-force { position: relative; width: 100%; height: 100%; min-height: 160px; border-radius: 8px; overflow: hidden; background: var(--plot-bg); }
.live-force canvas { width: 100%; height: 100%; display: block; }
.legend { position: absolute; top: 6px; right: 8px; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px 8px; font-size: var(--fs-xs); font-weight: 600; max-width: 60%; padding: 2px 6px; border-radius: 6px; background: color-mix(in srgb, var(--plot-bg) 85%, transparent); }
.lg i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 3px; vertical-align: middle; }
</style>
