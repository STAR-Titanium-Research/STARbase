<script setup lang="ts">
// CloudCompare-style scalar-field colour scale editor: colormap + steps up top, then tabbed
// "Display ranges" (a histogram strip with four draggable handles -- two saturation, two
// displayed -- plus matching numeric inputs) and "Parameters" (symmetrical/always-show-zero/
// log/bar-visible). Fully controlled: reads only from `colorScale`, never holds its own copy, and
// every edit re-runs applyParams before emitting so invariants (symmetrical forcing both
// saturation handles together, always-show-zero widening to include 0, etc.) hold on every frame
// of a drag, not just on release -- CloudCompare's own symmetrical behaviour mirrors both sides
// live as you drag one, and the "displayed filter applies live" design decision (plan's decisions
// table) means every intermediate drag position must be a real, correctly-derived ColorScale.
//
// domainLo/domainHi are the histogram's value-axis bounds. They are NOT satMin/satMax -- the
// saturation range is typically a percentile clip *inside* the full data range, so its handles
// land partway along the strip. This is deliberate; don't collapse the two.
import { computed, ref, watch } from 'vue';
import { COLORMAPS, colormapLabel } from './liveCloud';
import type { ColorScale } from './colorScale';
import { applyParams } from './colorScale';
import type { Histogram } from './histogram';
import { curveHeightFrac, handleDragPatch, pickHandle, type HandleGeom, type HandleKey } from './scaleHandles';
import ColorBar from './ColorBar.vue';

const props = withDefaults(defineProps<{
	colorScale: ColorScale;
	domainLo: number;
	domainHi: number;
	histogram?: Histogram | null;
	locked?: boolean;
	unit?: string;
}>(), { histogram: null, locked: false, unit: '' });

const emit = defineEmits<{
	(e: 'update:colorScale', v: ColorScale): void;
	(e: 'update:locked', v: boolean): void;
}>();

const colormapNames = Object.keys(COLORMAPS);
const tab = ref<'range' | 'params'>('range');
// Must match the height ColorBar.vue's chart renders at -- the handle overlay is absolutely
// positioned on top of it and needs the exact same box to align the flag/circle markers with the
// curve and axis they're supposed to sit on.
const CHART_H = 90;

// Declared up here, not down with the rest of the drag handling: the axis watcher below runs
// immediately at setup and reads `dragging`, which would be in the temporal dead zone if it were
// still declared further down.
let dragging: HandleKey | null = null;
let lastDragged: HandleKey | null = null;

// The strip's x-axis, held separately from the domainLo/domainHi props and NOT updated while a
// drag is in flight. Hosts fall back to the colour scale's own satMin/satMax when no data range is
// known yet, which creates a feedback loop the moment a saturation handle moves: drag satMax ->
// scale narrows -> domain narrows -> the axis zooms in under the cursor and the handle appears
// pinned to the edge. Freezing the axis for the duration of a drag breaks that loop, and is the
// right behaviour regardless -- the axis should never move under an active drag.
// Widened to contain the saturation range as well as the data range. symmetrical (and
// always-show-zero) deliberately push satMin/satMax outside the data -- symmetrical turns a
// 25..35 N range into -35..35 -- and a strip that only spanned the data would pin those handles
// to its edge, where they can't be dragged or even read. Widening only; the axis never zooms in
// past the data range.
const axisLo = ref(props.domainLo);
const axisHi = ref(props.domainHi);
watch(
	() => [props.domainLo, props.domainHi, props.colorScale.satMin, props.colorScale.satMax] as const,
	(vals) => {
		if (dragging) return;
		const finite = vals.filter((v) => Number.isFinite(v));
		if (!finite.length) return;
		axisLo.value = Math.min(...finite);
		axisHi.value = Math.max(...finite);
	},
	{ immediate: true },
);

