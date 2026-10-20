<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, onDeactivated, ref } from 'vue';
import { nearestIndex } from './hoverIndex';
import ChartHoverLayer from './ChartHoverLayer.vue';
import { niceNum, type HoverSource } from './chartHover';
import { createLongPress, isTouchContextMenu, TOUCH_MENU_OFFSET_PX } from './longPress';
import { markInView, markTagText } from './chartMark';
import { displayUnit, yAxisTitle, type ChartSnapshot } from './chartExport';
import { axisLabels, fmtFreq, logTicks, niceScale, niceTicksIn } from './chartAxis';
import { stopBands } from './filterResponse';
import { resolveColor } from './cssColor';
import type { FilterChain } from './filterChain';

// Dependency-free chart. kind='env' → min/max envelope (force or RPM; always
// includes 0 on the y-axis); kind='line' → FFT amplitude (optional log y).
// Width AND height track the container (ResizeObserver) so the viewBox is 1:1
// with pixels — no stretching, and the plot grows to fill available vertical
// space. Hover is driven by a shared index so all three/four charts scrub
// together. For 'env' charts, cropStart/cropEnd (same units as the x-axis —
// seconds) shade the discarded lead-in/out grey and tint the actual analysed
// window (what feeds the FRM map). Axes follow DESIGN.md 5b "Chart rules"; a
// spectrum (kind='line' with logY) is drawn in dB on a log frequency axis.
const props = withDefaults(defineProps<{
	title: string;
	kind: 'env' | 'line';
	data: any;
	color?: string;
	xUnit?: string;
	yUnit?: string;
	logY?: boolean;                  // spectrum: magnitude in dB re 1 N on a log frequency axis
	// A stacked group shares one x axis: tick marks on every chart, the labels and title only on the
	// bottom one (xLabels), the top (radius) axis only on the top one (topAxis).
	xLabels?: boolean;
	topAxis?: boolean;
	// FFT: the active signal-filter chain; its stop bands are shaded and labelled (filterBands hides
	// them). The notch harmonics are multiples of rpm / 60.
	filterChain?: FilterChain | null;
	filterBands?: boolean;
	rpm?: number | null;
	// The shared hover index (charts scrub together); only ChartHoverLayer reads it (#100).
	hover?: HoverSource;
	cropStart?: number | null;
	cropEnd?: number | null;
	cropEditable?: boolean;           // Live mode: draggable crop handles that emit updates
	peak?: number | string | null;   // Postgres NUMERIC often arrives as a string over the API
	viewStart?: number | null;       // shared x-zoom window (x-units); null = full range
	viewEnd?: number | null;
	zoomTool?: boolean;              // when true, drag draws a rectangular zoom box
	overlay?: { f: number[]; amp: number[] } | null;   // FFT-only: the filtered spectrum (solid; the raw one turns faint)
	active?: boolean;                // the axis currently shown in the FRM cloud -> highlighted
	// Additional cuts plotted on the same axes for comparison (e.g. successive passes on one
	// insert edge, to see wear develop). Drawn as mid-lines, not filled envelopes: three or four
	// translucent bands over each other turn to mush, whereas lines stay readable.
	compare?: { id: string; label: string; color: string; data: any }[] | null;
	// Optional second x-axis (top margin), e.g. radial tool position — a derived/correlated
	// value aligned 1:1 with `data.t` (same length, same index). NaN entries render as a blank
	// tick (the underlying quantity is undefined there, e.g. past a spiral's cut-out), never
	// clamped to the nearest valid value.
	secondXValues?: Float32Array | number[] | null;
	secondXLabel?: string;           // the top axis' title, e.g. "Radius (mm)"
	// Pinned marker (x-units, seconds): a solid vertical line + tag, set by the host when a map
	// point is "shown in time". Optional; no marker by default.
	markX?: number | null;
	markLabel?: string;
	// The host shows a menu for `chartmenu`: only then is the browser's own right-click menu replaced.
	menu?: boolean;
}>(), { xLabels: true, topAxis: true, filterBands: true });
const emit = defineEmits<{
	(e: 'hover', i: number | null): void;
	// Right-click on a chart: x is the time of the nearest bucket under the cursor (env charts; null
	// on a spectrum, where a position means nothing to the map). The host decides what the menu
	// holds; this only reports where. `snapshot()` returns what "Save chart as PNG/SVG" needs.
	(e: 'chartmenu', v: { clientX: number; clientY: number; x: number | null; snapshot: () => ChartSnapshot }): void;
	(e: 'update:cropStart', v: number): void;
	(e: 'update:cropEnd', v: number): void;
	(e: 'zoom', v: { start: number; end: number } | null): void;   // null = reset to full
}>();

