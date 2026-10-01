<script setup lang="ts">
// Equation builder for a virtual (computed) channel: a formula referencing other channels,
// evaluated live during acquisition and archived — see app/virtual_channels.py for the safe
// evaluator this validates against. Click a channel chip or operator to insert it at the cursor;
// validation is live (debounced) against the backend, which is the actual source of truth for
// what's allowed — this never re-implements the whitelist client-side, just calls it.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { channelColor } from '../record/types';
import { theme } from '../theme';
import { nidaqApi, CORE_REFERENCEABLE, type Channel, type FormulaValidation } from './nidaqApi';
import { useDialog } from '../ui/useDialog';

const props = defineProps<{
	/** Existing channels, for the reference palette — only "hardware" ones are referenceable
	 *  (formulas are flat: a virtual channel may never reference another virtual channel). */
	channels: Channel[];
	initialName?: string;
	initialFormula?: string;
}>();
const emit = defineEmits<{
	save: [name: string, formula: string];
	cancel: [];
}>();

const name = ref(props.initialName ?? '');
const formula = ref(props.initialFormula ?? '');
const formulaInput = ref<HTMLInputElement | null>(null);
const validation = ref<FormulaValidation | null>(null);
const validating = ref(false);

const hardwareExtras = computed(() =>
	props.channels.filter((c) => c.source === 'hardware' && !CORE_REFERENCEABLE.includes(c.name as any)),
);

function chipColor(name: string): string {
	return channelColor(name, theme.value) ?? props.channels.find((c) => c.name === name)?.color ?? '#94a3b8';
}

// Insert at the cursor, not just appended — building a formula by clicking chips in any order
// (e.g. click Fx, move the cursor back, click +, click Fy) is the whole point of a chip palette
// over a bare text field.
function insertAtCursor(text: string) {
	const el = formulaInput.value;
	const start = el?.selectionStart ?? formula.value.length;
	const end = el?.selectionEnd ?? formula.value.length;
	formula.value = formula.value.slice(0, start) + text + formula.value.slice(end);
	const caret = start + text.length;
	nextTick(() => { el?.focus(); el?.setSelectionRange(caret, caret); });
}

let debounce: ReturnType<typeof setTimeout> | null = null;
watch(formula, (v) => {
	validation.value = null;
	if (debounce) clearTimeout(debounce);
	if (!v.trim()) return;
	debounce = setTimeout(runValidate, 300);
});
async function runValidate() {
	validating.value = true;
	try { validation.value = await nidaqApi.validateFormula(formula.value); }
	catch { validation.value = { valid: false, error: "couldn't reach the recorder to check this" }; }
	finally { validating.value = false; }
}
onBeforeUnmount(() => { if (debounce) clearTimeout(debounce); });
const panel = ref<HTMLElement | null>(null);
useDialog(panel, () => emit('cancel'));

const canSave = computed(() => !!name.value.trim() && !!formula.value.trim() && validation.value?.valid === true);
function save() { if (canSave.value) emit('save', name.value.trim(), formula.value.trim()); }

const OPS = ['+', '-', '*', '/', '(', ')'] as const;
const FUNCS = [
	{ label: 'abs( )', insert: 'abs()', caretBack: 1 },
	{ label: '√( )', insert: 'sqrt()', caretBack: 1 },
	{ label: 'min( , )', insert: 'min(, )', caretBack: 3 },
	{ label: 'max( , )', insert: 'max(, )', caretBack: 3 },
] as const;
function insertFunc(f: (typeof FUNCS)[number]) {
	insertAtCursor(f.insert);
	// Land the cursor inside the parens, not after them — setSelectionRange above already put it
	// at the end of the inserted text, so step back the requested amount.
	const el = formulaInput.value;
	nextTick(() => {
		const pos = (el?.selectionStart ?? f.insert.length) - f.caretBack;
		el?.setSelectionRange(pos, pos);
	});
}
</script>