function commit(patch: Partial<ColorScale>) {
	const cur = props.colorScale;
	const next = applyParams({ ...cur, ...patch }, axisLo.value, axisHi.value);
	// An explicit saturation edit (a Sat field or a saturation handle) locks the scale; otherwise the
	// host's next auto range (a live recording reports one many times a second) would overwrite it.
	// Shaping params (symmetrical, always-show-zero) move the range too but don't lock: the host's
	// auto re-seed applies them to each new range anyway.
	const editsRange = 'satMin' in patch || 'satMax' in patch;
	if (!props.locked && editsRange && (next.satMin !== cur.satMin || next.satMax !== cur.satMax)) emit('update:locked', true);
	emit('update:colorScale', next);
}

// Writable computeds: each reads straight from the prop and emits a fresh, invariant-checked
// scale on write. Keeps this component prop-driven with no local state to fall out of sync.
const colormap = computed({ get: () => props.colorScale.colormap, set: (v: string) => commit({ colormap: v }) });
const steps = computed({
	get: () => props.colorScale.steps,
	set: (v: number) => commit({ steps: Math.max(2, Math.min(256, Math.round(v) || 256)) }),
});
const greyOutOfRange = computed({ get: () => props.colorScale.greyOutOfRange, set: (v: boolean) => commit({ greyOutOfRange: v }) });
const alwaysShowZero = computed({ get: () => props.colorScale.alwaysShowZero, set: (v: boolean) => commit({ alwaysShowZero: v }) });
const symmetrical = computed({ get: () => props.colorScale.symmetrical, set: (v: boolean) => commit({ symmetrical: v }) });
const logScale = computed({ get: () => props.colorScale.logScale, set: (v: boolean) => commit({ logScale: v }) });
const barVisible = computed({ get: () => props.colorScale.barVisible, set: (v: boolean) => commit({ barVisible: v }) });
const locked = computed({ get: () => props.locked, set: (v: boolean) => emit('update:locked', v) });

// Numeric range inputs mirror the handles. Displayed-range fields show the OPEN_DISP sentinel as
// the domain edge, not 1e20 -- typing back out through that clamp keeps the field usable. Display
// is rounded to 4 significant figures -- these are percentile-detected floats with a dozen-plus
// decimal digits, which overflowed the input's width and rendered visibly truncated ("-2.70…").
// Only the DISPLAY is rounded; a value the user types is committed exactly as typed, unrounded.
function roundForEdit(v: number): number {
	if (!Number.isFinite(v) || v === 0) return v;
	return Number(v.toPrecision(4));
}
function clampDisp(v: number): number { return Math.max(axisLo.value, Math.min(axisHi.value, v)); }
// A typed saturation end edits the unshaped base range too (baseMin/baseMax), so a shaping param
// ticked afterwards -- and unticked again -- still works from what was typed. Under symmetrical a
// typed end sets the magnitude, same as a handle drag.
function typedSat(key: 'satMin' | 'satMax', v: number): Partial<ColorScale> {
	if (props.colorScale.symmetrical && Number.isFinite(v)) {
		return handleDragPatch(props.colorScale, key, v, (axisHi.value - axisLo.value || 1) * 1e-6);
	}
	return key === 'satMin' ? { satMin: v, baseMin: v } : { satMax: v, baseMax: v };
}
const satMinInput = computed({ get: () => roundForEdit(props.colorScale.satMin), set: (v: number) => commit(typedSat('satMin', v)) });
const satMaxInput = computed({ get: () => roundForEdit(props.colorScale.satMax), set: (v: number) => commit(typedSat('satMax', v)) });
const dispMinInput = computed({ get: () => roundForEdit(clampDisp(props.colorScale.dispMin)), set: (v: number) => commit({ dispMin: v }) });
const dispMaxInput = computed({ get: () => roundForEdit(clampDisp(props.colorScale.dispMax)), set: (v: number) => commit({ dispMax: v }) });

// ---- Drag handles -------------------------------------------------------
const stripEl = ref<HTMLElement | null>(null);