// The top margin holds the y axis title row, plus a tick-label band when the radius axis is shown;
// the bottom one holds tick labels and the x title only on the chart that carries them.
const ML = 48, MR = 14;
const hasSecondX = computed(() => !!(props.secondXValues && props.secondXValues.length) && props.topAxis);
const MT_EFF = computed(() => (hasSecondX.value ? 36 : 20));
const MB = computed(() => (props.xLabels ? 38 : 8));
// A spectrum is plotted as dB re 1 N against log frequency; everything else linearly.
const dbMode = computed(() => props.kind === 'line' && props.logY === true);
const toDb = (a: number) => 20 * Math.log10(Math.max(a, 1e-9));
const dbSeries = (d: { f: ArrayLike<number>; amp: ArrayLike<number> }) => ({ f: d.f, amp: Array.from(d.amp, toDb) });
const plotData = computed(() => (dbMode.value && props.data?.f ? dbSeries(props.data) : props.data));
const plotOverlay = computed(() => (dbMode.value && props.overlay ? dbSeries(props.overlay) : props.overlay));
const hoverUnit = computed(() => (dbMode.value ? 'dB' : yLabelUnit.value));
// The y-axis unit shown on screen and in exports. A spectrum is the force amplitude in N rms; a
// chart whose host gave no unit shows none rather than a made-up one.
const yLabelUnit = computed(() => displayUnit(props.kind, props.yUnit || (props.kind === 'line' ? 'N' : '')) ?? '');
const yTitle = computed(() => (dbMode.value ? 'Magnitude (dB re 1 N)' : yAxisTitle(props.kind, yLabelUnit.value)));
const xTitle = computed(() => (props.xUnit === 's' ? 'Time (s)' : props.xUnit === 'Hz' ? 'Frequency (Hz)' : props.xUnit || ''));
const stroke = computed(() => props.color || 'var(--d1-series-1, #2a78d6)');
// Pointer is over this chart: it shows the tooltip, the rest of the group only a value dot. A stable
// wrapper like the hover source, so a change redraws only ChartHoverLayer.
const local = { hot: ref(false) };
const peakNum = computed(() => {
	if (props.peak == null) return null;
	const n = Number(props.peak);
	return Number.isFinite(n) ? n : null;
});

const svgEl = ref<SVGSVGElement | null>(null);
// The chart body is always rendered (the svg inside it comes and goes with the data), so it is what
// the size is read from. Observing the svg itself, once, at mount, left the chart at the 360x150
// default forever when it mounted without data -- or watching a detached node after the svg was
// re-created -- and the viewBox then stretched onto the real box with preserveAspectRatio="none",
// scaling everything unevenly (#94).
const bodyEl = ref<HTMLElement | null>(null);
const w = ref(360);
const h = ref(150);
let ro: ResizeObserver | undefined;
onMounted(() => {
	ro = new ResizeObserver((entries) => {
		const r = entries[entries.length - 1].contentRect;
		if (r.width > 0) w.value = Math.round(r.width);
		if (r.height > 0) h.value = Math.round(r.height);
	});
	if (bodyEl.value) ro.observe(bodyEl.value);
});
onBeforeUnmount(() => { longPress.cancel(); ro?.disconnect(); if (rafId) cancelAnimationFrame(rafId); });
// The Plot page is kept alive: a finger down as it hides never sends its pointerup here.
onDeactivated(() => longPress.cancel());

