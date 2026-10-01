<script setup lang="ts">
// A single numeric cut-parameter card: big value + unit, small caps label below. Two modes off the
// same markup — `editable` wraps a real number input (styled to read as plain text until focused),
// used for the sim/nidaq recording config; without it, the card is a plain readout, used for a
// picked replay cut's actual parameters. One component so both stay visually identical.
import { computed } from 'vue';
withDefaults(defineProps<{
	label: string;
	unit?: string;
	editable?: boolean;
	disabled?: boolean;
	step?: string | number;
	title?: string;
	/** #46: flags the field immediately (an info icon + the tile's title tooltip) when its current
	 *  value is known to be out of bounds -- e.g. a sample rate the assigned NI-DAQ hardware can't
	 *  actually deliver -- rather than only surfacing as a raw acquisition-time error once a
	 *  recording has already started. */
	invalid?: boolean;
}>(), { editable: false, step: 'any' });
const model = defineModel<number | string>();
// Read-only values often arrive as floats decoded from a float32 wire/cache format (e.g. the D1LC
// header) round-tripped through JS's double precision — 0.05 comes back as 0.05000000745058059.
// Round away that binary noise instead of showing it (and overflowing the tile).
const display = computed(() => {
	const v = model.value;
	if (typeof v === 'number' && Number.isFinite(v)) return Number(v.toPrecision(6));
	return v;
});
// Units sit to the RIGHT of the value (horizontal space is the plentiful one here), so in a tight
// tile something has to give — and it must be the unit, never the number: "0.05" clipped to "0.0"
// is a wrong reading, "mm/r…" is not. The input can't shrink below its own digits (tabular
// figures are 1ch each).
const valueMinWidth = computed(() => `${Math.max(1, String(model.value ?? '').length) + 0.4}ch`);
</script>

<template>
	<div class="stat-tile" :class="{ invalid }" :title="title">
		<div class="value">
			<input v-if="editable" type="number" :step="step" v-model.number="model" :disabled="disabled" :style="{ minWidth: valueMinWidth }" />
			<span v-else class="value-text">{{ display }}</span>
			<span v-if="unit" class="unit" :title="unit">{{ unit }}</span>
			<span v-if="invalid" class="material-symbols-rounded warn-icon">info</span>
		</div>
		<div class="label">{{ label }}</div>
	</div>
</template>

<style scoped>
.stat-tile { padding: 10px 12px; background: var(--bg-3); border: 1px solid var(--border); border-radius: 10px; min-width: 0; overflow: hidden; container: stat / inline-size; }
.stat-tile.invalid { border-color: var(--warn); background: color-mix(in srgb, var(--warn) 8%, transparent); }
.warn-icon { font-size: var(--icon-sm); color: var(--warn); margin-left: auto; }
.value { display: flex; align-items: baseline; gap: 5px; min-width: 0; }
.value input, .value-text { font-size: var(--fs-lg); font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; min-width: 0; }
.value-text { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.value input { flex: 1 1 0%; padding: 0; background: transparent; border: none; border-bottom: 1px dashed color-mix(in srgb, var(--text) 22%, transparent); outline: none; }
/* No spinner: Chromium reserves its width inside the box even while hidden, which is what clipped
   "0.05" to "0.0" in a tight tile. Arrow keys and the wheel still step the value (the Plot page's
   stat inputs already drop it the same way). */
.value input { appearance: textfield; -moz-appearance: textfield; }
.value input::-webkit-inner-spin-button, .value input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.value input:focus { border-bottom-color: var(--accent); }
.value input:disabled { opacity: 0.6; }
/* Shrinks long before the value does (flex-shrink 100 vs 1), and only then ellipsizes. */
.unit { flex: 0 100 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-xs); font-weight: 600; color: var(--text-dim); }
/* Tight tiles (the Recording panel at laptop widths) step the type down a notch so value AND unit
   still fit side by side. */
@container stat (max-width: 84px) {
	.value { gap: 3px; }
	.value input, .value-text { font-size: var(--fs-md); }
	.unit { font-size: var(--fs-xs); }
}
/* Sentence case comes from the global label rule in styles.css; the size/weight here are the
   originals. */
.label { margin-top: 3px; font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.07em; color: var(--text-dim); }
</style>