function valueToPct(v: number): number {
	const span = axisHi.value - axisLo.value || 1e-9;
	const c = Math.max(axisLo.value, Math.min(axisHi.value, v));
	return ((c - axisLo.value) / span) * 100;
}
// Two marker styles, matching CloudCompare's own "Display ranges" look: saturation handles are
// the prominent flag (triangle at the top, dot riding the curve) since they drive the ramp/curve
// itself; displayed-range handles are a plain hollow circle at the top, marking where the
// grey/hidden filter begins without competing visually with the flags.
const handleDefs = computed<(HandleGeom & { dotBottom: number })[]>(() => {
	const s = props.colorScale;
	const mk = (key: HandleKey, v: number, style: 'flag' | 'circle') => {
		// Clamped a few px off the axis so the dot never half-sinks below the baseline where the
		// curve has no data (the common case out in the tails).
		const dotBottom = Math.max(3, curveHeightFrac(props.histogram, v) * CHART_H);
		return { key, style, pct: valueToPct(v), dotBottom, dotY: CHART_H - dotBottom };
	};
	return [
		mk('satMin', s.satMin, 'flag'),
		mk('satMax', s.satMax, 'flag'),
		mk('dispMin', s.dispMin, 'circle'),
		mk('dispMax', s.dispMax, 'circle'),
	];
});

function pxToValue(clientX: number): number {
	const r = stripEl.value!.getBoundingClientRect();
	const t = r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0;
	return axisLo.value + t * (axisHi.value - axisLo.value);
}

function hitTest(clientX: number, clientY: number): HandleKey | null {
	const r = stripEl.value!.getBoundingClientRect();
	return pickHandle(handleDefs.value, clientX - r.left, clientY - r.top, r.width, CHART_H, lastDragged);
}

function updateDrag(value: number) {
	if (!dragging) return;
	const EPS = (axisHi.value - axisLo.value || 1) * 1e-6;
	commit(handleDragPatch(props.colorScale, dragging, value, EPS));
}