const geom = computed(() => {
	const d = plotData.value;
	if (!d) return null;
	const xs: number[] = props.kind === 'env' ? d.t : d.f;
	if (!xs || xs.length < 2) return null;
	const W = w.value, Hh = h.value;
	const mt = MT_EFF.value;
	const plotH = Hh - mt - MB.value;
	const plotW = W - ML - MR;

	// Visible x-window (shared zoom). Snap the index range to the requested view
	// so the y-axis auto-rescales to just the zoomed data, and the x-axis spans
	// exactly the requested bounds (smooth, not sample-snapped).
	// A spectrum spans its own decades (the shared zoom is a time window), from the decade of its
	// first non-zero bin, never below 1 Hz.
	const logX = dbMode.value;
	const dataX0 = xs[0], dataX1 = xs[xs.length - 1];
	let x0 = props.viewStart != null && !logX ? Math.max(dataX0, props.viewStart) : dataX0;
	let x1 = props.viewEnd != null && !logX ? Math.min(dataX1, props.viewEnd) : dataX1;
	if (logX) x0 = Math.max(1, 10 ** Math.floor(Math.log10(xs.find((v) => v > 0) ?? 1)));
	if (!(x1 > x0)) { x0 = dataX0; x1 = dataX1; }
	let iA = 0, iB = xs.length - 1;
	while (iA < iB && xs[iA + 1] < x0) iA++;
	while (iB > iA && xs[iB - 1] > x1) iB--;
	if (logX) while (iA < iB && !(xs[iA] >= x0)) iA++;   // log(0) is -Infinity

	let lo = Infinity, hi = -Infinity;
	if (props.kind === 'env') {
		for (let i = iA; i <= iB; i++) { if (d.min[i] < lo) lo = d.min[i]; if (d.max[i] > hi) hi = d.max[i]; }
		// Include 0 only when it's cheap. Unconditionally forcing 0 (the old behaviour)
		// squashed all-negative signals (e.g. an Fy at −5…−10 N) into half the plot,
		// with the top half empty — the envelope looked cropped/compressed. Now the axis
		// extends to 0 only if the gap to 0 costs ≤ half the data's own range.
		// Comparison cuts share these axes, so they have to widen the y-range too — otherwise a
		// worn pass with higher forces would be silently clipped at the top of the plot, which is
		// exactly the difference the comparison exists to show.
		for (const c of props.compare ?? []) {
			const cd = c.data;
			if (!cd?.t?.length) continue;
			for (let i = 0; i < cd.t.length; i++) {
				if (cd.t[i] < x0 || cd.t[i] > x1) continue;
				const mid = (cd.min[i] + cd.max[i]) / 2;
				if (mid < lo) lo = mid;
				if (mid > hi) hi = mid;
			}
		}
		const R = (hi - lo) || 1;
		if (lo > 0 && lo <= R * 0.5) lo = 0;
		else if (hi < 0 && -hi <= R * 0.5) hi = 0;
	} else {
		lo = dbMode.value ? Infinity : 0;
		for (let i = iA; i <= iB; i++) { if (d.amp[i] > hi) hi = d.amp[i]; if (d.amp[i] < lo) lo = d.amp[i]; }
		const ov = plotOverlay.value;
		if (dbMode.value) {
			if (ov) for (let i = 0; i < ov.f.length; i++) if (ov.f[i] >= x0 && ov.f[i] <= x1 && ov.amp[i] > hi) hi = ov.amp[i];
			lo = Math.max(lo, hi - 90);   // the bottom of a spectrum is noise floor: show at most 90 dB of it
		}
	}
	if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
	if (hi === lo) hi = lo + 1;

	// Ticks and the range grown to them, so the top tick sits above the data.
	const scale = niceScale(lo, hi);
	lo = scale.lo; hi = scale.hi;
	const yLabels = axisLabels(scale.ticks);
	const sy = (y: number) => mt + (1 - (y - lo) / (hi - lo)) * plotH;
	const yticks = scale.ticks.map((v, i) => ({ y: sy(v), label: yLabels[i] }));
	// Samples below the bottom of a dB axis sit on it rather than running off the plot.
	const syc = dbMode.value ? (y: number) => sy(Math.max(y, lo)) : sy;

	const lx0 = Math.log10(x0), lx1 = Math.log10(x1);
	const sx = logX ? (x: number) => ML + ((Math.log10(Math.max(x, x0)) - lx0) / (lx1 - lx0)) * plotW
		: (x: number) => ML + ((x - x0) / (x1 - x0)) * plotW;
	/** The x value under a pixel fraction (0..1, clamped) of the plot width. */
	const xAt = (frac: number) => {
		const f = Math.min(1, Math.max(0, frac));
		return logX ? 10 ** (lx0 + f * (lx1 - lx0)) : x0 + f * (x1 - x0);
	};

	function areaPath(a: number, b: number): string {
		const i0 = Math.max(0, Math.min(a, xs.length - 1));
		const i1 = Math.max(0, Math.min(b, xs.length - 1));
		let up = 'M';
		for (let i = i0; i <= i1; i++) up += `${sx(xs[i]).toFixed(1)},${sy(d.max[i]).toFixed(1)} `;
		let dn = '';
		for (let i = i1; i >= i0; i--) dn += `${sx(xs[i]).toFixed(1)},${sy(d.min[i]).toFixed(1)} `;
		return `${up}L ${dn}Z`;
	}

	let area = '', line = '';
	if (props.kind === 'env') {
		area = areaPath(iA, iB);
		line = 'M';
		for (let i = iA; i <= iB; i++) line += `${sx(xs[i]).toFixed(1)},${sy((d.min[i] + d.max[i]) / 2).toFixed(1)} `;
	} else {
		line = 'M';
		for (let i = iA; i <= iB; i++) line += `${sx(xs[i]).toFixed(1)},${syc(d.amp[i]).toFixed(1)} `;
	}

	// x ticks: nice steps on a time axis; decades (with fainter 2-9 minor lines) on a frequency axis.
	let xticks: { x: number; label: string }[];
	let xminor: number[] = [];
	if (logX) {
		const lt = logTicks(x0, x1);
		xticks = lt.major.map((v) => ({ x: sx(v), label: fmtFreq(v) }));
		xminor = lt.minor.map(sx);
	} else {
		const tv = niceTicksIn(x0, x1, Math.max(4, Math.min(6, Math.round(plotW / 100))));
		const xl = axisLabels(tv);
		xticks = tv.map((v, i) => ({ x: sx(v), label: xl[i] }));
	}

	// Second x-axis (e.g. radial position): a derived/correlated quantity aligned 1:1 with xs,
	// not necessarily linear in time (the Vc speed model's sqrt curve, in particular) — unlike
	// the primary axis's "nice round step" ticks, evenly-spaced pixel positions are the honest
	// choice here, each labeled with the (linearly interpolated) value at that x. A NaN result
	// (past a spiral's cut-out) is skipped — a blank tick, never clamped to the last valid value.
	const xticks2: { x: number; label: string }[] = [];
	if (hasSecondX.value && props.secondXValues) {
		const sv = props.secondXValues;
		const n2 = Math.max(3, Math.min(8, Math.round(plotW / 100)));
		for (let k = 0; k <= n2; k++) {
			const xVal = x0 + (k / n2) * (x1 - x0);
			let loI = 0, hiI = xs.length - 1;
			while (loI < hiI) { const mid = (loI + hiI) >> 1; if (xs[mid] < xVal) loI = mid + 1; else hiI = mid; }
			const j1 = loI, j0 = Math.max(0, j1 - 1);
			const val = (j0 === j1 || xs[j1] === xs[j0]) ? sv[j1]
				: sv[j0] + ((xVal - xs[j0]) / (xs[j1] - xs[j0])) * (sv[j1] - sv[j0]);
			if (!Number.isFinite(val)) continue;
			xticks2.push({ x: sx(xVal), label: niceNum(val) });
		}
	}

	const zeroY = (!dbMode.value && lo < 0 && hi > 0) ? sy(0) : null;

	// Filtered-spectrum overlay (FFT charts only): map the overlay's own (f,amp) through the
	// SAME sx/sy so it lands on the current axes/zoom; clipped to the visible x-window.
	let overlayLine = '';
	const ovl = plotOverlay.value;
	if (props.kind === 'line' && ovl && ovl.f.length > 1) {
		const of = ovl.f, oa = ovl.amp;
		let started = false;
		for (let i = 0; i < of.length; i++) {
			if (of[i] < x0 || of[i] > x1) { started = false; continue; }
			overlayLine += `${started ? 'L' : 'M'}${sx(of[i]).toFixed(1)},${syc(oa[i]).toFixed(1)} `;
			started = true;
		}
	}
	// Comparison cuts as mid-lines through the same sx/sy, so they line up with the primary
	// envelope and the shared zoom. Each carries its own time base (a different recording), so
	// they are mapped by x-value rather than by index.
	const compareLines: { id: string; label: string; color: string; d: string }[] = [];
	if (props.kind === 'env') {
		for (const c of props.compare ?? []) {
			const cd = c.data;
			if (!cd?.t?.length) continue;
			let path = '', started = false;
			for (let i = 0; i < cd.t.length; i++) {
				const xv = cd.t[i];
				if (xv < x0 || xv > x1) { started = false; continue; }
				const mid = (cd.min[i] + cd.max[i]) / 2;
				path += `${started ? 'L' : 'M'}${sx(xv).toFixed(1)},${sy(mid).toFixed(1)} `;
				started = true;
			}
			if (path) compareLines.push({ id: c.id, label: c.label, color: c.color, d: path });
		}
	}
	return { W, Hh, xs, x0, x1, iA, iB, lo, hi, sx, sy, xAt, areaPath, area, line, xticks, xminor, xticks2, yticks, zeroY, overlayLine, compareLines };
});

