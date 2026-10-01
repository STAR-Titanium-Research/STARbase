<script setup lang="ts">
// CloudCompare-style merged colour ramp + distribution: ONE chart where the histogram silhouette
// IS the ramp (filled with the same gradient sampleScaleAt renders, not a separate bar drawn on
// top of a separate flat ramp strip) -- matches CloudCompare's own "Display ranges" tab look,
// where the curve rising out of the colour band and the band itself are a single shape. The
// region outside [satMin, satMax] (the saturation/ramp-endpoint window -- values in it still get
// data, but it's not what stretches the ramp) is greyed, echoing CloudCompare's own dimmed
// out-of-saturation shading. "Nice" tick labels sit below, placed LINEARLY in value space over
// [domainLo, domainHi] (matching buildScaleLUT's linear-in-v indexing).
//
// domainLo/domainHi are the STRIP's x-axis -- normally a histogram's [lo, hi] (the data range),
// which is NOT the same interval as colorScale.satMin/satMax (a percentile clip *inside* it --
// that gap is the whole point of the editor). ColorScaleEditor.vue's draggable-handle overlay is
// absolutely positioned on top of this component using the SAME domainLo/domainHi, so a handle
// always sits exactly on the ramp position it marks.
import { computed } from 'vue';
import type { ColorScale } from './colorScale';
import { sampleScaleAt } from './colorScale';
import type { Histogram } from './histogram';
import { niceTicks, fmt } from './frmExport';

const props = withDefaults(defineProps<{
	colorScale: ColorScale;
	domainLo: number;
	domainHi: number;
	histogram?: Histogram | null;
	unit?: string;
	height?: number;
}>(), { histogram: null, unit: '', height: 90 });

// Fixed logical viewBox, scaled to whatever real width/height CSS gives the <svg> via
// preserveAspectRatio="none" -- safe for flat fills/paths (no stroke-width or text inside the SVG
// to distort; tick labels are separate HTML below, rendered at real screen pixels).
const VBW = 400, VBH = 100;
const uid = Math.random().toString(36).slice(2);

const domainSpan = computed(() => (props.domainHi > props.domainLo ? props.domainHi - props.domainLo : 1e-9));
/**
 * Value -> x in viewBox units, clamped to the strip and NEVER NaN. The NaN guard is load-bearing,
 * not defensive padding: Math.max(lo, Math.min(hi, NaN)) is NaN, so a single non-finite bound fed
 * the clip rect `x=NaN width=NaN`, which clips away the ENTIRE coloured copy of the curve and
 * leaves the grey one showing -- an all-grey distribution with no colour band anywhere.
 * `fallback` decides which edge a non-finite value lands on (lower bound -> 0, upper -> VBW).
 */
function valueToX(v: number, fallback: 0 | typeof VBW = 0): number {
	if (!Number.isFinite(v)) return fallback;
	const c = Math.max(props.domainLo, Math.min(props.domainHi, v));
	const x = ((c - props.domainLo) / domainSpan.value) * VBW;
	return Number.isFinite(x) ? x : fallback;
}

const gradientStops = computed(() => {
	const { domainLo: lo, domainHi: hi } = props;
	const span = hi > lo ? hi - lo : 1e-9;
	const n = 24;
	const out: { offset: number; color: string }[] = [];
	for (let i = 0; i <= n; i++) {
		const v = lo + (i / n) * span;
		const [r, g, b] = sampleScaleAt(v, props.colorScale);
		out.push({ offset: i / n, color: `rgb(${r * 255 | 0} ${g * 255 | 0} ${b * 255 | 0})` });
	}
	return out;
});
// Unique per instance so multiple ColorBar/editor panes on one page (compare mode, pop-out) never
// collide on the same <linearGradient>/<clipPath> id.
const gradId = `cbar-grad-${uid}`;
const clipId = `cbar-clip-${uid}`;

// Smoothed area path: bin centres -> quadratic-through-midpoints smoothing (cheap, no external
// dependency) -> a filled shape from baseline up to the curve. A leading/trailing zero-height
// point at the domain edges tapers the curve to the baseline instead of clipping the end bins.
const histPath = computed(() => {
	const h = props.histogram;
	if (!h || !h.bins.length || h.max <= 0) return `M0,${VBH} L${VBW},${VBH} Z`;
	const n = h.bins.length;
	const bspan = h.hi > h.lo ? h.hi - h.lo : 1e-9;
	const pts: [number, number][] = [[0, VBH]];
	for (let i = 0; i < n; i++) {
		const vCenter = h.lo + ((i + 0.5) / n) * bspan;
		const x = valueToX(vCenter);
		const y = VBH - (h.bins[i] / h.max) * VBH;
		pts.push([x, y]);
	}
	pts.push([VBW, VBH]);
	let d = `M ${pts[0][0]},${pts[0][1]}`;
	for (let i = 0; i < pts.length - 1; i++) {
		const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
		const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
		d += ` Q ${x0},${y0} ${mx},${my}`;
	}
	d += ` L ${pts[pts.length - 1][0]},${pts[pts.length - 1][1]} L ${VBW},${VBH} L 0,${VBH} Z`;
	return d;
});

// The greyed part of the curve is the DISPLAYED range's doing, not the saturation range's.
// They are different things and it matters here: satMin/satMax stretch the ramp (values outside
// still render, just clamped to an endpoint colour), whereas dispMin/dispMax are the filter --
// points outside them are the ones the shaders actually grey out or hide (uDisp/uGreyOOR). Keying
// this off satMin/satMax greyed the curve for points that were rendering in full colour.
const dispMinX = computed(() => valueToX(props.colorScale.dispMin, 0));
const dispMaxX = computed(() => valueToX(props.colorScale.dispMax, VBW));
// A zero-width window would grey out the whole curve. That is only ever right when the user has
// genuinely collapsed the displayed range onto itself; from a degenerate/unseeded scale it just
// hides the ramp entirely, so fall back to showing everything rather than nothing.
const dispClipW = computed(() => {
	const w = dispMaxX.value - dispMinX.value;
	return w > 0 ? w : (props.colorScale.dispMax > props.colorScale.dispMin ? 0 : VBW);
});
const dispClipX = computed(() => (dispClipW.value === VBW ? 0 : dispMinX.value));

