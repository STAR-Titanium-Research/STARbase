<script setup lang="ts">
// The dialog of one bulk action (spec section 1), opened from the "With N selected" menu. Step 1: choose the target (an Edit entry asks
// for the new value; Restrict and Unrestrict need none). Step 2 happens by itself: the dry run asks the server what each ticked row
// would do, and the dialog says "38 can be changed. 12 will be skipped" with the skipped rows folded under their reasons. Step 3: Apply to 38
// (disabled at 0). State and requests live in useBulkActions; this draws them.
//
// Same conventions as AccessDialog: a backdrop (a click on it closes), Escape closes, Tab cycles inside, focus goes to the first
// control on opening and is handed back (`restoreFocus`: the menu button) when it closes, however it closes. Errors are role="alert".
import { computed, nextTick, ref, watch } from 'vue';
import '../components/tokens.css';
import type { IndexDef } from '../index/indexConfig';
import BulkSkips from './BulkSkips.vue';
import { applyLabel, canClear, dialogTitle, enumChoices, previewSkips } from './bulkModel';
import type { BulkState } from './useBulkActions';

const props = defineProps<{
	bulk: BulkState;
	def: IndexDef;
	/** Called after the dialog closes: gives focus back to the menu button. */
	restoreFocus: () => void;
}>();

const uid = `d1-bulk-${Math.random().toString(36).slice(2, 8)}`;
const dialog = ref<HTMLElement | null>(null);
const heading = ref<HTMLElement | null>(null);

const state = computed(() => props.bulk.dialog);
const field = computed(() => state.value?.entry.field ?? null);
const title = computed(() => (state.value ? dialogTitle(state.value.entry, props.def, state.value.ids.length) : ''));
const fieldName = computed(() => (field.value ? field.value.label.charAt(0).toLowerCase() + field.value.label.slice(1) : ''));
const selected = computed(() => {
	const choice = state.value?.choice;
	return choice && choice.value !== null ? String(choice.value) : '';
});
const cleared = computed(() => state.value?.choice?.value === null);
const choices = computed(() => {
	const f = field.value;
	if (!f) return [];
	if (f.kind === 'bool') return [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }];
	if (f.kind === 'relation') return props.bulk.fieldOptions;
	return enumChoices(props.def, f);
});
const rows = computed(() => props.bulk.preview.rows);
const skips = computed(() => previewSkips(rows.value ?? []));
const applyText = computed(() => (props.bulk.applying ? 'Applying…' : applyLabel(props.bulk.counts.ok)));

function onSelect(e: Event): void {
	const value = (e.target as HTMLSelectElement).value;
	if (!value) return;
	if (field.value?.kind === 'bool') props.bulk.choose(value === 'true');
	else props.bulk.choose(value, choices.value.find((c) => c.value === value)?.label);
}
function onDate(e: Event): void {
	const value = (e.target as HTMLInputElement).value;
	// An emptied date box is not a choice: clearing the field is the explicit "Clear value" button.
	if (value) props.bulk.choose(value);
}

// Focus: the first control on opening (the heading when there is none), back to the menu button on closing.
watch(
	() => !!state.value,
	async (open, was) => {
		if (open) {
			await nextTick();
			(dialog.value?.querySelector<HTMLElement>('select:not([disabled]), input:not([disabled])') ?? heading.value)?.focus();
		} else if (was) {
			await nextTick();
			props.restoreFocus();
		}
	},
	{ immediate: true, flush: 'post' },
);

function onKeydown(e: KeyboardEvent): void {
	if (e.key === 'Escape') {
		e.preventDefault();
		e.stopPropagation();
		props.bulk.close();
	} else if (e.key === 'Tab') {
		const stops = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), summary') ?? []);
		if (!stops.length) return;
		const first = stops[0];
		const last = stops[stops.length - 1];
		const at = document.activeElement as HTMLElement | null;
		if (e.shiftKey && (at === first || !dialog.value?.contains(at))) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (at === last || !dialog.value?.contains(at))) {
			e.preventDefault();
			first.focus();
		}
	}
}
</script>