<template>
	<div class="vcb-backdrop dialog-backdrop-in" @click.self="emit('cancel')">
		<div ref="panel" class="vcb-modal dialog-in" role="dialog" aria-modal="true" aria-labelledby="vcb-title" tabindex="-1">
			<header class="vcb-head">
				<span class="material-symbols-rounded">functions</span>
				<b id="vcb-title">{{ initialName ? 'Edit virtual channel' : 'New virtual channel' }}</b>
			</header>
			<p class="vcb-lead">Computed live from other channels while recording, and archived in the capture — see Settings for what a virtual channel can and can't reference.</p>

			<label class="field">Name
				<input v-model="name" placeholder="e.g. Resultant" autofocus />
			</label>

			<label class="field">Formula
				<input
					ref="formulaInput" v-model="formula" class="formula-input"
					placeholder="e.g. sqrt(Fx*Fx + Fy*Fy)" spellcheck="false"
				/>
			</label>

			<div class="vcb-status" :class="{ ok: validation?.valid, bad: validation && !validation.valid }">
				<template v-if="validating"><span class="material-symbols-rounded spin">progress_activity</span> checking…</template>
				<template v-else-if="validation?.valid"><span class="material-symbols-rounded">check_circle</span> valid — reads {{ validation.references?.join(', ') || 'nothing' }}</template>
				<template v-else-if="validation && !validation.valid"><span class="material-symbols-rounded">error</span> {{ validation.error }}</template>
				<template v-else>&nbsp;</template>
			</div>

			<div class="vcb-palette">
				<div class="vcb-group">
					<span class="vcb-group-label">Operators</span>
					<div class="vcb-chips">
						<button v-for="op in OPS" :key="op" class="chip op" @click="insertAtCursor(op)">{{ op }}</button>
						<button v-for="f in FUNCS" :key="f.label" class="chip op fn" @click="insertFunc(f)">{{ f.label }}</button>
					</div>
				</div>
				<div class="vcb-group">
					<span class="vcb-group-label">Channels</span>
					<div class="vcb-chips">
						<button
							v-for="n in CORE_REFERENCEABLE" :key="n" class="chip"
							:style="{ '--chip-color': chipColor(n) }" @click="insertAtCursor(n)"
						>{{ n }}</button>
						<button
							v-for="c in hardwareExtras" :key="c.name" class="chip"
							:style="{ '--chip-color': chipColor(c.name) }" @click="insertAtCursor(c.name)"
						>{{ c.name }}</button>
					</div>
				</div>
			</div>

			<div class="vcb-actions">
				<button class="btn" @click="emit('cancel')">Cancel</button>
				<div class="vcb-spacer"></div>
				<button class="btn primary" :disabled="!canSave" @click="save">Save</button>
			</div>
		</div>
	</div>
</template>

<style scoped>
.vcb-backdrop { position: fixed; inset: 0; z-index: 260; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.55); backdrop-filter: blur(2px); padding: 24px; }
.vcb-modal { width: min(560px, 100%); max-height: 90vh; overflow: auto; display: flex; flex-direction: column; gap: 10px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 14px; padding: 20px; box-shadow: 0 30px 80px rgba(0,0,0,0.45); }
.vcb-head { display: flex; align-items: center; gap: 8px; }
.vcb-head .material-symbols-rounded { font-size: var(--icon-lg); color: var(--accent); }
.vcb-head b { font-size: var(--fs-lg); color: var(--text); }
.vcb-lead { margin: 0 0 4px; font-size: var(--fs-sm); color: var(--text-dim); line-height: 1.5; }
.field { display: block; font-size: var(--fs-sm); color: var(--text-dim); }
.field input { display: block; width: 100%; margin-top: 4px; padding: 8px 10px; font-size: var(--fs-md); color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; outline: none; box-sizing: border-box; }
.field input:focus { border-color: var(--accent); }
.formula-input { font-family: var(--mono); font-size: var(--fs-md) !important; }
.vcb-status { min-height: 18px; font-size: var(--fs-sm); display: flex; align-items: center; gap: 5px; color: var(--text-dim); }
.vcb-status .material-symbols-rounded { font-size: var(--icon-sm); }
.vcb-status.ok { color: var(--ok); }
.vcb-status.bad { color: #ef4444; }
.vcb-palette { display: flex; flex-direction: column; gap: 8px; padding: 10px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.vcb-group { display: flex; flex-direction: column; gap: 5px; }
.vcb-group-label { font-size: var(--fs-xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-dim); }
.vcb-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { --chip-color: var(--text-dim); padding: 5px 10px; font-size: var(--fs-sm); font-weight: 600; font-family: var(--mono); color: var(--chip-color); background: color-mix(in srgb, var(--chip-color) 14%, transparent); border: 1px solid color-mix(in srgb, var(--chip-color) 35%, transparent); border-radius: 999px; cursor: pointer; }
.chip:hover { background: color-mix(in srgb, var(--chip-color) 24%, transparent); }
.chip.op { --chip-color: var(--accent); font-family: inherit; }
.chip.op.fn { font-family: var(--mono); font-size: var(--fs-xs); }
.vcb-actions { display: flex; align-items: center; gap: 10px; margin-top: 2px; }
.vcb-spacer { flex: 1; }
</style>
