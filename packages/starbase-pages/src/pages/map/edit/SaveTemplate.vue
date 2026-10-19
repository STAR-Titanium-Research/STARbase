<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { enterConfirms } from './dialogKeys';
import { SCOPES, type TemplateScope } from './templates';

// "Save as template" (redesign R7, spec E11): a name and who may use it, for the operation or test selected. The fields it keeps are listed
// (and what it never keeps is said), the notes only when ticked. Enter saves from a field, Esc leaves it; a refusal from the server is said in
// the dialog and the dialog stays, so nothing typed is lost. Presentational: the page saves.
const props = defineProps<{
	/** "operation" or "test", for the title. */
	what: string;
	/** What the name starts as (the method or test type). */
	name: string;
	/** The fields the template keeps, by the labels the form uses. */
	labels: readonly string[];
	/** The card has notes it could keep (unticked by default). */
	hasNotes: boolean;
	/** Why it cannot be saved (no method or test type yet): the dialog says so and Save is off. */
	problem: string | null;
	/** What the server said when the last try failed. */
	error: string;
	busy: boolean;
}>();
const emit = defineEmits<{ save: [v: { name: string; scope: TemplateScope; notes: boolean }]; close: [] }>();

const text = ref(props.name);
const scope = ref<TemplateScope>('private');
const notes = ref(false);
const input = ref<HTMLInputElement | null>(null);
const opener = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
const trimmed = computed(() => text.value.trim());
const nameProblem = computed(() => (trimmed.value ? (trimmed.value.length > 120 ? 'Keep the name to 120 letters.' : '') : 'Give the template a name.'));
const shown = computed(() => (props.labels.length > 8 ? [...props.labels.slice(0, 8), `${props.labels.length - 8} more`] : [...props.labels]));
const can = computed(() => !props.problem && !nameProblem.value && !props.busy);

function ok() {
	if (can.value) emit('save', { name: trimmed.value, scope: scope.value, notes: notes.value });
}
function onKey(e: KeyboardEvent) {
	if (e.key === 'Escape') {
		e.preventDefault();
		e.stopPropagation();
		emit('close');
	} else if (e.key === 'Enter' && enterConfirms(e.target)) {
		e.preventDefault();
		ok();
	}
}
onMounted(async () => {
	await nextTick();
	input.value?.focus();
	input.value?.select();
});
onBeforeUnmount(() => {
	if (opener?.isConnected) opener.focus();
});
</script>

<template>
	<div class="pm-tpl-back" @pointerdown.self="emit('close')">
		<div class="d1-kit d1-process-map pm-tpl" role="dialog" aria-modal="true" :aria-label="`Save this ${what} as a template`" @keydown="onKey">
			<label class="ttl" for="pm-tpl-name">Save this {{ what }} as a template</label>
			<p v-if="problem" class="bad" role="alert">{{ problem }}</p>
			<template v-else>
				<input id="pm-tpl-name" ref="input" v-model="text" type="text" autocomplete="off" spellcheck="false" maxlength="140" placeholder="Template name" :aria-invalid="!!nameProblem" />
				<fieldset class="scope">
					<legend>Who can use it</legend>
					<label v-for="s in SCOPES" :key="s.value" class="opt">
						<input v-model="scope" type="radio" name="pm-tpl-scope" :value="s.value" />
						<span><strong>{{ s.label }}</strong> <span class="hint">{{ s.hint }}</span></span>
					</label>
				</fieldset>
				<p class="keeps" data-keeps>
					<strong>Keeps:</strong> {{ shown.join(', ') || 'nothing yet' }}.
					<span class="hint">Never the sample, the dates or whether it is done.</span>
				</p>
				<label v-if="hasNotes" class="opt notes">
					<input v-model="notes" type="checkbox" />
					<span>Keep the notes too</span>
				</label>
				<p class="bad" role="status" aria-live="polite" aria-atomic="true">{{ nameProblem || error }}</p>
			</template>
			<div class="btns">
				<v-button small secondary @click="emit('close')">Cancel</v-button>
				<v-button small :disabled="!can" @click="ok">{{ busy ? 'Saving…' : 'Save template' }}</v-button>
			</div>
		</div>
	</div>
</template>

<style scoped>
.pm-tpl-back { position: fixed; inset: 0; z-index: 62; display: grid; place-items: center; background: color-mix(in srgb, var(--theme--background) 45%, transparent); }
.pm-tpl {
	display: flex; flex-direction: column; gap: 10px; width: 380px; max-width: calc(100vw - 32px); padding: 14px;
	background: var(--d1-surface, var(--theme--background)); color: var(--theme--foreground);
	border: 1px solid var(--d1-line); border-radius: 12px; box-shadow: var(--d1-shadow-lg, 0 10px 30px rgb(0 0 0 / 0.25));
	font-size: var(--fs-md, 13px);
}
.ttl { font-weight: 700; }
input[type='text'] {
	width: 100%; box-sizing: border-box; padding: 6px 10px; border: 1px solid var(--d1-line); border-radius: 8px;
	background: var(--theme--form--field--input--background, var(--d1-surface)); color: inherit; font: inherit;
}
input[type='text']:focus { outline: none; border-color: var(--d1-accent, var(--theme--primary)); box-shadow: 0 0 0 2px var(--d1-tint); }
input[aria-invalid='true'] { border-color: var(--d1-bad); }
.scope { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; border: 0; }
.scope legend { padding: 0 0 4px; font-size: var(--fs-xs, 11px); font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--d1-dim); }
.opt { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
.opt input { margin-top: 3px; }
.hint { color: var(--d1-dim); font-size: var(--fs-sm, 12px); }
.keeps { margin: 0; line-height: 1.4; }
.bad { margin: 0; min-height: 1.2em; color: var(--d1-bad); font-size: var(--fs-sm, 12px); }
.btns { display: flex; justify-content: flex-end; gap: 6px; }
</style>
