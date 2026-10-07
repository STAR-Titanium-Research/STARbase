<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, onDeactivated, ref } from 'vue';
import { hoverIndexAt } from './hoverIndex';
import { createLongPress, isTouchContextMenu, TOUCH_MENU_OFFSET_PX } from './longPress';
import { markInView, markTagText } from './chartMark';
import { displayUnit, yAxisTitle, type ChartSnapshot } from './chartExport';

// Dependency-free chart. kind='env' → min/max envelope (force or RPM; always
// includes 0 on the y-axis); kind='line' → FFT amplitude (optional log y).
// Width AND height track the container (ResizeObserver) so the viewBox is 1:1
// with pixels — no stretching, and the plot grows to fill available vertical
// space. Hover is driven by a shared index so all three/four charts scrub
// together. For 'env' charts, cropStart/cropEnd (same units as the x-axis —
// seconds) render the discarded lead-in/out at low saturation and the actual
// analysed window (what feeds the FRM map) at full saturation.
const props = defineProps<{
	title: string;
	kind: 'env' | 'line';
	data: any;
	color?: string;
	xUnit?: string;
	yUnit?: string;
	logY?: boolean;
	hoverIndex?: number | null;
	cropStart?: number | null;
	cropEnd?: number | null;
	cropEditable?: boolean;           // Live mode: draggable crop handles that emit updates
	peak?: number | string | null;   // Postgres NUMERIC often arrives as a string over the API
	viewStart?: number | null;       // shared x-zoom window (x-units); null = full range
	viewEnd?: number | null;
	zoomTool?: boolean;              // when true, drag draws a rectangular zoom box
	overlay?: { f: number[]; amp: number[] } | null;   // FFT-only: dashed filtered spectrum
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
	secondXLabel?: string;
	// Pinned marker (x-units, seconds): a solid vertical line + tag, set by the host when a map
	// point is "shown in time". Optional; no marker by default.
	markX?: number | null;
	markLabel?: string;
	// The host shows a menu for `chartmenu`: only then is the browser's own right-click menu replaced.
	menu?: boolean;
}>();
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

const ML = 56, MR = 12, MT = 8, MB = 24;
// A second x-axis needs its own tick/label band above the plot — grow the top margin only
// when one is actually supplied, so charts without it keep today's exact layout.
const hasSecondX = computed(() => !!(props.secondXValues && props.secondXValues.length));
const MT_EFF = computed(() => (hasSecondX.value ? MT + 16 : MT));
// The y-axis unit shown on screen and in exports. A spectrum is the force amplitude in N rms; a
// chart whose host gave no unit shows none rather than a made-up one.
const yLabelUnit = computed(() => displayUnit(props.kind, props.yUnit || (props.kind === 'line' ? 'N' : '')) ?? '');
const yTitle = computed(() => yAxisTitle(props.kind, yLabelUnit.value));
const stroke = computed(() => props.color || '#0d9488');
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

// A "nice" step (1/2/5 * 10^n) so evenly-spaced x-ticks land on round numbers
// rather than arbitrary fractions.
function niceStep(rough: number): number {
	if (!(rough > 0)) return 1;
	const pow = 10 ** Math.floor(Math.log10(rough));
	const f = rough / pow;
	const nice = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
	return nice * pow;
}