// The filter chain's stop bands on a spectrum, as pixel spans with a label. Kept out of `geom` so
// editing the chain redraws only the bands. A label is dropped when it would run over the previous one.
const bandRects = computed(() => {
	const g = geom.value;
	if (!g || !dbMode.value || !props.filterBands || !props.filterChain) return [];
	const right = g.W - MR;
	const out: { x: number; w: number; label: string; tx: number; anchor: 'start' | 'end' }[] = [];
	let lastEnd = -Infinity;
	for (const b of stopBands(props.filterChain, { nyquist: g.xs[g.xs.length - 1], rpm: props.rpm })) {
		const xa = b.f0 <= g.x0 ? ML : g.sx(b.f0), xb = Math.min(right, g.sx(b.f1));
		if (!(xb - xa >= 1) || xa >= right) continue;
		const need = b.label.length * 5.8;
		const anchor = need > right - xa - 6 ? 'end' : 'start', tx = anchor === 'end' ? right - 4 : xa + 4;
		const left = anchor === 'end' ? tx - need : tx;
		const keep = left > lastEnd + 4;
		if (keep) lastEnd = left + need;
		out.push({ x: xa, w: xb - xa, label: keep ? b.label : '', tx, anchor });
	}
	return out;
});

// The crop window is dragged continuously; kept out of `geom` so a drag frame only redraws the
// shaded window and handles, not the whole envelope, ticks and overlays.
const crop = computed(() => {
	const g = geom.value;
	if (!g) return { cropArea: '', cropStartX: null, cropEndX: null, shadeL: 0, shadeR: 0 };
	const { xs, iA, iB, sx, areaPath } = g;
	let cropArea = '';
	if (props.kind === 'env' && props.cropStart != null && props.cropEnd != null) {
		// i0 = -1 when the crop starts after all data; revIdx = -1 when it ends
		// before all data — in both cases there's no in-range window to shade
		// (guard, else areaPath would index past the array and emit NaN paths).
		// Clamp to the visible [iA,iB] window so a zoom doesn't paint off-plot.
		const i0 = Math.max(iA, xs.findIndex((v) => v >= props.cropStart!));
		// Scan backward in place rather than xs.slice().reverse().findIndex(...) — that clones
		// the whole array on every recompute, and this runs on every crop-drag pointermove.
		let i1 = -1;
		for (let k = xs.length - 1; k >= 0; k--) { if (xs[k] <= props.cropEnd!) { i1 = k; break; } }
		i1 = i1 < 0 ? -1 : Math.min(iB, i1);
		if (i0 >= iA && i1 >= i0) cropArea = areaPath(i0, i1);
	}
	const cropStartX = props.cropStart != null ? sx(props.cropStart) : null;
	const cropEndX = props.cropEnd != null ? sx(props.cropEnd) : null;
	// The discarded lead-in / lead-out, as widths of grey from each plot edge (0 = none).
	const inPlot = (x: number) => Math.min(g.W - MR, Math.max(ML, x));
	const shade = props.kind === 'env' && cropStartX != null && cropEndX != null;
	return {
		cropArea, cropStartX, cropEndX,
		shadeL: shade ? inPlot(cropStartX!) - ML : 0,
		shadeR: shade ? g.W - MR - inPlot(cropEndX!) : 0,
	};
});

