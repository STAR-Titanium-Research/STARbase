<script setup lang="ts">
/*
 * Dependency-free multi-series line chart for FAST traces (time on x). Each series
 * carries its own values + unit/group + colour. Y handling:
 *   - all visible series share one unit  -> a real shared y-axis (auto-fit union)
 *   - mixed units (or `normalise`)        -> each series normalised to its own
 *     [min,max] and overlaid, so you compare SHAPES; the legend shows real min/max.
 * Ports the force chart's niceStep/regularTicks tick math. Hover scrubs a shared
 * cursor and shows each series' value at that time.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

interface S { key: string; label: string; unit: string; group: string; color: string; values: Float64Array; }
const props = defineProps<{
	time: Float64Array; series: S[]; normalise?: boolean;
	viewStart?: number | null;    // shared x-zoom window (seconds); null = full range
	viewEnd?: number | null;
	zoomTool?: boolean;           // when true, drag draws a rectangular zoom box
}>();
const emit = defineEmits<{ (e: 'zoom', v: { start: number; end: number } | null): void }>();

const ML = 48, MR = 12, MT = 10, MB = 22;
// Observe the CSS-sized wrapper (plotEl), not the svg itself — see the template
// comment on .fchart-plot for why observing the svg directly causes runaway growth.
const plotEl = ref<HTMLDivElement | null>(null);
const w = ref(360), h = ref(200);
let ro: ResizeObserver | undefined;
onMounted(() => {
	ro = new ResizeObserver((e) => {
		const r = e[0].contentRect;
		if (r.width > 0) w.value = Math.round(r.width);
		if (r.height > 0) h.value = Math.round(r.height);
	});
	if (plotEl.value) ro.observe(plotEl.value);
});
onBeforeUnmount(() => ro?.disconnect());

function niceNum(v: number): string {
	const a = Math.abs(v);
	if (a === 0) return '0';
	if (a >= 1000) return `${(v / 1000).toFixed(1)}k`;
	if (a >= 100) return v.toFixed(0);
	if (a >= 10) return v.toFixed(1);
	if (a >= 1) return v.toFixed(2);
	if (a >= 0.01) return v.toFixed(3);
	return v.toExponential(0);
}
function niceStep(rough: number): number {
	if (!(rough > 0)) return 1;
	const pow = 10 ** Math.floor(Math.log10(rough));
	const f = rough / pow;
	const nice = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
	return nice * pow;
}
function extent(vals: Float64Array): [number, number] {
	let lo = Infinity, hi = -Infinity;
	for (let i = 0; i < vals.length; i++) { const v = vals[i]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
	if (!Number.isFinite(lo)) return [0, 1];
	if (lo === hi) { lo -= 1; hi += 1; }
	return [lo, hi];
}

const shared = computed(() => {
	if (props.normalise || props.series.length === 0) return false;
	const g = new Set(props.series.map((s) => s.unit || s.group));
	return g.size === 1;
});

// extent over a sub-range [iA,iB] (inclusive) so y auto-rescales to the zoom window
function extentRange(vals: Float64Array, iA: number, iB: number): [number, number] {
	let lo = Infinity, hi = -Infinity;
	for (let i = iA; i <= iB; i++) { const v = vals[i]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
	if (!Number.isFinite(lo)) return [0, 1];
	if (lo === hi) { lo -= 1; hi += 1; }
	return [lo, hi];
}

const geom = computed(() => {
	const t = props.time;
	if (!t || t.length < 2 || props.series.length === 0) return null;
	const W = w.value, H = h.value;
	const plotW = W - ML - MR, plotH = H - MT - MB;

	// visible x-window (shared zoom): clamp to the requested bounds, then snap the
	// index range so the y-axis rescales to just the zoomed data.
	const dataX0 = t[0], dataX1 = t[t.length - 1] || 1;
	let x0 = props.viewStart != null ? Math.max(dataX0, props.viewStart) : dataX0;
	let x1 = props.viewEnd != null ? Math.min(dataX1, props.viewEnd) : dataX1;
	if (!(x1 > x0)) { x0 = dataX0; x1 = dataX1; }
	let iA = 0, iB = t.length - 1;
	while (iA < iB && t[iA + 1] < x0) iA++;
	while (iB > iA && t[iB - 1] > x1) iB--;
	const sx = (x: number) => ML + ((x - x0) / (x1 - x0)) * plotW;

	// shared axis range (only meaningful when `shared`) — over the visible window
	let lo = Infinity, hi = -Infinity;
	if (shared.value) {
		for (const s of props.series) { const [a, b] = extentRange(s.values, iA, iB); if (a < lo) lo = a; if (b > hi) hi = b; }
		if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
		lo = Math.min(lo, 0);
	}
	const syShared = (v: number) => MT + (1 - (v - lo) / (hi - lo || 1)) * plotH;

	// build a polyline for each series (normalised per-series unless shared), over
	// the visible index window so a zoom both crops x and rescales y.
	const paths = props.series.map((s) => {
		const [smin, smax] = extentRange(s.values, iA, iB);
		const span = smax - smin || 1;
		const sy = shared.value ? syShared : (v: number) => MT + (1 - (v - smin) / span) * plotH;
		let d = '', pen = false;
		const vals = s.values, n = Math.min(t.length, vals.length), hiIdx = Math.min(iB, n - 1);
		// decimate to ~2px columns for speed on long traces
		const stride = Math.max(1, Math.floor((hiIdx - iA + 1) / Math.max(1, plotW * 1.5)));
		for (let i = iA; i <= hiIdx; i += stride) {
			const v = vals[i];
			if (!Number.isFinite(v)) { pen = false; continue; }
			const X = sx(t[i]).toFixed(1), Y = sy(v).toFixed(1);
			d += pen ? `L${X},${Y} ` : `M${X},${Y} `;
			pen = true;
		}
		return { key: s.key, color: s.color, d, smin, smax, unit: s.unit, label: s.label };
	});

	// x ticks — plot tiles here can be resized much narrower than a fixed force
	// chart, so unlike a static minimum this scales down with plotW (floor of 2)
	// to avoid labels colliding in a small tile.
	const targetCount = Math.max(2, Math.min(10, Math.floor(plotW / 70)));
	const step = niceStep((x1 - x0) / targetCount) || (x1 - x0) || 1;
	const xticks: { x: number; label: string }[] = [];
	const first = Math.ceil(x0 / step) * step;
	for (let v = first; v <= x1 + step * 1e-6; v += step) xticks.push({ x: sx(v), label: niceNum(v) });
	if (xticks.length < 2) { xticks.length = 0; xticks.push({ x: sx(x0), label: niceNum(x0) }, { x: sx(x1), label: niceNum(x1) }); }

	const yticks = shared.value
		? [hi, (lo + hi) / 2, lo].map((v) => ({ y: syShared(v), label: niceNum(v) }))
		: [1, 0.5, 0].map((f) => ({ y: MT + (1 - f) * plotH, label: `${Math.round(f * 100)}%` }));

	return { W, H, plotW, plotH, x0, x1, sx, paths, xticks, yticks };
});

// hover scrub
const hoverX = ref<number | null>(null);
const hoverI = computed(() => {
	const g = geom.value; if (!g || hoverX.value == null) return null;
	const frac = (hoverX.value - ML) / g.plotW;
	if (frac < 0 || frac > 1) return null;
	// map the cursor to a time within the visible [x0,x1] window, then to an index
	// (time is ~uniformly sampled), so hover stays correct when zoomed.
	const t = props.time; const x = g.x0 + frac * (g.x1 - g.x0);
	const span = (t[t.length - 1] - t[0]) || 1;
	return Math.max(0, Math.min(t.length - 1, Math.round((x - t[0]) / span * (t.length - 1))));
});
function onMove(ev: MouseEvent) {
	const g = geom.value; if (!g) return;
	const r = (ev.currentTarget as SVGElement).getBoundingClientRect();
	hoverX.value = (ev.clientX - r.left) * (g.W / r.width);
}
function onLeave() { hoverX.value = null; }
const yUnitLabel = computed(() => (shared.value ? (props.series[0]?.unit || '') : 'norm'));

// ---- x-zoom: wheel + rectangular selection (emits a shared window to the parent) ----
function pxOf(ev: PointerEvent | WheelEvent): number {
	const g = geom.value; if (!g) return 0;
	const r = (ev.currentTarget as SVGElement).getBoundingClientRect();
	return ((ev as any).clientX - r.left) * (g.W / r.width);
}
function fracToX(frac: number): number {
	const g = geom.value!;
	return g.x0 + Math.min(1, Math.max(0, frac)) * (g.x1 - g.x0);
}
const zoomRect = ref<{ x: number; w: number } | null>(null);
let zoomDrag = false, zStartPx = 0;
function onZoomDown(ev: PointerEvent) {
	if (!props.zoomTool || !geom.value) return;
	zoomDrag = true; zStartPx = pxOf(ev); zoomRect.value = { x: zStartPx, w: 0 };
	(ev.currentTarget as Element).setPointerCapture(ev.pointerId);
}
function onZoomMove(ev: PointerEvent) {
	if (!zoomDrag) return;
	const px = pxOf(ev);
	zoomRect.value = { x: Math.min(px, zStartPx), w: Math.abs(px - zStartPx) };
}
function onZoomUp(ev: PointerEvent) {
	if (!zoomDrag) return;
	zoomDrag = false;
	const g = geom.value, rsel = zoomRect.value;
	zoomRect.value = null;
	try { (ev.currentTarget as Element).releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
	if (!g || !rsel || rsel.w < 6) return;
	const clamp = (px: number) => (px - ML) / (g.W - ML - MR);
	const s = fracToX(clamp(rsel.x)), e = fracToX(clamp(rsel.x + rsel.w));
	if (e > s) emit('zoom', { start: s, end: e });
}
function onWheel(ev: WheelEvent) {
	const g = geom.value; if (!g) return;
	ev.preventDefault();
	const frac = (pxOf(ev) - ML) / (g.W - ML - MR);
	const cursorX = fracToX(frac);
	const t = props.time; const dataSpan = (t[t.length - 1] - t[0]) || 1;
	const f = ev.deltaY < 0 ? 1 / 1.3 : 1.3;
	const span = Math.min(dataSpan, Math.max(dataSpan / 1000, (g.x1 - g.x0) * f));
	let s = cursorX - Math.min(1, Math.max(0, frac)) * span, e = s + span;
	const dx0 = t[0], dx1 = t[t.length - 1];
	if (s < dx0) { e += dx0 - s; s = dx0; }
	if (e > dx1) { s -= e - dx1; e = dx1; }
	s = Math.max(dx0, s);
	emit('zoom', (e - s >= dataSpan * 0.999) ? null : { start: s, end: e });
}
</script>

<template>
	<div class="fchart">
		<!-- The svg is absolutely positioned (inset:0) inside a relatively-positioned,
		     flex:1 wrapper so its box size comes ONLY from CSS/flex layout, never from
		     its own viewBox-derived intrinsic aspect ratio. Without this, when an
		     ancestor's height is indefinite (mobile's stacked layout — .layout has no
		     fixed height there), the svg's "auto" height falls back to width * (its own
		     viewBox ratio); since we set that viewBox from the LAST observed size, any
		     small nudge (e.g. the legend growing when a series is added) feeds back into
		     a new, larger viewBox on the next layout pass — a runaway growth loop. The
		     wrapper carries no in-flow content, so it can't trigger that fallback. -->
		<div class="fchart-plot" ref="plotEl">
			<svg v-if="geom" :viewBox="`0 0 ${geom.W} ${geom.H}`" preserveAspectRatio="none"
				class="fchart-svg" :class="{ zoomtool: zoomTool }"
				@mousemove="onMove" @mouseleave="onLeave" @wheel="onWheel"
				@pointerdown="onZoomDown" @pointermove="onZoomMove" @pointerup="onZoomUp" @pointercancel="onZoomUp">
				<line v-for="(t, i) in geom.yticks" :key="'gy' + i" :x1="ML" :x2="geom.W - MR" :y1="t.y" :y2="t.y" stroke="#eef1f5" stroke-width="0.5" />
				<line v-for="(t, i) in geom.xticks" :key="'gx' + i" :x1="t.x" :x2="t.x" :y1="MT" :y2="geom.H - MB" stroke="#f3f5f8" stroke-width="0.5" />
				<path v-for="p in geom.paths" :key="p.key" :d="p.d" fill="none" :stroke="p.color" stroke-width="1.2" stroke-linejoin="round" />
				<line :x1="ML" :x2="ML" :y1="MT" :y2="geom.H - MB" stroke="#94a3b8" stroke-width="0.8" />
				<line :x1="ML" :x2="geom.W - MR" :y1="geom.H - MB" :y2="geom.H - MB" stroke="#94a3b8" stroke-width="0.8" />
				<g v-for="(t, i) in geom.yticks" :key="'y' + i">
					<text :x="ML - 4" :y="t.y + 2.5" text-anchor="end" class="tick">{{ t.label }}</text>
				</g>
				<g v-for="(t, i) in geom.xticks" :key="'x' + i">
					<line :x1="t.x" :x2="t.x" :y1="geom.H - MB" :y2="geom.H - MB + 3" stroke="#94a3b8" stroke-width="0.7" />
					<text :x="t.x" :y="geom.H - MB + 12" text-anchor="middle" class="tick">{{ t.label }}</text>
				</g>
				<text :x="ML - 40" :y="MT + 6" class="tick unit">{{ yUnitLabel }}</text>
				<text :x="(ML + geom.W - MR) / 2" :y="geom.H - 2" text-anchor="middle" class="tick">s</text>
				<line v-if="hoverX != null" :x1="hoverX" :x2="hoverX" :y1="MT" :y2="geom.H - MB" stroke="#64748b" stroke-width="0.6" stroke-dasharray="3 3" />
				<rect v-if="zoomRect" :x="zoomRect.x" :y="MT" :width="zoomRect.w" :height="geom.H - MB - MT" fill="#38bdf8" fill-opacity="0.16" stroke="#0ea5e9" stroke-width="0.8" />
			</svg>
			<div v-else class="fchart-empty">Right-click to pick series</div>
		</div>

		<div class="legend">
			<span v-for="s in series" :key="s.key" class="lg">
				<i :style="{ background: s.color }"></i>{{ s.label }}<em>{{ s.unit }}</em>
				<b v-if="hoverI != null && Number.isFinite(s.values[hoverI])">{{ niceNum(s.values[hoverI]) }}</b>
			</span>
		</div>
	</div>
</template>

<style scoped>
.fchart { display: flex; flex-direction: column; height: 100%; min-height: 0; }
/* flex:1 1 auto with NO in-flow content (the svg inside is position:absolute) — its
   size comes purely from flex distribution + min-height, never from intrinsic
   content/aspect-ratio, which is what keeps this stable under an indefinite-height
   ancestor (see the template comment above .fchart-plot). */
.fchart-plot { position: relative; flex: 1 1 auto; min-height: 140px; width: 100%; }
.fchart-svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: crosshair; }
.fchart-svg .tick { fill: var(--theme--foreground-subdued, #94a3b8); font-size: 8px; font-variant-numeric: tabular-nums; }
.fchart-svg .unit { font-size: 7.5px; }
.fchart-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--theme--foreground-subdued, #a4adba); font-size: 12px; }
.legend { flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 4px 6px 2px; }
.lg { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--theme--foreground, #334155); }
.lg i { width: 9px; height: 3px; border-radius: 2px; display: inline-block; }
.lg em { color: var(--theme--foreground-subdued, #98a2b3); font-style: normal; font-size: 9px; }
.lg b { font-variant-numeric: tabular-nums; font-weight: 700; }
</style>