const geom = computed(() => {
	const d = props.data;
	if (!d) return null;
	const xs: number[] = props.kind === 'env' ? d.t : d.f;
	if (!xs || xs.length < 2) return null;
	const W = w.value, Hh = h.value;
	const mt = MT_EFF.value;
	const plotH = Hh - mt - MB;
	const plotW = W - ML - MR;

	// Visible x-window (shared zoom). Snap the index range to the requested view
	// so the y-axis auto-rescales to just the zoomed data, and the x-axis spans
	// exactly the requested bounds (smooth, not sample-snapped).
	const dataX0 = xs[0], dataX1 = xs[xs.length - 1];
	let x0 = props.viewStart != null ? Math.max(dataX0, props.viewStart) : dataX0;
	let x1 = props.viewEnd != null ? Math.min(dataX1, props.viewEnd) : dataX1;
	if (!(x1 > x0)) { x0 = dataX0; x1 = dataX1; }
	let iA = 0, iB = xs.length - 1;
	while (iA < iB && xs[iA + 1] < x0) iA++;
	while (iB > iA && xs[iB - 1] > x1) iB--;

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
		lo = 0;
		for (let i = iA; i <= iB; i++) if (d.amp[i] > hi) hi = d.amp[i];
	}
	if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
	if (hi === lo) hi = lo + 1;

	const sx = (x: number) => ML + ((x - x0) / (x1 - x0)) * plotW;

	let sy: (y: number) => number;
	let yticks: { y: number; label: string }[];
	const useLog = props.logY === true && props.kind === 'line' && hi > 0;
	if (useLog) {
		let minPos = Infinity;
		for (let i = iA; i <= iB; i++) if (d.amp[i] > 0 && d.amp[i] < minPos) minPos = d.amp[i];
		if (!isFinite(minPos)) minPos = hi / 1e5;
		const loRaw = Math.max(minPos, hi / 1e5);          // clamp to 5 decades below peak
		const L0 = Math.log10(loRaw), L1 = Math.log10(hi);
		const den = (L1 - L0) || 1;
		sy = (y) => mt + (1 - (Math.log10(Math.max(y, loRaw)) - L0) / den) * plotH;
		yticks = [];
		for (let k = Math.ceil(L0); k <= Math.floor(L1); k++) yticks.push({ y: sy(10 ** k), label: niceNum(10 ** k) });
		if (yticks.length < 2) yticks = [loRaw, hi].map((v) => ({ y: sy(v), label: niceNum(v) }));
	} else {
		sy = (y) => mt + (1 - (y - lo) / (hi - lo)) * plotH;
		const vals = (props.kind === 'env' && lo < 0 && hi > 0) ? [hi, 0, lo] : [hi, (lo + hi) / 2, lo];
		yticks = vals.map((v) => ({ y: sy(v), label: niceNum(v) }));
	}

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
	} else {
		line = 'M';
		for (let i = iA; i <= iB; i++) line += `${sx(xs[i]).toFixed(1)},${sy(d.amp[i]).toFixed(1)} `;
	}

	// Evenly-spaced "regular" ticks at a nice round step, aimed at ~80px apart.
	const targetCount = Math.max(4, Math.min(12, Math.round(plotW / 80)));
	const step = niceStep((x1 - x0) / targetCount) || (x1 - x0) || 1;
	const xticks: { x: number; label: string }[] = [];
	const first = Math.ceil(x0 / step) * step;
	for (let v = first; v <= x1 + step * 1e-6; v += step) {
		if (v < x0 - step * 1e-6) continue;
		xticks.push({ x: sx(v), label: niceNum(v) });
	}
	if (xticks.length < 2) { xticks.length = 0; xticks.push({ x: sx(x0), label: niceNum(x0) }, { x: sx(x1), label: niceNum(x1) }); }

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

	const zeroY = (lo < 0 && hi > 0) ? sy(0) : null;

	// Filtered-spectrum overlay (FFT charts only): map the overlay's own (f,amp) through the
	// SAME sx/sy so it lands on the current axes/zoom; clipped to the visible x-window.
	let overlayLine = '';
	if (props.kind === 'line' && props.overlay && props.overlay.f.length > 1) {
		const of = props.overlay.f, oa = props.overlay.amp;
		let started = false;
		for (let i = 0; i < of.length; i++) {
			if (of[i] < x0 || of[i] > x1) { started = false; continue; }
			overlayLine += `${started ? 'L' : 'M'}${sx(of[i]).toFixed(1)},${sy(oa[i]).toFixed(1)} `;
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
	return { W, Hh, xs, x0, x1, iA, iB, lo, hi, sx, sy, areaPath, area, line, xticks, xticks2, yticks, zeroY, overlayLine, compareLines };
});

// The crop window is dragged continuously; kept out of `geom` so a drag frame only redraws the
// shaded window and handles, not the whole envelope, ticks and overlays.
const crop = computed(() => {
	const g = geom.value;
	if (!g) return { cropArea: '', cropStartX: null, cropEndX: null };
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
	return {
		cropArea,
		cropStartX: props.cropStart != null ? sx(props.cropStart) : null,
		cropEndX: props.cropEnd != null ? sx(props.cropEnd) : null,
	};
});