// Raw mousemove can fire far faster than the screen repaints, and hoverIndex is a single ref
// shared across every open chart (so they scrub together) — each emit re-renders every sibling
// chart's crosshair, so emitting on every raw event redoes that fan-out several times per visible
// frame. Coalesce to one emit per animation frame, same rationale/pattern as onCropMove below.
let hoverRafId = 0;
let pendingHoverEv: MouseEvent | null = null;
// The bucket under a pointer, shared by the hover crosshair and the right-click menu so both
// always agree. The plot spans the visible window [x0, x1], not the whole record, so map into
// that and find the nearest sample by value (see hoverIndex.ts).
function bucketAt(ev: { clientX: number }): number | null {
	const g = geom.value, svg = svgEl.value;
	if (!g || !svg) return null;
	const r = svg.getBoundingClientRect();
	const px = (ev.clientX - r.left) * (g.W / r.width);
	return nearestIndex(g.xs, g.xAt((px - ML) / (g.W - ML - MR)), g.iA, g.iB);
}
function emitHover(ev: MouseEvent) {
	const i = bucketAt(ev);
	if (i != null) emit('hover', i);
}
function onMove(ev: MouseEvent) {
	if (!geom.value) return;
	pendingHoverEv = ev;
	if (!hoverRafId) hoverRafId = requestAnimationFrame(() => { hoverRafId = 0; if (pendingHoverEv) emitHover(pendingHoverEv); });
}
function onEnter() { local.hot.value = true; }
function onLeave() { local.hot.value = false; emit('hover', null); }

// Pinned marker. Kept out of `geom` so a marker change doesn't redo the envelope paths. Only
// 'env' charts take one: the FFT x-axis is frequency, where a time marker means nothing.
const mark = computed(() => {
	const g = geom.value;
	if (!g || props.kind !== 'env' || !markInView(props.markX, g.x0, g.x1)) return null;
	const px = g.sx(props.markX);
	// Flip the tag to the left of the line near the right edge so it never clips.
	const flip = px > (ML + g.W - MR) / 2;
	return { px, flip, text: markTagText(props.markX, props.markLabel, props.xUnit, niceNum) };
});

// Right-click on an env chart: report the nearest bucket's time (same mapping as emitHover) so
// the host can offer "show position on map". Other charts keep the browser's own menu. A right
// drag is not a gesture here (the pointerdown handlers ignore button 2), so no drag guard.
// Only intercepted when the host opts in with `menu`: SignalPanel (Diagnostics) renders env charts
// too but has no menu, and swallowing the browser's menu there would leave the right-click doing
// nothing at all.
function onContextMenu(ev: MouseEvent) {
	const g = geom.value;
	if (!g || !props.menu) return;
	ev.preventDefault();
	// A touch hold opens the menu itself (longPress below). Android Chrome also raises `contextmenu`
	// for the same hold, so take it here too or the menu would open twice (and once for a drift the
	// hold has already rejected as a pan). Never a mouse right-click, even with a finger down.
	if (isTouchContextMenu(ev, longPress.touching)) return;
	openMenu(ev.clientX, ev.clientY);
}
function openMenu(clientX: number, clientY: number, menuOffset = 0) {
	const g = geom.value;
	if (!g || !props.menu) return;
	let x: number | null = null;
	if (props.kind === 'env') {
		const i = bucketAt({ clientX });
		if (i == null) return;
		x = g.xs[i];
	}
	emit('chartmenu', { clientX: clientX + menuOffset, clientY: clientY + menuOffset, x, snapshot });
}
// Touch has no right button and iOS Safari no `contextmenu`: a one-finger hold opens the same menu.
// The svg's pointer handlers below are the zoom box's; these wrap them and only add the hold.
const longPress = createLongPress((x, y) => openMenu(x, y, TOUCH_MENU_OFFSET_PX));
function onSvgDown(ev: PointerEvent) { longPress.down(ev); onZoomDown(ev); }
function onSvgMove(ev: PointerEvent) { longPress.move(ev); onZoomMove(ev); }
function onSvgUp(ev: PointerEvent) { longPress.up(ev); onZoomUp(ev); }
// The chart as the image exporter wants it: the props, not the on-screen geometry, so the file
// is laid out for a report and not for this panel's pixel size.
function snapshot(): ChartSnapshot {
	return {
		title: props.title, kind: props.kind, data: props.data, color: resolveColor(props.color) || undefined, xUnit: props.xUnit,
		yUnit: yLabelUnit.value, logY: props.logY, cropStart: props.cropStart, cropEnd: props.cropEnd,
		viewStart: props.viewStart, viewEnd: props.viewEnd, compare: props.compare,
	};
}