function onStripPointerDown(ev: PointerEvent) {
	const key = hitTest(ev.clientX, ev.clientY);
	if (!key) return;
	dragging = key; lastDragged = key;
	(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
	updateDrag(pxToValue(ev.clientX));
}
function onStripPointerMove(ev: PointerEvent) {
	if (!dragging) return;
	updateDrag(pxToValue(ev.clientX));
}
function onStripPointerUp(ev: PointerEvent) {
	if (!dragging) return;
	dragging = null;
	try { (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId); } catch { /* already released */ }
}
</script>

<template>
	<div class="cse">
		<div class="cse-top">
			<select class="cse-cmap" v-model="colormap" title="Colormap">
				<option v-for="m in colormapNames" :key="m" :value="m">{{ colormapLabel(m) }}</option>
			</select>
			<label class="cse-steps" title="Ramp quantisation (2-256 bands)">
				Steps
				<input type="number" min="2" max="256" step="1" v-model.lazy.number="steps" />
			</label>
			<label class="chk cse-lock" title="Locked: keep this saturation range when the data changes. Editing the range locks it; unlocking returns to the automatic range.">
				<input type="checkbox" v-model="locked" /> Lock scale
			</label>
		</div>

		<!-- Own classes, not the host's .segmode/.segbtn: those are styled differently in each host
			 (ForceDashboard's accordion vs FrmPanel's toolbar) and dragged this control's sizing
			 around with them. -->
		<div class="cse-tabrow">
			<button type="button" class="cse-tab" :class="{ on: tab === 'range' }" @click="tab = 'range'">Display ranges</button>
			<button type="button" class="cse-tab" :class="{ on: tab === 'params' }" @click="tab = 'params'">Parameters</button>
		</div>

		<template v-if="tab === 'range'">
			<div ref="stripEl" class="cse-strip"
				@pointerdown="onStripPointerDown" @pointermove="onStripPointerMove"
				@pointerup="onStripPointerUp" @pointercancel="onStripPointerUp">
				<ColorBar :color-scale="colorScale" :domain-lo="axisLo" :domain-hi="axisHi" :histogram="histogram" :height="CHART_H" :unit="unit" />
				<!-- Sized to CHART_H, NOT 100% of .cse-strip -- ColorBar's own ticks/unit caption
					 render below the chart, and the handle overlay must only cover the chart itself
					 (where the flag/circle markers actually belong), not extend down over that text. -->
				<div class="cse-handles" :style="{ height: CHART_H + 'px' }">
					<div v-for="h in handleDefs" :key="h.key" class="cse-handle" :class="[h.key, h.style]" :style="{ left: h.pct + '%' }">
						<template v-if="h.style === 'flag'">
							<span class="cse-flag-tri" />
							<span class="cse-flag-line" :style="{ bottom: h.dotBottom + 'px' }" />
							<span class="cse-flag-dot" :style="{ bottom: h.dotBottom + 'px' }" />
						</template>
						<template v-else>
							<span class="cse-disp-circle" />
							<span class="cse-disp-line" />
						</template>
					</div>
				</div>
			</div>
			<div class="cse-numgrid">
				<label>Sat min<input type="number" v-model.lazy.number="satMinInput" /></label>
				<label>Sat max<input type="number" v-model.lazy.number="satMaxInput" /></label>
				<label>Disp min<input type="number" v-model.lazy.number="dispMinInput" /></label>
				<label>Disp max<input type="number" v-model.lazy.number="dispMaxInput" /></label>
			</div>
		</template>
		<template v-else>
			<div class="cse-params">
				<label class="chk"><input type="checkbox" v-model="greyOutOfRange" /> Grey out-of-range <span class="cse-hint">(unchecked = hide)</span></label>
				<label class="chk"><input type="checkbox" v-model="alwaysShowZero" /> Always show zero</label>
				<label class="chk"><input type="checkbox" v-model="symmetrical" /> Symmetrical about zero</label>
				<label class="chk"><input type="checkbox" v-model="logScale" /> Log scale</label>
				<label class="chk"><input type="checkbox" v-model="barVisible" /> Show colour bar on render</label>
			</div>
		</template>
	</div>
</template>

<style scoped>
.cse {
	/* App tokens, falling back to the Directus theme when this renders inside the admin. */
	--fp-accent: var(--accent, var(--theme--primary, #1d4ed8));
	--fp-accent-ink: var(--accent-ink, var(--theme--foreground-inverted, #fff));
	--fp-border: var(--border, var(--theme--border-color-subdued, #e7ebf0));
	--fp-surface: var(--surface, var(--theme--background-subdued, #f7f9fb));
	--fp-text: var(--text, var(--theme--foreground, #1e293b));
	--fp-text-dim: var(--text-dim, var(--theme--foreground-subdued, #6b7684));
	display: flex; flex-direction: column; gap: 10px; min-width: 0;
}
.cse-top { display: flex; align-items: center; gap: 8px 14px; flex-wrap: wrap; }
.cse-cmap { padding: 5px 7px; font-size: var(--fs-sm, 12px); color: var(--fp-text); background: var(--fp-surface); border: 1px solid var(--fp-border); border-radius: 7px; min-width: 0; }
.cse-steps { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm, 12px); color: var(--fp-text-dim); white-space: nowrap; }
.cse-steps input { width: 52px; padding: 4px 6px; font-size: var(--fs-sm, 12px); background: var(--fp-surface); border: 1px solid var(--fp-border); border-radius: 6px; color: var(--fp-text); }
.cse-lock { white-space: nowrap; }
.chk { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm, 12px); color: var(--fp-text-dim); cursor: pointer; }
.chk.wide { grid-column: 1 / -1; }
.cse-hint { opacity: 0.7; }
.cse-tabrow { display: flex; gap: 4px; width: 100%; }
.cse-tab {
	flex: 1 1 0; min-width: 0; box-sizing: border-box;
	padding: 6px 8px; font: inherit; font-size: var(--fs-sm, 12px); line-height: 1.2; font-weight: 500;
	text-align: center; white-space: nowrap;
	color: var(--fp-text-dim); background: var(--fp-surface);
	border: 1px solid var(--fp-border); border-radius: 7px; cursor: pointer;
}
.cse-tab.on { background: var(--fp-accent); color: var(--fp-accent-ink); font-weight: 600; border-color: var(--fp-accent); }

.cse-strip { position: relative; touch-action: none; }
.cse-handles { position: absolute; top: 0; left: 0; right: 0; pointer-events: none; }
/* width: 1px (not 0) -- a zero-area element reads as hidden to automation/accessibility tooling
   even though its children (positioned via negative margin) render fine visually. */
.cse-handle { position: absolute; top: 0; bottom: 0; width: 1px; margin-left: -0.5px; cursor: ew-resize; pointer-events: auto; }

/* Saturation handles: a downward triangle at the chart top, a stem running the full chart height,
   and a dot on the axis -- these drive the ramp/curve itself, so they get the strongest weight. */
.cse-handle.flag { z-index: 2; }
/* Neutral, NOT the accent colour: these markers sit on top of a user-selectable colour ramp, so any
   palette hue collides with some colormap -- an amber accent disappears into the yellow end of
   viridis, a cyan one into its blue-green middle, and grayscale eats anything desaturated. White
   with a dark outline reads against every ramp we ship. */
.cse-flag-tri { position: absolute; top: 0; left: 0; width: 0; height: 0; margin-left: -6px; border-left: 6px solid transparent; border-right: 6px solid transparent; border-top: 8px solid #fff; filter: drop-shadow(0 0 1.5px rgba(0, 0, 0, 0.9)); }
/* `bottom` on both is set inline per handle so the stem stops at, and the dot sits on, the
   distribution curve at that handle's own x position. */
.cse-flag-line { position: absolute; top: 8px; left: 0; width: 2px; margin-left: -1px; background: #fff; opacity: 0.9; box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.7); pointer-events: none; }
.cse-flag-dot { position: absolute; left: 0; width: 7px; height: 7px; margin-left: -3.5px; margin-bottom: -3.5px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 1.5px rgba(0, 0, 0, 0.7); box-sizing: border-box; }

/* Displayed-range handles: a hollow circle centred on its grey-wall edge, with the stem running
   the full chart height as the wall edge itself -- deliberately lighter-weight than the flags,
   matching CloudCompare's own secondary marker for this range. */
.cse-handle.circle { z-index: 1; }
.cse-disp-circle { position: absolute; top: 50%; left: 0; width: 12px; height: 12px; margin-left: -6px; margin-top: -6px; border-radius: 50%; background: var(--fp-surface); border: 2px solid var(--fp-text-dim); box-sizing: border-box; z-index: 1; }
.cse-disp-line { position: absolute; top: 0; bottom: 0; left: 0; width: 2px; margin-left: -1px; background: var(--fp-text-dim); opacity: 0.6; pointer-events: none; }

/* 2 columns, not 4: a 4-across grid in a narrow sidebar left each number input ~60px wide,
   truncating even a rounded value -- see roundForEdit()'s comment for the other half of this fix. */
.cse-numgrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; align-items: end; margin-top: 2px; }
.cse-numgrid label { display: flex; flex-direction: column; gap: 3px; font-size: var(--fs-xs, 11px); color: var(--fp-text-dim); min-width: 0; }
.cse-numgrid input[type="number"] { padding: 5px 7px; font-size: var(--fs-sm, 12px); background: var(--fp-surface); border: 1px solid var(--fp-border); border-radius: 6px; color: var(--fp-text); width: 100%; min-width: 0; box-sizing: border-box; }
.cse-params { display: flex; flex-direction: column; gap: 10px; }
</style>