const hoverPt = computed(() => {
	const g = geom.value;
	const i = props.hoverIndex;
	if (!g || i == null || i < g.iA || i > g.iB) return null;
	const d = props.data;
	if (props.kind === 'env') {
		const mid = (d.min[i] + d.max[i]) / 2;
		return { px: g.sx(g.xs[i]), py: g.sy(mid),
			label: `${mid.toFixed(2)} ${yLabelUnit.value}`.trim(), sub: `${niceNum(g.xs[i])} ${props.xUnit || ''}`.trim() };
	}
	return { px: g.sx(g.xs[i]), py: g.sy(d.amp[i]),
		label: `${d.amp[i].toPrecision(3)}`, sub: `${niceNum(g.xs[i])} ${props.xUnit || 'Hz'}`.trim() };
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
	return hoverIndexAt(g.xs, g.x0, g.x1, (px - ML) / (g.W - ML - MR), g.iA, g.iB);
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
function onLeave() { emit('hover', null); }

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
		title: props.title, kind: props.kind, data: props.data, color: props.color, xUnit: props.xUnit,
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
	const frac = (px - ML) / (g.W - ML - MR);
	return g.x0 + Math.min(1, Math.max(0, frac)) * (g.x1 - g.x0);
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
	const g = geom.value!;
	return g.x0 + Math.min(1, Math.max(0, frac)) * (g.x1 - g.x0);
}
const zoomRect = ref<{ x: number; w: number } | null>(null);
let zoomDrag = false, zStartPx = 0;
function onZoomDown(ev: PointerEvent) {
	if (ev.button !== 0) return;   // right button opens the chart menu, it must not start a zoom box
	if (!props.zoomTool || !geom.value) return;
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
	if (!g) return;
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
			<span v-if="peakNum != null" class="chart-peak">peak {{ peakNum.toFixed(2) }} {{ yLabelUnit }}<template v-if="hasSecondX && secondXLabel"> · {{ secondXLabel }}</template></span>
			<span v-else-if="geom" class="chart-unit">{{ logY ? 'log ' : '' }}{{ yLabelUnit }}<template v-if="hasSecondX && secondXLabel"> · {{ secondXLabel }}</template></span>
		</div>
		<div ref="bodyEl" class="chart-body">
		<svg
			ref="svgEl" v-if="geom" :viewBox="`0 0 ${geom.W} ${geom.Hh}`" class="chart-svg" :class="{ zoomtool: zoomTool }"
			preserveAspectRatio="none" @mousemove="onMove" @mouseleave="onLeave" @wheel="onWheel" @contextmenu="onContextMenu"
			@pointerdown="onSvgDown" @pointermove="onSvgMove" @pointerup="onSvgUp" @pointercancel="onSvgUp"
		>
			<line v-for="(t, i) in geom.yticks" :key="'gy' + i" :x1="ML" :x2="geom.W - MR" :y1="t.y" :y2="t.y" class="fc-grid" stroke-width="0.5" />
			<line v-for="(t, i) in geom.xticks" :key="'gx' + i" :x1="t.x" :x2="t.x" :y1="MT_EFF" :y2="geom.Hh - MB" class="fc-grid" stroke-width="0.5" />
			<line v-if="geom.zeroY != null" :x1="ML" :x2="geom.W - MR" :y1="geom.zeroY" :y2="geom.zeroY" class="fc-zero" stroke-width="0.9" />
			<!-- full-range area at low saturation; the analysed [cropStart,cropEnd] window overpaints at full saturation -->
			<path v-if="kind === 'env'" :d="geom.area" :fill="stroke" :fill-opacity="crop.cropArea ? 0.09 : 0.2" :stroke="stroke" stroke-opacity="0.35" stroke-width="0.6" />
			<path v-if="kind === 'env' && crop.cropArea" :d="crop.cropArea" :fill="stroke" fill-opacity="0.28" :stroke="stroke" stroke-width="0.8" />
			<path v-if="kind === 'line'" :d="geom.line" fill="none" :stroke="stroke" stroke-width="1.1" />
			<path v-if="geom.overlayLine" :d="geom.overlayLine" fill="none" stroke="#0891b2" stroke-width="1" stroke-dasharray="3 2" opacity="0.9" />
			<!-- Comparison cuts, drawn over the primary envelope so the current cut stays the
				 visual subject and the others read as reference traces. -->
			<path v-for="c in geom.compareLines" :key="c.id" :d="c.d" fill="none"
				:stroke="c.color" stroke-width="1.2" stroke-dasharray="4 2" opacity="0.85" />
			<line :x1="ML" :x2="ML" :y1="MT_EFF" :y2="geom.Hh - MB" class="fc-axis" stroke-width="0.8" />
			<line :x1="ML" :x2="geom.W - MR" :y1="geom.Hh - MB" :y2="geom.Hh - MB" class="fc-axis" stroke-width="0.8" />
			<g v-for="(t, i) in geom.yticks" :key="'y' + i">
				<line :x1="ML - 3" :x2="ML" :y1="t.y" :y2="t.y" class="fc-axis" stroke-width="0.8" />
				<text :x="ML - 5" :y="t.y + 2.5" text-anchor="end" class="tick">{{ t.label }}</text>
			</g>
			<g v-for="(t, i) in geom.xticks" :key="'x' + i">
				<line :x1="t.x" :x2="t.x" :y1="geom.Hh - MB" :y2="geom.Hh - MB + 3" class="fc-axis" stroke-width="0.8" />
				<text :x="t.x" :y="geom.Hh - MB + 12" text-anchor="middle" class="tick">{{ t.label }}</text>
			</g>
			<text :x="(ML + geom.W - MR) / 2" :y="geom.Hh - 3" text-anchor="middle" class="axis-label">{{ xUnit }}</text>
			<text v-if="yTitle" :transform="`translate(10 ${(MT_EFF + geom.Hh - MB) / 2}) rotate(-90)`" text-anchor="middle" class="axis-label">{{ yTitle }}</text>
			<!-- Second x-axis (e.g. radial position) — mirrors the bottom axis (line at the plot's
			     top edge, ticks extending up into the grown top margin). Its unit label lives in the
			     chart-head row (chart-peak/chart-unit below), not here — the ~16px top-margin band
			     only has room for one text row before ascenders start clipping against the viewBox.
			     Blank where geom.xticks2 skipped a NaN (past a spiral's cut-out). -->
			<g v-if="hasSecondX">
				<line :x1="ML" :x2="geom.W - MR" :y1="MT_EFF" :y2="MT_EFF" class="fc-axis" stroke-width="0.8" />
				<g v-for="(t, i) in geom.xticks2" :key="'x2' + i">
					<line :x1="t.x" :x2="t.x" :y1="MT_EFF - 3" :y2="MT_EFF" class="fc-axis" stroke-width="0.8" />
					<text :x="t.x" :y="MT_EFF - 6" text-anchor="middle" class="tick">{{ t.label }}</text>
				</g>
			</g>
			<g v-if="hoverPt">
				<line :x1="hoverPt.px" :x2="hoverPt.px" :y1="MT_EFF" :y2="geom.Hh - MB" stroke="#64748b" stroke-width="0.6" stroke-dasharray="3 3" />
				<circle :cx="hoverPt.px" :cy="hoverPt.py" r="2.8" :fill="stroke" />
			</g>
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
		<div v-if="hoverPt" class="chart-tip"><strong>{{ hoverPt.label }}</strong><span>{{ hoverPt.sub }}</span></div>
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
.chart-unit { font-size: var(--fs-xs, 11px); color: var(--theme--foreground-subdued, #98a2b3); font-weight: 600; }
.chart-peak { font-size: var(--fs-xs, 11px); color: var(--theme--foreground, #1e293b); font-weight: 700; font-variant-numeric: tabular-nums; }
.chart-body { flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
.chart-svg { display: block; width: 100%; flex: 1 1 auto; min-height: 0; cursor: crosshair; touch-action: none; }
.chart-svg.zoomtool { cursor: crosshair; }
.chart-svg .tick { fill: var(--theme--foreground-subdued, #94a3b8); font-size: var(--fs-xs, 11px); font-variant-numeric: tabular-nums; }
.chart-svg .axis-label { fill: var(--theme--foreground-subdued, #94a3b8); font-size: var(--fs-xs, 11px); }
.chart-svg .crop-hit { cursor: ew-resize; }
/* dimmer than the near-white light-mode defaults so gridlines don't outshine the crop handles
   against a dark background; --border/--border-2 are theme-scoped in apps/force-app's styles.css */
.chart-svg .fc-grid { stroke: var(--border, #e2e8f0); }
.chart-svg .fc-axis { stroke: var(--border-2, #94a3b8); }
.chart-svg .fc-zero { stroke: var(--border-2, #cbd5e1); }
.chart-svg .fc-mark-line { stroke: var(--mark-color, #f59e0b); }
.chart-svg .fc-mark-tag { fill: var(--mark-color, #f59e0b); font-size: var(--fs-xs, 11px); font-weight: 700; font-variant-numeric: tabular-nums; paint-order: stroke; stroke: var(--theme--background, #fff); stroke-width: 3px; }
.chart-empty { flex: 1; display: grid; place-items: center; color: var(--theme--foreground-subdued, #98a2b3); font-size: var(--fs-sm, 12px); }
/* The accent, not a sky blue a shade off the Fz trace it is dragged across. */
.zoom-rect { fill: var(--accent, #38bdf8); fill-opacity: 0.16; stroke: var(--accent, #0ea5e9); stroke-width: 0.8; }
.chart-tip {
	/* below the header row so it never covers the "peak … N" readout in the top-right */
	position: absolute; top: 30px; right: 12px; display: flex; flex-direction: column; align-items: flex-end;
	background: color-mix(in srgb, var(--theme--background, #fff) 85%, transparent); border-radius: 8px; padding: 2px 7px; pointer-events: none;
}
.chart-tip strong { font-size: var(--fs-sm, 12px); font-variant-numeric: tabular-nums; }
.chart-tip span { font-size: var(--fs-xs, 11px); color: var(--theme--foreground-subdued, #98a2b3); }
</style>