// ---- draggable crop handles (Live mode) ----
let dragging: 'start' | 'end' | null = null;
// Raw pointermove can fire far faster than the screen repaints (some mice/trackpads report at
// 100Hz+). Each emitted crop value flows back down as a prop, which recomputes this component's
// own geometry AND every sibling env chart's (Fx/Fy/Fz/RPM can all be crop-shaded at once) — so
// emitting on every raw event redoes that whole chain several times per visible frame. Coalescing
// to one emit per animation frame caps it at the rate the user can actually see.
let rafId = 0;
let pendingEv: PointerEvent | null = null;
function xToSec(ev: PointerEvent): number {
	const g = geom.value, svg = svgEl.value;
	if (!g || !svg) return 0;
	const r = svg.getBoundingClientRect();
	const px = (ev.clientX - r.left) * (g.W / r.width);
	return g.xAt((px - ML) / (g.W - ML - MR));
}
function onCropDown(ev: PointerEvent) {
	if (ev.button !== 0) return;   // right button opens the chart menu, it must not grab a handle
	if (!props.cropEditable || !geom.value) return;
	const sec = xToSec(ev);
	const ds = props.cropStart != null ? Math.abs(sec - props.cropStart) : Infinity;
	const de = props.cropEnd != null ? Math.abs(sec - props.cropEnd) : Infinity;
	dragging = ds <= de ? 'start' : 'end';
	(ev.currentTarget as Element).setPointerCapture(ev.pointerId);
	ev.stopPropagation();
	onCropMove(ev);
}
function emitCrop(ev: PointerEvent) {
	const sec = xToSec(ev);
	if (dragging === 'start') emit('update:cropStart', props.cropEnd != null ? Math.min(sec, props.cropEnd) : sec);
	else emit('update:cropEnd', props.cropStart != null ? Math.max(sec, props.cropStart) : sec);
}
function onCropMove(ev: PointerEvent) {
	if (!dragging) return;
	pendingEv = ev;
	if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; if (pendingEv) emitCrop(pendingEv); });
	ev.stopPropagation();
}
function onCropUp(ev: PointerEvent) {
	if (dragging) {
		if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
		emitCrop(ev);   // land on the exact release point, not the last coalesced frame
		pendingEv = null;
	}
	dragging = null;
	try { (ev.currentTarget as Element).releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
}

// ---- x-zoom: wheel + rectangular selection (emits a shared window to the parent) ----
function pxOf(ev: PointerEvent | WheelEvent): number {
	const g = geom.value, svg = svgEl.value;
	if (!g || !svg) return 0;
	const r = svg.getBoundingClientRect();
	return ((ev as any).clientX - r.left) * (g.W / r.width);
}
function fracToX(frac: number): number {
	return geom.value!.xAt(frac);
}
const zoomRect = ref<{ x: number; w: number } | null>(null);
let zoomDrag = false, zStartPx = 0;
function onZoomDown(ev: PointerEvent) {
	if (ev.button !== 0) return;   // right button opens the chart menu, it must not start a zoom box
	if (!props.zoomTool || !geom.value || dbMode.value) return;   // the shared zoom is a time window
	zoomDrag = true; zStartPx = pxOf(ev); zoomRect.value = { x: zStartPx, w: 0 };
	(ev.currentTarget as Element).setPointerCapture(ev.pointerId); ev.stopPropagation();
}
function onZoomMove(ev: PointerEvent) {
	if (!zoomDrag) return;
	const px = pxOf(ev);
	zoomRect.value = { x: Math.min(px, zStartPx), w: Math.abs(px - zStartPx) };
	ev.stopPropagation();
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
	const g = geom.value;
	if (!g || dbMode.value) return;
	ev.preventDefault();
	const frac = (pxOf(ev) - ML) / (g.W - ML - MR);
	const cursorX = fracToX(frac);
	const dataSpan = g.xs[g.xs.length - 1] - g.xs[0];
	const f = ev.deltaY < 0 ? 1 / 1.3 : 1.3;
	let span = Math.min(dataSpan, Math.max(dataSpan / 1000, (g.x1 - g.x0) * f));
	let s = cursorX - Math.min(1, Math.max(0, frac)) * span, e = s + span;
	const dx0 = g.xs[0], dx1 = g.xs[g.xs.length - 1];
	if (s < dx0) { e += dx0 - s; s = dx0; }
	if (e > dx1) { s -= e - dx1; e = dx1; }
	s = Math.max(dx0, s);
	emit('zoom', (e - s >= dataSpan * 0.999) ? null : { start: s, end: e });
}
</script>

<template>
	<div class="chart" :class="{ active }" :style="active ? { '--accent': stroke } : {}">
		<div class="chart-head">
			<span class="chart-title">{{ title }}</span>
			<span v-if="peakNum != null" class="chart-peak">peak {{ peakNum.toFixed(2) }} {{ yLabelUnit }}</span>
			<span v-else-if="overlay && geom && dbMode" class="chart-key" :style="{ '--accent-key': stroke }">
				<span class="key-line"></span>Filtered<span class="key-line faint"></span>Raw
			</span>
		</div>
		<div ref="bodyEl" class="chart-body">
		<svg
			ref="svgEl" v-if="geom" :viewBox="`0 0 ${geom.W} ${geom.Hh}`" class="chart-svg" :class="{ zoomtool: zoomTool }"
			preserveAspectRatio="none" @mouseenter="onEnter" @mousemove="onMove" @mouseleave="onLeave" @wheel="onWheel" @contextmenu="onContextMenu"
			@pointerdown="onSvgDown" @pointermove="onSvgMove" @pointerup="onSvgUp" @pointercancel="onSvgUp"
		>
			<!-- filter stop bands (spectrum), under the grid and the traces -->
			<g v-if="bandRects.length" pointer-events="none">
				<template v-for="(b, i) in bandRects" :key="'bd' + i">
					<rect :x="b.x" :y="MT_EFF" :width="b.w" :height="geom.Hh - MB - MT_EFF" class="fc-band" />
					<text v-if="b.label" :x="b.tx" :y="MT_EFF + 13" :text-anchor="b.anchor" class="fc-band-label">{{ b.label }}</text>
				</template>
			</g>
			<line v-for="(x, i) in geom.xminor" :key="'gm' + i" :x1="x" :x2="x" :y1="MT_EFF" :y2="geom.Hh - MB" class="fc-grid minor" stroke-width="1" />
			<line v-for="(t, i) in geom.yticks" :key="'gy' + i" :x1="ML" :x2="geom.W - MR" :y1="t.y" :y2="t.y" class="fc-grid" stroke-width="1" />
			<line v-for="(t, i) in geom.xticks" :key="'gx' + i" :x1="t.x" :x2="t.x" :y1="MT_EFF" :y2="geom.Hh - MB" class="fc-grid" stroke-width="1" />
			<line v-if="geom.zeroY != null" :x1="ML" :x2="geom.W - MR" :y1="geom.zeroY" :y2="geom.zeroY" class="fc-zero" stroke-width="1" />
			<!-- the discarded lead-in / lead-out of the crop, in grey -->
			<rect v-if="crop.shadeL > 0" :x="ML" :y="MT_EFF" :width="crop.shadeL" :height="geom.Hh - MB - MT_EFF" class="fc-shade" />
			<rect v-if="crop.shadeR > 0" :x="geom.W - MR - crop.shadeR" :y="MT_EFF" :width="crop.shadeR" :height="geom.Hh - MB - MT_EFF" class="fc-shade" />
			<!-- envelope band at 10%; the analysed [cropStart,cropEnd] window overpaints a second 10% -->
			<path v-if="kind === 'env'" :d="geom.area" :fill="stroke" fill-opacity="0.1" />
			<path v-if="kind === 'env' && crop.cropArea" :d="crop.cropArea" :fill="stroke" fill-opacity="0.1" />
			<path v-if="kind === 'env'" :d="geom.line" fill="none" :stroke="stroke" stroke-width="1.5" stroke-linejoin="round" />
			<path v-if="kind === 'line'" :d="geom.line" fill="none" :stroke="stroke" stroke-width="1.5" :stroke-opacity="geom.overlayLine ? 0.35 : 1" />
			<path v-if="geom.overlayLine" :d="geom.overlayLine" fill="none" :stroke="stroke" stroke-width="1.5" />
			<!-- Comparison cuts, drawn over the primary envelope so the current cut stays the
				 visual subject and the others read as reference traces. -->
			<path v-for="c in geom.compareLines" :key="c.id" :d="c.d" fill="none"
				:stroke="c.color" stroke-width="1.5" stroke-dasharray="4 2" opacity="0.85" />
			<line :x1="ML" :x2="ML" :y1="MT_EFF" :y2="geom.Hh - MB" class="fc-axis" stroke-width="1" />
			<line :x1="ML" :x2="geom.W - MR" :y1="geom.Hh - MB" :y2="geom.Hh - MB" class="fc-axis" stroke-width="1" />
			<g v-for="(t, i) in geom.yticks" :key="'y' + i">
				<line :x1="ML - 4" :x2="ML" :y1="t.y" :y2="t.y" class="fc-axis" stroke-width="1" />
				<text :x="ML - 7" :y="t.y + 4" text-anchor="end" class="tick">{{ t.label }}</text>
			</g>
			<g v-for="(t, i) in geom.xticks" :key="'x' + i">
				<line :x1="t.x" :x2="t.x" :y1="geom.Hh - MB" :y2="geom.Hh - MB + 4" class="fc-axis" stroke-width="1" />
				<text v-if="xLabels" :x="t.x" :y="geom.Hh - MB + 16" text-anchor="middle" class="tick">{{ t.label }}</text>
			</g>
			<text v-if="xLabels && xTitle" :x="(ML + geom.W - MR) / 2" :y="geom.Hh - 6" text-anchor="middle" class="axis-label">{{ xTitle }}</text>
			<text v-if="yTitle" :x="4" y="12" class="axis-label">{{ yTitle }}</text>
			<!-- Second x-axis (e.g. radius): tick marks and labels above the plot, its title on the title
			     row, right-aligned. Blank where geom.xticks2 skipped a NaN (past a spiral's cut-out). -->
			<g v-if="hasSecondX">
				<text v-if="secondXLabel" :x="geom.W - MR" y="12" text-anchor="end" class="axis-label">{{ secondXLabel }}</text>
				<g v-for="(t, i) in geom.xticks2" :key="'x2' + i">
					<line :x1="t.x" :x2="t.x" :y1="MT_EFF - 4" :y2="MT_EFF" class="fc-axis" stroke-width="1" />
					<text :x="t.x" :y="MT_EFF - 8" text-anchor="middle" class="tick">{{ t.label }}</text>
				</g>
			</g>
			<ChartHoverLayer part="svg" :hover="hover" :local="local" :tag-below="xLabels" :geom="geom" :kind="kind" :data="plotData" :y-label-unit="hoverUnit" :x-unit="xUnit"
				:stroke="stroke" :top="MT_EFF" :bottom="geom.Hh - MB" />
			<!-- Pinned marker: solid, in its own colour (not the chart's --accent, which the active
			     chart overrides with its trace colour) so it reads apart from the dashed hover line
			     and the teal/red crop handles. -->
			<g v-if="mark" class="fc-mark" pointer-events="none">
				<line :x1="mark.px" :x2="mark.px" :y1="MT_EFF" :y2="geom.Hh - MB" class="fc-mark-line" stroke-width="1.5" />
				<text :x="mark.px + (mark.flip ? -4 : 4)" :y="MT_EFF + 10" :text-anchor="mark.flip ? 'end' : 'start'" class="fc-mark-tag">{{ mark.text }}</text>
			</g>
			<!-- Live-mode draggable crop handles (start = teal, end = red); wide invisible
			     hit rects keep them easy to grab. Pointer events are captured on drag. -->
			<g v-if="cropEditable">
				<template v-for="(hx, k) in [{ x: crop.cropStartX, c: '#0f766e' }, { x: crop.cropEndX, c: '#b91c1c' }]" :key="'ch' + k">
					<template v-if="hx.x != null">
						<line :x1="hx.x" :x2="hx.x" :y1="MT_EFF" :y2="geom.Hh - MB" :stroke="hx.c" stroke-width="1.4" />
						<rect :x="hx.x - 3" :y="MT_EFF" width="6" :height="geom.Hh - MB - MT_EFF" :fill="hx.c" fill-opacity="0.001"
							class="crop-hit" @pointerdown="onCropDown" @pointermove="onCropMove" @pointerup="onCropUp" @pointercancel="onCropUp" />
						<rect :x="hx.x - 3.5" :y="MT_EFF" width="7" height="5" :fill="hx.c" />
					</template>
				</template>
			</g>
			<!-- rubber-band x-zoom rectangle -->
			<rect v-if="zoomRect" :x="zoomRect.x" :y="MT_EFF" :width="zoomRect.w" :height="geom.Hh - MB - MT_EFF"
				class="zoom-rect" />
		</svg>
		<div v-else class="chart-empty">no data</div>
		</div>
		<ChartHoverLayer v-if="geom" part="tip" :hover="hover" :local="local" :geom="geom" :kind="kind" :data="plotData" :y-label-unit="hoverUnit" :x-unit="xUnit"
			:stroke="stroke" :top="MT_EFF" :bottom="geom.Hh - MB" />
	</div>
</template>

<style scoped>
.chart {
	position: relative;
	background: var(--theme--background, #fff);
	border: 1px solid var(--theme--border-color-subdued, #e7ebf0);
	border-radius: 14px; padding: 10px 12px 6px; min-width: 0; min-height: 150px;
	display: flex; flex-direction: column;
}
/* the axis shown in the FRM cloud: coloured left edge + soft ring so it's obvious which
   signal you're looking at on the fingerprint. */
.chart.active { border-color: var(--accent); box-shadow: inset 3px 0 0 0 var(--accent), 0 0 0 1px var(--accent); }
.chart-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 2px; gap: 8px; flex: 0 0 auto; }
.chart-title { font-size: var(--fs-md, 13px); font-weight: 650; color: var(--theme--foreground, #1e293b); }
.chart-key { display: flex; align-items: center; gap: 5px; font-size: var(--fs-xs, 11px); color: var(--theme--foreground-subdued, #98a2b3); }
.key-line { display: inline-block; width: 16px; height: 0; border-top: 2px solid var(--accent-key, currentColor); margin-left: 6px; }
.key-line:first-child { margin-left: 0; }
.key-line.faint { opacity: 0.35; }
.chart-peak { font-size: var(--fs-xs, 11px); color: var(--theme--foreground, #1e293b); font-weight: 700; font-variant-numeric: tabular-nums; }
.chart-body { flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
.chart-svg { display: block; width: 100%; flex: 1 1 auto; min-height: 0; cursor: crosshair; touch-action: none; }
.chart-svg.zoomtool { cursor: crosshair; }
.chart-svg .tick { fill: var(--theme--foreground-subdued, #94a3b8); font-size: var(--fs-xs, 11px); font-variant-numeric: tabular-nums; }
.chart-svg .axis-label { fill: var(--theme--foreground-subdued, #94a3b8); font-size: var(--fs-xs, 11px); font-weight: 600; }
.chart-svg .crop-hit { cursor: ew-resize; }
/* Hairline grid and axis from the design tokens (--d1-grid / --d1-axis, DESIGN.md 5b); the force
   app does not load tokens.css, so its own theme-scoped --border/--border-2 stand in. */
.chart-svg .fc-grid { stroke: var(--d1-grid, var(--border, #edf0f2)); }
.chart-svg .fc-grid.minor { stroke-opacity: 0.5; }
.chart-svg .fc-axis { stroke: var(--d1-axis, var(--border-2, #94a3b8)); }
.chart-svg .fc-zero { stroke: var(--d1-axis, var(--border-2, #cbd5e1)); }
.chart-svg .fc-shade { fill: var(--theme--foreground, #1e293b); fill-opacity: 0.05; }
.chart-svg .fc-band { fill: var(--theme--foreground, #1e293b); fill-opacity: 0.07; }
.chart-svg .fc-band-label { fill: var(--theme--foreground-subdued, #64748b); font-size: var(--fs-xs, 11px); font-weight: 600; }
.chart-svg .fc-mark-line { stroke: var(--mark-color, #f59e0b); }
.chart-svg .fc-mark-tag { fill: var(--mark-color, #f59e0b); font-size: var(--fs-xs, 11px); font-weight: 700; font-variant-numeric: tabular-nums; paint-order: stroke; stroke: var(--theme--background, #fff); stroke-width: 3px; }
.chart-empty { flex: 1; display: grid; place-items: center; color: var(--theme--foreground-subdued, #98a2b3); font-size: var(--fs-sm, 12px); }
/* The accent, not a sky blue a shade off the Fz trace it is dragged across. */
.zoom-rect { fill: var(--accent, #38bdf8); fill-opacity: 0.16; stroke: var(--accent, #0ea5e9); stroke-width: 0.8; }
</style>