const ticks = computed(() => {
	const { domainLo: lo, domainHi: hi } = props;
	if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) return [];
	const vals = niceTicks(lo, hi, 6).filter((t) => t >= lo - 1e-9 && t <= hi + 1e-9);
	// frmExport's fmt() picks its precision from each value's own magnitude, which is right for a
	// force-scale colorbar but collapses neighbouring ticks on a narrow span -- e.g. -0.125 and
	// -0.100 both render "-0.1". Pick the precision from the tick STEP instead, so adjacent labels
	// are always distinguishable whatever the range.
	const step = vals.length > 1 ? Math.abs(vals[1] - vals[0]) : Math.abs(hi - lo);
	const useFmt = step >= 1;
	const decimals = Math.min(6, Math.max(0, Math.ceil(-Math.log10(step)) + 1));
	const label = (t: number) => (useFmt ? fmt(t) : Number(t.toFixed(decimals)).toString());
	return vals.map((t) => ({ value: t, pct: ((t - lo) / (hi - lo)) * 100, label: label(t) }));
});
</script>

<template>
	<div class="cbar">
		<svg class="cbar-chart" :style="{ height: height + 'px' }" :viewBox="`0 0 ${VBW} ${VBH}`" preserveAspectRatio="none">
			<defs>
				<linearGradient :id="gradId" x1="0" x2="1" y1="0" y2="0">
					<stop v-for="s in gradientStops" :key="s.offset" :offset="s.offset" :stop-color="s.color" />
				</linearGradient>
				<!-- Restricts the COLOURED copy of the curve to the displayed window; the grey copy
					 underneath shows through everywhere else. -->
				<clipPath :id="clipId">
					<rect :x="dispClipX" y="0" :width="dispClipW" :height="VBH" />
				</clipPath>
			</defs>
			<rect x="0" y="0" :width="VBW" :height="VBH" class="cbar-bg" />
			<!-- Out-of-displayed-range distribution: genuinely grey, not the ramp dimmed behind a
				 translucent wash -- the same curve is simply painted twice, grey underneath and
				 gradient-filled on top only within [dispMin, dispMax]. Fainter in hide mode, where
				 those points aren't greyed on the render but dropped entirely. -->
			<path :d="histPath" class="cbar-hist-grey" :class="{ hidden: !colorScale.greyOutOfRange }" />
			<path :d="histPath" :fill="`url(#${gradId})`" :clip-path="`url(#${clipId})`" />
			<!-- The excluded ranges as full-height walls either side, CloudCompare-style: the grey
				 curve alone reads as "less data here", the wall reads as "this range is cut". -->
			<rect v-if="dispMinX > 0" x="0" y="0" :width="dispMinX" :height="VBH" class="cbar-wall" />
			<rect v-if="dispMaxX < VBW" :x="dispMaxX" y="0" :width="VBW - dispMaxX" :height="VBH" class="cbar-wall" />
			<line x1="0" :y1="VBH - 0.5" :x2="VBW" :y2="VBH - 0.5" class="cbar-axis" />
		</svg>
		<div class="cbar-ticks">
			<div v-for="t in ticks" :key="t.value" class="cbar-tick" :style="{ left: t.pct + '%' }">
				<span class="cbar-tick-line" />
				<span class="cbar-tick-label">{{ t.label }}</span>
			</div>
		</div>
		<div v-if="unit" class="cbar-unit">{{ unit }}</div>
	</div>
</template>

<style scoped>
/* No fixed height on the root: the chart's height is set on the <svg> itself, so the ticks and
   unit caption below stay in normal flow and add their own height. A fixed height here made the
   root shorter than its own content, which painted the tick row and caption on top of whatever
   the host rendered next. */
.cbar {
	/* App tokens, falling back to the Directus theme when this renders inside the admin. */
	--fp-border: var(--border, var(--theme--border-color-subdued, #e7ebf0));
	--fp-surface: var(--surface, var(--theme--background-subdued, #f7f9fb));
	--fp-text-dim: var(--text-dim, var(--theme--foreground-subdued, #6b7684));
	position: relative; width: 100%; user-select: none;
}
.cbar-chart { display: block; width: 100%; border-radius: 4px; border: 1px solid var(--fp-border); overflow: hidden; }
.cbar-bg { fill: var(--fp-surface); }
.cbar-hist-grey { fill: var(--fp-text-dim); opacity: 0.45; }
.cbar-hist-grey.hidden { opacity: 0.18; }
.cbar-wall { fill: var(--fp-text-dim); opacity: 0.22; }
.cbar-axis { stroke: var(--fp-border); stroke-width: 1; vector-effect: non-scaling-stroke; }
.cbar-ticks { position: relative; height: 22px; margin-top: 2px; }
.cbar-tick { position: absolute; top: 0; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; }
.cbar-tick-line { width: 1px; height: 5px; background: var(--fp-border); }
.cbar-tick-label { font-size: var(--fs-xs, 11px); color: var(--fp-text-dim); white-space: nowrap; margin-top: 1px; }
.cbar-unit { text-align: center; font-size: var(--fs-xs, 11px); color: var(--fp-text-dim); margin-top: 4px; font-style: italic; }
</style>
