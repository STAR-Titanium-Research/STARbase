<script setup lang="ts">
/*
 * Dependency-free multi-series line chart for FAST traces (time on x). Each series carries its own
 * values + unit/group. Y handling:
 *   - all visible series share one unit  -> a real shared y-axis (auto-fit union)
 *   - mixed units (or `normalise`)        -> each series normalised to its own [min,max] and
 *     overlaid, so you compare SHAPES (the axis then reads "% of range")
 * Look per DESIGN.md section 5b: solid left and bottom axis lines with outward ticks, hairline grid at
 * every tick, nice ticks with the top one above the data, the unit above the y axis, time in minutes with
 * its title on the bottom row only (`xLabels`), series colours from the chart tokens then dash patterns.
 * Hover is shared: the chart reports the time under the pointer (`hover`) and draws the cursor it is
 * given (`cursor`): the hovered chart also shows a tooltip, the others a dot on each line.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { clock, indexAt, niceTicks, seriesStyle, tickLabel, ticksWithin, unitLabel } from './chartMath';

interface S { key: string; label: string; unit: string; group: string; values: Float64Array; }
const props = withDefaults(defineProps<{
	time: Float64Array; series: S[]; normalise?: boolean;
	viewStart?: number | null;    // shared x-zoom window (seconds); null = full range
	viewEnd?: number | null;
	zoomTool?: boolean;           // when true, drag draws a rectangular zoom box
	wheel?: boolean;              // the wheel zooms the shared window (off where the page should scroll instead)
	cursor?: number | null;       // shared hover time (seconds) from the tiles of the same group
	xLabels?: boolean;            // tick labels and the "Time (min)" title (the bottom row of tiles)
	fill?: boolean;               // a faint area under the first series (the cumulative energy)
	band?: { start: number; end: number } | null;   // a shaded time range (the window the statistics cover)
}>(), { xLabels: true, wheel: true });
const emit = defineEmits<{
	(e: 'zoom', v: { start: number; end: number } | null): void;
	(e: 'hover', t: number | null): void;
}>();

const ML = 44, MR = 12, MT = 24;
const MB = computed(() => (props.xLabels ? 38 : 8));
// Observe the CSS-sized wrapper (plotEl), not the svg itself: the svg is absolutely positioned inside
// it, so its box comes only from CSS layout, never from its own viewBox (which would feed back into
// a runaway growth loop when an ancestor's height is indefinite).
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

// extent over a sub-range [iA,iB] (inclusive) so y auto-rescales to the zoom window
function extentRange(vals: Float64Array, iA: number, iB: number): [number, number] {
	let lo = Infinity, hi = -Infinity;
	for (let i = iA; i <= iB; i++) { const v = vals[i]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
	if (!Number.isFinite(lo)) return [0, 1];
	if (lo === hi) { lo -= 1; hi += 1; }
	return [lo, hi];
}

const shared = computed(() => {
	if (props.normalise || props.series.length === 0) return false;
	return new Set(props.series.map((s) => s.unit || s.group)).size === 1;
});
const yUnit = computed(() => (shared.value ? unitLabel(props.series[0]?.unit || '') : '% of range'));

const geom = computed(() => {
	const t = props.time;
	if (!t || t.length < 2 || props.series.length === 0) return null;
	const W = w.value, H = h.value, bottom = H - MB.value;
	const plotW = W - ML - MR, plotH = bottom - MT;

	// visible x-window (shared zoom): clamp to the requested bounds, then snap the index range so the
	// y axis rescales to just the zoomed data.
	const dataX0 = t[0], dataX1 = t[t.length - 1] || 1;
	let x0 = props.viewStart != null ? Math.max(dataX0, props.viewStart) : dataX0;
	let x1 = props.viewEnd != null ? Math.min(dataX1, props.viewEnd) : dataX1;
	if (!(x1 > x0)) { x0 = dataX0; x1 = dataX1; }
	let iA = 0, iB = t.length - 1;
	while (iA < iB && t[iA + 1] < x0) iA++;
	while (iB > iA && t[iB - 1] > x1) iB--;
	const sx = (x: number) => ML + ((x - x0) / (x1 - x0)) * plotW;

	// the shared axis: ticks over the visible data, always including zero
	let yTicks: { y: number; label: string }[], sharedY: (v: number) => number = () => 0;
	if (shared.value) {
		let lo = Infinity, hi = -Infinity;
		for (const s of props.series) { const [a, b] = extentRange(s.values, iA, iB); if (a < lo) lo = a; if (b > hi) hi = b; }
		const { ticks, step } = niceTicks(Math.min(lo, 0), hi, 5);
		const [min, max] = [ticks[0], ticks[ticks.length - 1]];
		sharedY = (v) => MT + (1 - (v - min) / (max - min)) * plotH;
		yTicks = ticks.map((v) => ({ y: sharedY(v), label: tickLabel(v, step) }));
	} else {
		yTicks = [0, 25, 50, 75, 100].map((p) => ({ y: MT + (1 - p / 100) * plotH, label: String(p) }));
	}

	// one polyline per series (normalised per series unless shared), over the visible index window
	const paths = props.series.map((s, i) => {
		const [smin, smax] = extentRange(s.values, iA, iB);
		const span = smax - smin || 1;
		const sy = shared.value ? sharedY : (v: number) => MT + (1 - (v - smin) / span) * plotH;
		let d = '', pen = false;
		const vals = s.values, n = Math.min(t.length, vals.length), hiIdx = Math.min(iB, n - 1);
		// decimate to ~2px columns for speed on long traces
		const stride = Math.max(1, Math.floor((hiIdx - iA + 1) / Math.max(1, plotW * 1.5)));
		for (let k = iA; k <= hiIdx; k += stride) {
			const v = vals[k];
			if (!Number.isFinite(v)) { pen = false; continue; }
			d += `${pen ? 'L' : 'M'}${sx(t[k]).toFixed(1)},${sy(v).toFixed(1)} `;
			pen = true;
		}
		return { key: s.key, d, sy, ...seriesStyle(i) };
	});
	// the band between the first and last point of the first series, down to the axis
	const first = paths[0];
	const area = props.fill && first.d ? `${first.d.trim()} L${sx(t[Math.min(iB, t.length - 1)]).toFixed(1)},${bottom} L${sx(t[iA]).toFixed(1)},${bottom} Z` : '';
	const band = props.band ? { x: sx(Math.max(x0, props.band.start)), x2: sx(Math.min(x1, props.band.end)) } : null;

	// time axis in minutes: tiles can be narrow, so the tick count follows the width
	const { ticks, step } = ticksWithin(x0 / 60, x1 / 60, Math.max(2, Math.floor(plotW / 60)), [1, 2, 5]);
	const xTicks = ticks.map((v) => ({ x: sx(v * 60), label: tickLabel(v, step) }));

	return { W, H, bottom, plotW, plotH, x0, x1, sx, paths, area, band, xTicks, yTicks };
});

// ---- hover: report the time under the pointer; draw the shared cursor ----
const local = ref(false);
const localT = ref<number | null>(null);
const cursorT = computed(() => (props.cursor !== undefined ? props.cursor : localT.value));
function timeOf(ev: MouseEvent): number | null {
	const g = geom.value; if (!g) return null;
	const r = (ev.currentTarget as SVGElement).getBoundingClientRect();
	const frac = ((ev.clientX - r.left) * (g.W / r.width) - ML) / g.plotW;
	return frac < 0 || frac > 1 ? null : g.x0 + frac * (g.x1 - g.x0);
}
function onMove(ev: MouseEvent) {
	const t = timeOf(ev);
	local.value = t != null; localT.value = t;
	emit('hover', t);
}
function onLeave() { local.value = false; localT.value = null; emit('hover', null); }

const hover = computed(() => {
	const g = geom.value, c = cursorT.value;
	if (!g || c == null || c < g.x0 || c > g.x1) return null;
	const i = indexAt(props.time, c);
	if (i < 0) return null;
	const x = g.sx(props.time[i]);
	const rows = props.series.map((s, k) => {
		const v = s.values[i];
		return { key: s.key, label: s.label, value: Number.isFinite(v) ? fmtValue(v) : '—', cy: Number.isFinite(v) ? g.paths[k].sy(v) : null, ...seriesStyle(k) };
	});
	return { x, clock: clock(props.time[i]), rows };
});
function fmtValue(v: number): string {
	const a = Math.abs(v);
	return v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2).replace('-', '−');
}

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
	const clamp = (px: number) => (px - ML) / g.plotW;
	const s = fracToX(clamp(rsel.x)), e = fracToX(clamp(rsel.x + rsel.w));
	if (e > s) emit('zoom', { start: s, end: e });
}
function onWheel(ev: WheelEvent) {
	const g = geom.value; if (!g || !props.wheel) return;
	ev.preventDefault();
	const frac = (pxOf(ev) - ML) / g.plotW;
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

// Tooltip at the cursor, on the side with room.
const tipStyle = computed(() => {
	const g = geom.value, hv = hover.value;
	if (!g || !hv) return {};
	return hv.x > g.W * 0.6 ? { right: `${g.W - hv.x + 12}px` } : { left: `${hv.x + 12}px` };
});
</script>

<template>
	<div class="fchart">
		<div v-if="series.length > 1" class="legend">
			<span v-for="(s, i) in series" :key="s.key" class="lg">
				<svg class="lg-key" width="22" height="8" aria-hidden="true"><line x1="0" x2="22" y1="4" y2="4" :style="{ stroke: seriesStyle(i).color }" :stroke-dasharray="seriesStyle(i).dash ?? undefined" /></svg>{{ s.label }}<em v-if="!shared">{{ unitLabel(s.unit) }}</em>
			</span>
		</div>
		<!-- The svg is absolutely positioned (inset:0) inside a relatively-positioned, flex:1 wrapper so
		     its box size comes only from CSS/flex layout (see the comment on plotEl above). -->
		<div ref="plotEl" class="fchart-plot">
			<svg v-if="geom" :viewBox="`0 0 ${geom.W} ${geom.H}`" preserveAspectRatio="none" role="img"
				:aria-label="series.map((s) => s.label).join(', ') + ' against time'"
				class="fchart-svg" :class="{ zoomtool: zoomTool }"
				@mousemove="onMove" @mouseleave="onLeave" @wheel="onWheel"
				@pointerdown="onZoomDown" @pointermove="onZoomMove" @pointerup="onZoomUp" @pointercancel="onZoomUp">
				<line v-for="(t, i) in geom.yTicks" :key="'gy' + i" class="grid" :x1="ML" :x2="geom.W - MR" :y1="t.y" :y2="t.y" />
				<line v-for="(t, i) in geom.xTicks" :key="'gx' + i" class="grid" :x1="t.x" :x2="t.x" :y1="MT" :y2="geom.bottom" />
				<rect v-if="geom.band && geom.band.x2 > geom.band.x" class="band" :x="geom.band.x" :y="MT" :width="geom.band.x2 - geom.band.x" :height="geom.bottom - MT" />
				<path v-if="geom.area" class="area" :d="geom.area" />
				<path v-for="(p, i) in geom.paths" :key="p.key" :d="p.d" class="line" :style="{ stroke: p.color }" :stroke-dasharray="p.dash ?? undefined" :data-series="i" />
				<line class="axis" :x1="ML" :x2="ML" :y1="MT" :y2="geom.bottom" />
				<line class="axis" :x1="ML" :x2="geom.W - MR" :y1="geom.bottom" :y2="geom.bottom" />
				<g v-for="(t, i) in geom.yTicks" :key="'y' + i">
					<line class="axis" :x1="ML - 4" :x2="ML" :y1="t.y" :y2="t.y" />
					<text :x="ML - 8" :y="t.y + 4" text-anchor="end" class="tick">{{ t.label }}</text>
				</g>
				<g v-for="(t, i) in geom.xTicks" :key="'x' + i">
					<line class="axis" :x1="t.x" :x2="t.x" :y1="geom.bottom" :y2="geom.bottom + 4" />
					<text v-if="xLabels" :x="t.x" :y="geom.bottom + 17" text-anchor="middle" class="tick">{{ t.label }}</text>
				</g>
				<text :x="4" :y="MT - 10" class="tick unit">{{ yUnit }}</text>
				<text v-if="xLabels" :x="(ML + geom.W - MR) / 2" :y="geom.H - 4" text-anchor="middle" class="tick title">Time (min)</text>
				<g v-if="hover">
					<line class="cursor" :x1="hover.x" :x2="hover.x" :y1="MT" :y2="geom.bottom" />
					<template v-for="r in hover.rows" :key="r.key">
						<circle v-if="r.cy != null" class="dot" :cx="hover.x" :cy="r.cy" r="4" :style="{ fill: r.color }" />
					</template>
					<g v-if="local && xLabels">
						<rect class="badge" :x="hover.x - 24" :y="geom.bottom + 4" width="48" height="18" rx="4" />
						<text class="badge-text" :x="hover.x" :y="geom.bottom + 17" text-anchor="middle">{{ hover.clock }}</text>
					</g>
				</g>
				<rect v-if="zoomRect" class="zoombox" :x="zoomRect.x" :y="MT" :width="zoomRect.w" :height="geom.bottom - MT" />
			</svg>
			<div v-else class="fchart-empty">Right-click to pick series</div>
			<div v-if="local && hover" class="tip" :style="tipStyle">
				<div class="tip-time">{{ hover.clock }}</div>
				<div v-for="r in hover.rows" :key="r.key" class="tip-row">
					<svg class="lg-key" width="14" height="8" aria-hidden="true"><line x1="0" x2="14" y1="4" y2="4" :style="{ stroke: r.color }" :stroke-dasharray="r.dash ?? undefined" /></svg>
					<span class="tip-label">{{ r.label }}</span><b>{{ r.value }}</b>
				</div>
			</div>
		</div>
	</div>
</template>

<style scoped>
.fchart { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.fchart-plot { position: relative; flex: 1 1 auto; min-height: 60px; width: 100%; }
.fchart-svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: crosshair; }
.fchart-svg.zoomtool { cursor: col-resize; }
.fchart-svg .grid { stroke: var(--d1-grid, color-mix(in srgb, var(--theme--foreground) 10%, transparent)); stroke-width: 1; }
.fchart-svg .axis { stroke: var(--d1-axis, var(--theme--foreground-subdued)); stroke-width: 1; }
.fchart-svg .line { fill: none; stroke-width: 2; stroke-linejoin: round; }
.fchart-svg .area { fill: var(--d1-series-1, #2a78d6); fill-opacity: 0.1; stroke: none; }
.fchart-svg .band { fill: var(--theme--foreground); fill-opacity: 0.08; }
.fchart-svg .tick { fill: var(--d1-dim, var(--theme--foreground-subdued)); font-size: var(--fs-xs, 11px); font-variant-numeric: tabular-nums; }
.fchart-svg .unit { font-weight: 600; }
.fchart-svg .cursor { stroke: var(--d1-axis, var(--theme--foreground-subdued)); stroke-width: 1; }
.fchart-svg .dot { stroke: var(--fd-surface, var(--theme--background)); stroke-width: 2; }
.fchart-svg .badge { fill: var(--theme--foreground); }
.fchart-svg .badge-text { fill: var(--theme--background); font-size: var(--fs-xs, 11px); font-weight: 700; font-variant-numeric: tabular-nums; }
.fchart-svg .zoombox { fill: var(--d1-accent, var(--theme--primary)); fill-opacity: 0.14; stroke: var(--d1-accent, var(--theme--primary)); stroke-width: 1; }
.fchart-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--d1-dim, var(--theme--foreground-subdued)); font-size: var(--fs-sm, 12px); }
.legend { flex: 0 0 auto; display: flex; flex-wrap: wrap; justify-content: center; gap: 2px 14px; padding: 4px 6px 0; }
.lg { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-sm, 12px); color: var(--theme--foreground); }
.lg em { color: var(--d1-dim, var(--theme--foreground-subdued)); font-style: normal; font-size: var(--fs-xs, 11px); }
.lg-key { flex: none; }
.lg-key line { stroke-width: 2; }
.tip { position: absolute; top: 14px; z-index: 2; pointer-events: none; min-width: 120px; padding: 6px 10px; border-radius: 8px; font-size: var(--fs-sm, 12px);
	background: var(--fd-surface, var(--theme--background)); border: 1px solid var(--fd-line, var(--theme--border-color-subdued)); box-shadow: var(--d1-shadow, 0 2px 6px rgba(0, 0, 0, 0.1)); }
.tip-time { font-weight: 700; margin-bottom: 2px; font-variant-numeric: tabular-nums; }
.tip-row { display: flex; align-items: center; gap: 6px; line-height: 1.5; }
.tip-label { flex: 1 1 auto; margin-right: 10px; }
.tip-row b { font-variant-numeric: tabular-nums; }
</style>
