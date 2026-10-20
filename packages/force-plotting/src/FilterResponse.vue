<script setup lang="ts">
// Signal-filter preview: the gain (dB) of the filter chain against log frequency, drawn from the
// analytic response in filterResponse.ts, so it works offline and updates as the stage rows are
// edited; applying the chain to data stays on the filter service. The combined curve is solid and
// each stage dashed. Cut-off and notch frequencies carry drag handles (arrow keys nudge them) that
// emit an updated chain, and a hover read-out gives the gain under the pointer.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { FilterChain } from './filterChain';
import { axisLabels, labelsThatFit, logTicks } from './chartAxis';
import { filterResponse, fmtHz, logFrequencies, type StageId } from './filterResponse';

const props = withDefaults(defineProps<{
	chain: FilterChain;
	nyquist?: number;          // Hz; the sample rate / 2 of the data the chain will run on
	rpm?: number | null;       // notch harmonics are multiples of rpm / 60
	// Filter passes. The service runs every stage zero-phase (forward and back), so the gain it
	// applies is twice the textbook figure: -6 dB at a cut-off, not -3.
	passes?: number;
	height?: number;
}>(), { nyquist: 12800, passes: 2, height: 190 });
const emit = defineEmits<{ (e: 'update:chain', v: FilterChain): void }>();

const ML = 46, MR = 14, MT = 22, MB = 36;
const Y_MIN = -60, Y_TICKS = [0, -20, -40, -60];
const X_LO = 1;            // the axis, and the lowest frequency a handle can be dragged to
const STAGE_COLOR: Record<StageId, string> = {
	detrend: 'var(--theme--foreground-subdued, #64748b)',
	highpass: 'var(--d1-series-1, #2a78d6)',
	lowpass: 'var(--d1-series-2, #eb6834)',
	notch: 'var(--d1-series-3, #1baf7a)',
};
const STAGE_NAME: Record<StageId, string> = { detrend: 'Detrend', highpass: 'High-pass', lowpass: 'Low-pass', notch: 'Notch' };

const svgEl = ref<SVGSVGElement | null>(null);
const w = ref(330);
let ro: ResizeObserver | undefined;
onMounted(() => {
	ro = new ResizeObserver((e) => { const r = e[e.length - 1].contentRect; if (r.width > 0) w.value = Math.round(r.width); });
	if (svgEl.value?.parentElement) ro.observe(svgEl.value.parentElement);
});
onBeforeUnmount(() => { ro?.disconnect(); if (raf) cancelAnimationFrame(raf); });

const plotW = computed(() => Math.max(40, w.value - ML - MR));
const plotH = computed(() => props.height - MT - MB);
const opts = computed(() => ({ nyquist: props.nyquist, rpm: props.rpm, passes: props.passes }));

const xHi = computed(() => Math.max(props.nyquist, X_LO * 100));
const maxHz = computed(() => props.nyquist * 0.99);
const sx = (f: number) => ML + ((Math.log10(Math.max(f, X_LO)) - Math.log10(X_LO)) / (Math.log10(xHi.value) - Math.log10(X_LO))) * plotW.value;
const sy = (db: number) => MT + (Math.min(0, Math.max(Y_MIN, db)) / Y_MIN) * plotH.value;
const fAt = (px: number) => {
	const a = Math.log10(X_LO), b = Math.log10(xHi.value);
	return 10 ** (a + Math.min(1, Math.max(0, (px - ML) / plotW.value)) * (b - a));
};