<template>
	<Teleport to="body">
		<div v-if="state" class="d1-kit bulk-backdrop" @mousedown.self="bulk.close()">
			<div ref="dialog" class="bulk" role="dialog" aria-modal="true" :aria-labelledby="`${uid}-title`" @keydown="onKeydown">
				<header class="top">
					<h2 :id="`${uid}-title`" ref="heading" tabindex="-1">{{ title }}</h2>
					<button type="button" class="x" aria-label="Close" @click="bulk.close()">&times;</button>
				</header>

				<div class="body">
					<p v-if="state.entry.kind === 'restrict'" class="hint">A restricted record is seen only by the people listed in its Who has access dialog.</p>

					<template v-if="field">
						<label class="fld">
							<span>New {{ fieldName }}</span>
							<input v-if="field.kind === 'date'" type="date" :value="selected" @change="onDate" />
							<select v-else :value="selected" :disabled="field.kind === 'relation' && bulk.optionsState.loading" @change="onSelect">
								<option value="" disabled>{{ field.kind === 'relation' && bulk.optionsState.loading ? 'Loading…' : 'Choose…' }}</option>
								<option v-for="c in choices" :key="c.value" :value="c.value">{{ c.label }}</option>
							</select>
						</label>
						<p v-if="bulk.optionsState.error" class="err" role="alert">The list could not be loaded: {{ bulk.optionsState.error }} Close this and try again.</p>
						<p v-if="canClear(field)" class="clear">
							<button type="button" class="link" :aria-pressed="cleared" @click="bulk.choose(null)">Clear {{ fieldName }} instead</button>
							<span v-if="cleared" class="hint">The {{ fieldName }} will be emptied on every record that can change.</span>
						</p>
					</template>

					<div class="preview" role="status" aria-live="polite" :aria-busy="bulk.preview.loading">
						<p v-if="bulk.preview.loading" class="hint">Checking what can be changed…</p>
						<template v-else-if="rows">
							<p class="sum">{{ bulk.summary }}</p>
							<p v-for="w in bulk.warnings" :key="w" class="warn">{{ w }}</p>
						</template>
						<p v-else-if="field && !bulk.preview.error" class="hint">Choose a value to see what would change.</p>
					</div>
					<BulkSkips :summary="`Why are ${skips.length} skipped?`" :rows="skips" />
					<p v-if="bulk.preview.error" class="err" role="alert">The check failed: {{ bulk.preview.error }} Nothing has been changed. Close this and try again.</p>
					<p v-if="bulk.applyError" class="err" role="alert">The change failed: {{ bulk.applyError }} Check the list before you try again.</p>
				</div>

				<footer class="foot">
					<span class="grow" />
					<button type="button" class="btn" @click="bulk.close()">Cancel</button>
					<button type="button" class="btn primary" :disabled="!bulk.ready" @click="bulk.apply()">{{ applyText }}</button>
				</footer>
			</div>
		</div>
	</Teleport>
</template>

<style scoped>
/* The dialogs and drawers band of DESIGN.md (100); toasts sit above at 1000. */
.bulk-backdrop {
	position: fixed; inset: 0; z-index: 100; display: flex; align-items: flex-start; justify-content: center; padding: 8vh 16px 16px;
	background: rgba(0, 0, 0, 0.4); font-family: var(--theme--fonts--sans--font-family, inherit); color: var(--theme--foreground);
}
.bulk {
	width: min(520px, 100%); max-height: 84vh; display: flex; flex-direction: column;
	border: 1px solid var(--d1-line); border-radius: var(--d1-radius); background: var(--d1-surface); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3); overflow: hidden;
}
.top { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px 10px; border-bottom: 1px solid var(--d1-line); }
.top h2 { flex: 1; min-width: 0; margin: 0; font-size: var(--fs-lg, 15px); font-weight: 600; overflow-wrap: anywhere; }
.top h2:focus { outline: none; }
.x { border: 0; background: transparent; color: inherit; font-size: 22px; line-height: 1; padding: 0 4px; cursor: pointer; border-radius: 6px; }
.x:hover { background: var(--d1-tile); }
.body { overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
.fld { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-dim); }
.fld select, .fld input {
	height: 34px; padding: 0 10px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface); color: var(--theme--foreground);
	font: inherit; font-size: var(--fs-md, 13px); font-weight: 400;
}
.clear { margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.link {
	border: 0; background: none; padding: 0; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600;
	color: var(--d1-accent, var(--theme--primary)); cursor: pointer; text-decoration: underline;
}
.preview { display: flex; flex-direction: column; gap: 6px; min-height: 20px; }
.sum { margin: 0; font-size: var(--fs-md, 13px); font-weight: 600; }
.hint { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.warn { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-warn); }
.err { margin: 0; font-size: var(--fs-md, 13px); color: var(--d1-bad); }
.foot { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--d1-line); }
.grow { flex: 1; }
.btn {
	height: 32px; padding: 0 12px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-tile); color: inherit;
	font: inherit; font-size: var(--fs-md, 13px); font-weight: 600; cursor: pointer;
}
.btn:hover:not(:disabled) { border-color: var(--d1-accent, var(--theme--primary)); }
.btn.primary { background: var(--d1-accent, var(--theme--primary)); border-color: var(--d1-accent, var(--theme--primary)); color: var(--d1-on-accent); }
.btn:disabled { opacity: 0.55; cursor: default; }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
</style>