const curves = computed(() => {
	const f = logFrequencies(X_LO, props.nyquist, Math.max(60, Math.round(plotW.value / 2)));
	const r = filterResponse(props.chain, f, opts.value);
	const path = (db: number[]) => db.map((v, i) => `${i ? 'L' : 'M'}${sx(f[i]).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
	return { combined: path(r.combined), stages: r.stages.map((s) => ({ id: s.id, label: s.label, d: path(s.db) })) };
});
const ticks = computed(() => {
	const t = logTicks(X_LO, xHi.value);
	return { major: t.major.map((f) => ({ x: sx(f), label: fmtHz(f, false) })), minor: t.minor.map(sx) };
});
const yLabels = axisLabels(Y_TICKS);

// ---- drag handles: a cut-off per HP / LP / detrend stage, one per notch harmonic ----
interface Handle { key: string; stage: StageId; k: number; f: number; x: number; y: number; label: string; name: string }
const f0 = computed(() => (props.rpm ?? 0) / 60);
const handles = computed<Handle[]>(() => {
	const c = props.chain, out: Handle[] = [];
	const cut = (stage: 'detrend' | 'highpass' | 'lowpass', on: boolean, f: number) => {
		if (on && f < props.nyquist) out.push({ key: stage, stage, k: 0, f, x: sx(f), y: sy(-3 * props.passes), label: fmtHz(f), name: `${STAGE_NAME[stage]} cut-off` });
	};
	cut('detrend', c.detrend.on && c.detrend.mode === 'highpass', c.detrend.cutoff_hz);
	cut('highpass', c.highpass.on, c.highpass.cutoff_hz);
	cut('lowpass', c.lowpass.on, c.lowpass.cutoff_hz);
	if (c.notch.on && f0.value > 0) {
		c.notch.harmonics.forEach((h, k) => {
			const f = f0.value * h;
			if (f > 0 && f < props.nyquist) out.push({ key: `notch${k}`, stage: 'notch', k, f, x: sx(f), y: sy(Y_MIN), label: fmtHz(f), name: `Notch ${h}× frequency` });
		});
	}
	return out;
});
const pillW = (label: string) => label.length * 6.2 + 10;
const pillX = (x: number, label: string) => Math.min(ML + plotW.value - pillW(label), Math.max(ML, x - pillW(label) / 2));
// Pills above/below each handle; one that would run into its neighbour (the notch harmonics sit close
// together on a log axis) is left out, its handle still readable from its aria-valuetext.
const pills = computed(() => {
	const hs = handles.value;
	const keep = labelsThatFit(hs.map((h) => ({ x0: pillX(h.x, h.label), x1: pillX(h.x, h.label) + pillW(h.label) })), 3);
	return hs.filter((_, i) => keep[i]).map((h) => ({ key: h.key, label: h.label, x: pillX(h.x, h.label), y: h.stage === 'notch' ? h.y - 24 : h.y + 9 }));
});

// The chain with one cut-off, or one notch harmonic, replaced; copies only what changed.
function withCutoff(stage: 'detrend' | 'highpass' | 'lowpass', hz: number): FilterChain {
	return { ...props.chain, [stage]: { ...props.chain[stage], cutoff_hz: hz } };
}
function withHarmonic(k: number, harmonic: number): FilterChain {
	const n = props.chain.notch;
	return { ...props.chain, notch: { ...n, harmonics: n.harmonics.map((v, i) => (i === k ? harmonic : v)) } };
}
const round2 = (v: number) => Number(v.toFixed(2));
// A dragged frequency becomes a cut-off (three significant figures) or, for a notch, a harmonic
// number (the service's rule is harmonic x rotation frequency), to two decimals.
function chainAt(h: Handle, f: number): FilterChain {
	const fc = Math.min(maxHz.value, Math.max(X_LO, f));
	return h.stage === 'notch' ? withHarmonic(h.k, Math.max(0.01, round2(fc / f0.value))) : withCutoff(h.stage, Number(fc.toPrecision(3)));
}

// Raw pointermove can outrun the screen (and every emit re-renders the chain editor and the curves),
// so a drag emits at most once per frame, like ForceChart's crop handles; release lands exactly.
let drag: Handle | null = null;
const dragging = ref(false);   // for the template: the read-out hides while a handle moves
let raf = 0;
let pendingF = 0;
function px(ev: PointerEvent | MouseEvent): number {
	const r = svgEl.value!.getBoundingClientRect();
	return (ev.clientX - r.left) * (w.value / r.width);
}
function onDown(h: Handle, ev: PointerEvent) {
	if (ev.button !== 0) return;
	drag = h; dragging.value = true;
	(ev.currentTarget as Element).setPointerCapture(ev.pointerId);
	ev.stopPropagation();
}
function onDragMove(ev: PointerEvent) {
	if (!drag) return;
	pendingF = fAt(px(ev));
	if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (drag) emit('update:chain', chainAt(drag, pendingF)); });
}
function onUp(ev: PointerEvent) {
	if (drag) {
		if (raf) { cancelAnimationFrame(raf); raf = 0; }
		emit('update:chain', chainAt(drag, fAt(px(ev))));
	}
	drag = null; dragging.value = false;
	try { (ev.currentTarget as Element).releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
}
// Arrow keys step 5% (Shift: 5 steps). A notch's harmonic is rounded to 0.01, so near the bottom of
// its range 5% is less than a step: it moves by 0.01 instead of stalling.
function onKey(h: Handle, ev: KeyboardEvent) {
	const dir = ev.key === 'ArrowRight' || ev.key === 'ArrowUp' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowDown' ? -1 : 0;
	if (!dir) return;
	ev.preventDefault();
	const mult = ev.shiftKey ? 5 : 1, factor = 1.05 ** (dir * mult);
	if (h.stage !== 'notch') { emit('update:chain', chainAt(h, h.f * factor)); return; }
	const cur = round2(props.chain.notch.harmonics[h.k]);
	let next = round2(cur * factor);
	if (next === cur) next = round2(cur + dir * 0.01 * mult);
	emit('update:chain', withHarmonic(h.k, Math.max(0.01, Math.min(round2(maxHz.value / f0.value), next))));
}

// ---- hover read-out: gain of the whole chain under the pointer ----
const hover = ref<{ x: number; f: number; db: number } | null>(null);
function onMove(ev: PointerEvent) {
	onDragMove(ev);
	const x = px(ev);
	if (drag || x < ML || x > ML + plotW.value) { hover.value = drag ? hover.value : null; return; }
	const f = fAt(x);
	hover.value = { x, f, db: filterResponse(props.chain, [f], opts.value).combined[0] };
}
const readout = computed(() => {
	const hv = hover.value;
	if (!hv) return null;
	const text = `${fmtHz(hv.f)} · ${hv.db <= Y_MIN ? '< ' + String(Y_MIN).replace('-', '−') : hv.db.toFixed(0).replace('-', '−')} dB`;
	const wText = text.length * 6.2 + 12;
	return { text, wText, x: Math.min(ML + plotW.value - wText, Math.max(ML, hv.x - wText / 2)) };
});
const legend = computed(() => [{ id: 'combined', label: 'Combined' }, ...curves.value.stages.map((s) => ({ id: s.id, label: s.label }))]);
</script>

<template>
	<div class="fresp">
		<div class="fresp-key">
			<span v-for="l in legend" :key="l.id" class="fresp-key-item">
				<svg width="18" height="6" aria-hidden="true">
					<line x1="0" x2="18" y1="3" y2="3" stroke-width="2" :class="l.id === 'combined' ? 'fresp-combined' : ''"
						:style="l.id === 'combined' ? undefined : { stroke: STAGE_COLOR[l.id as StageId] }" :stroke-dasharray="l.id === 'combined' ? undefined : '4 3'" />
				</svg>{{ l.label }}
			</span>
		</div>
		<svg ref="svgEl" :viewBox="`0 0 ${w} ${height}`" :width="w" :height="height" class="fresp-svg"
			@pointermove="onMove" @pointerleave="hover = null" @pointerup="onUp" @pointercancel="onUp">
			<line v-for="(x, i) in ticks.minor" :key="'m' + i" :x1="x" :x2="x" :y1="MT" :y2="MT + plotH" class="fr-grid minor" />
			<line v-for="(t, i) in ticks.major" :key="'gx' + i" :x1="t.x" :x2="t.x" :y1="MT" :y2="MT + plotH" class="fr-grid" />
			<line v-for="(v, i) in Y_TICKS" :key="'gy' + i" :x1="ML" :x2="ML + plotW" :y1="sy(v)" :y2="sy(v)" class="fr-grid" />
			<path v-for="s in curves.stages" :key="s.id" :d="s.d" fill="none" :style="{ stroke: STAGE_COLOR[s.id] }" stroke-width="1.5" stroke-dasharray="4 3" />
			<path :d="curves.combined" fill="none" class="fresp-combined" stroke-width="2" stroke-linejoin="round" />
			<line :x1="ML" :x2="ML" :y1="MT" :y2="MT + plotH" class="fr-axis" />
			<line :x1="ML" :x2="ML + plotW" :y1="MT + plotH" :y2="MT + plotH" class="fr-axis" />
			<g v-for="(v, i) in Y_TICKS" :key="'y' + i">
				<line :x1="ML - 4" :x2="ML" :y1="sy(v)" :y2="sy(v)" class="fr-axis" />
				<text :x="ML - 7" :y="sy(v) + 4" text-anchor="end" class="fr-tick">{{ yLabels[i] }}</text>
			</g>
			<g v-for="(t, i) in ticks.major" :key="'x' + i">
				<line :x1="t.x" :x2="t.x" :y1="MT + plotH" :y2="MT + plotH + 4" class="fr-axis" />
				<text :x="t.x" :y="MT + plotH + 16" text-anchor="middle" class="fr-tick">{{ t.label }}</text>
			</g>
			<text x="4" y="12" class="fr-title">Gain (dB)</text>
			<text :x="ML + plotW / 2" :y="height - 6" text-anchor="middle" class="fr-title">Frequency (Hz)</text>
			<g v-if="hover && !dragging" pointer-events="none">
				<line :x1="hover.x" :x2="hover.x" :y1="MT" :y2="MT + plotH" class="fr-cursor" />
			</g>
			<g v-for="p in pills" :key="'p' + p.key" pointer-events="none">
				<rect :x="p.x" :y="p.y" :width="pillW(p.label)" height="14" rx="3" class="fr-pill" />
				<text :x="p.x + pillW(p.label) / 2" :y="p.y + 10.5" text-anchor="middle" class="fr-pill-text">{{ p.label }}</text>
			</g>
			<g v-for="h in handles" :key="h.key">
				<!-- the focusable, draggable target is wider than the dot; the dot and the focus ring follow it -->
				<circle :cx="h.x" :cy="h.y" r="12" class="fr-hit" tabindex="0" role="slider" :aria-label="h.name"
					:aria-valuenow="Math.round(h.f)" :aria-valuetext="h.label" :aria-valuemin="X_LO" :aria-valuemax="Math.floor(maxHz)"
					@pointerdown="onDown(h, $event)" @keydown="onKey(h, $event)" />
				<circle :cx="h.x" :cy="h.y" r="5.5" class="fr-handle" :style="{ '--hc': STAGE_COLOR[h.stage] }" pointer-events="none" />
				<circle :cx="h.x" :cy="h.y" r="9.5" class="fr-focus" pointer-events="none" />
			</g>
			<g v-if="readout && !dragging" pointer-events="none">
				<rect :x="readout.x" :y="MT + plotH - 20" :width="readout.wText" height="15" rx="3" class="fr-readout" />
				<text :x="readout.x + readout.wText / 2" :y="MT + plotH - 9" text-anchor="middle" class="fr-readout-text">{{ readout.text }}</text>
			</g>
		</svg>
	</div>
</template>

<style scoped>
.fresp { min-width: 0; }
.fresp-key { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: var(--fs-xs, 11px); color: var(--theme--foreground-subdued, #64748b); margin-bottom: 2px; }
.fresp-key-item { display: inline-flex; align-items: center; gap: 5px; }
.fresp-svg { display: block; width: 100%; touch-action: none; user-select: none; }
.fr-grid { stroke: var(--d1-grid, var(--border, #edf0f2)); stroke-width: 1; }
.fr-grid.minor { stroke-opacity: 0.5; }
.fr-axis { stroke: var(--d1-axis, var(--border-2, #94a3b8)); stroke-width: 1; }
.fr-tick { fill: var(--theme--foreground-subdued, #94a3b8); font-size: var(--fs-xs, 11px); font-variant-numeric: tabular-nums; }
.fr-title { fill: var(--theme--foreground-subdued, #94a3b8); font-size: var(--fs-xs, 11px); font-weight: 600; }
.fresp-combined { stroke: var(--theme--foreground, #1e293b); }
.fr-cursor { stroke: var(--theme--foreground-subdued, #64748b); stroke-opacity: 0.6; stroke-width: 1; }
.fr-hit { fill: transparent; cursor: ew-resize; outline: none; }
.fr-handle { fill: var(--theme--background, #fff); stroke: var(--hc, #1e293b); stroke-width: 2; }
.fr-hit:hover + .fr-handle { stroke-width: 3; }
.fr-focus { fill: none; stroke: var(--theme--primary, #2a78d6); stroke-width: 2; opacity: 0; }
.fr-hit:focus-visible ~ .fr-focus { opacity: 1; }
.fr-pill { fill: var(--theme--foreground, #1e293b); }
.fr-pill-text { fill: var(--theme--background, #fff); font-size: var(--fs-xs, 11px); font-weight: 600; font-variant-numeric: tabular-nums; }
.fr-readout { fill: var(--theme--background, #fff); stroke: var(--d1-axis, var(--border-2, #94a3b8)); stroke-width: 1; }
.fr-readout-text { fill: var(--theme--foreground, #1e293b); font-size: var(--fs-xs, 11px); font-variant-numeric: tabular-nums; }
</style>
