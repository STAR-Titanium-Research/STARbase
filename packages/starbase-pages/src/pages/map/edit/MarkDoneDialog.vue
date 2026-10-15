<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { FieldForm, toFormFields, useExplorerHost } from '@d1/ui';
import type { Check, FormValues } from '@d1/ui';
import { answerOf, DATE_FIELD, initialAnswer, leadText, PERSON_FIELD } from './markDone';

// Mark done (spec E6, §6.2): asks the date (default today) and who did it (default the signed-in person, with a people picker),
// for every operation or test of one card at once (`ids`: all rows of a container, or every pass of a stack). It is an action,
// not a draft change: the page sends it to d1-build and, when the server refuses (409 CHECKS: required fields of a done
// record), passes the refusal back as `checks`, shown in place. It works in view mode and on phones too.
//
// Keyboard: Escape cancels, Tab cycles inside the dialog, focus goes to the date on open and back to whatever had it on close.
const props = defineProps<{
	open: boolean;
	collection: 'manufacturing_operations' | 'test_sessions';
	ids: string[];
	/** Heading: what is being marked, e.g. "Mark Machining MF-12 done". */
	title: string;
	/** The server's refusal, listed under the form. */
	checks?: Check[];
	busy?: boolean;
}>();
const emit = defineEmits<{
	confirm: [answer: { date: string; personId: string | null }];
	cancel: [];
}>();

const host = useExplorerHost();
const uid = `d1-markdone-${Math.random().toString(36).slice(2, 8)}`;
const dialog = ref<HTMLElement | null>(null);
const heading = ref<HTMLElement | null>(null);
let opener: HTMLElement | null = null;

// The fields of the little form are made from definitions in the Directus shape, so the date and the people picker are the
// kit's own inputs (the picker searches People through the host's API, as the person's permissions allow).
const fields = toFormFields([
	{ field: DATE_FIELD, type: 'date', schema: { data_type: 'date' }, meta: { interface: 'datetime', required: true, sort: 1, width: 'full', translations: [{ language: 'en-US', translation: 'Date done' }] } },
	{
		field: PERSON_FIELD,
		type: 'uuid',
		schema: { data_type: 'uuid', foreign_key_table: 'people', foreign_key_column: 'person_id' },
		meta: { interface: 'select-dropdown-m2o', special: ['m2o'], sort: 2, width: 'full', translations: [{ language: 'en-US', translation: 'Done by' }] },
	},
]);

const values = ref<FormValues>(initialAnswer(null));
// The People row of this login (as register-sample.vue reads it). null = none, undefined = not known yet; the server then
// takes the caller's own row, so a person without one can still mark done.
const me = ref<string | null | undefined>(undefined);
let meFor: string | undefined;
let touchedPerson = false;

async function lookupMe(): Promise<void> {
	const login = host.user.value?.id;
	if (!login || meFor === login) return;
	meFor = login;
	try {
		const res = await host.api.get('/items/people', { params: { filter: { user_id: { _eq: login } }, fields: ['person_id'], limit: 1 } });
		const id: string | null = res?.data?.data?.[0]?.person_id ?? null;
		if (host.user.value?.id !== login) return;
		me.value = id;
		if (id && !touchedPerson && props.open && !values.value[PERSON_FIELD]) values.value = { ...values.value, [PERSON_FIELD]: id };
	} catch {
		meFor = undefined; // unknown: leave the person empty and let the server decide
	}
}

function onChange(next: FormValues): void {
	if (next[PERSON_FIELD] !== values.value[PERSON_FIELD]) touchedPerson = true;
	values.value = next;
}

const answer = computed(() => answerOf(values.value));
const lead = computed(() => leadText(props.ids.length, props.collection));
const refusals = computed(() => props.checks ?? []);

watch(
	() => props.open,
	async (open) => {
		if (!open || typeof document === 'undefined') return; // (server-side render: nothing to focus or look up)
		opener = document.activeElement as HTMLElement | null;
		touchedPerson = false;
		values.value = initialAnswer(me.value);
		void lookupMe();
		await nextTick();
		const first = dialog.value?.querySelector<HTMLElement>('input');
		(first ?? heading.value)?.focus();
	},
	{ immediate: true },
);
watch(() => host.user.value?.id, () => { if (props.open) void lookupMe(); });
onBeforeUnmount(() => { meFor = undefined; });

function cancel(): void {
	if (props.busy) return;
	emit('cancel');
	if (opener?.isConnected) void nextTick(() => opener?.focus());
}
function confirm(): void {
	if (props.busy || !answer.value) return;
	emit('confirm', answer.value);
}

const STOPS = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function onKeydown(e: KeyboardEvent): void {
	if (e.key === 'Escape') {
		e.preventDefault();
		e.stopPropagation();
		cancel();
	} else if (e.key === 'Tab') {
		const stops = Array.from(dialog.value?.querySelectorAll<HTMLElement>(STOPS) ?? []);
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
		<div v-if="open" class="d1-kit pm-md-backdrop" @mousedown.self="cancel">
			<div ref="dialog" class="pm-md" role="dialog" aria-modal="true" :aria-labelledby="`${uid}-title`" :aria-describedby="`${uid}-lead`" @keydown="onKeydown">
				<header class="top">
					<h2 :id="`${uid}-title`" ref="heading" tabindex="-1">{{ title }}</h2>
					<button type="button" class="x" aria-label="Close" :disabled="busy" @click="cancel">&times;</button>
				</header>
				<div class="body">
					<p :id="`${uid}-lead`" class="lead">{{ lead }}</p>
					<FieldForm :collection="`markdone-${collection}`" :fields="fields" :model-value="values" :readonly="busy" @update:model-value="onChange" />
					<div v-if="refusals.length" class="refused" role="alert">
						<p class="why">Not marked done yet:</p>
						<ul>
							<li v-for="(c, i) in refusals" :key="i" :class="c.level" :data-level="c.level">{{ c.text }}</li>
						</ul>
					</div>
				</div>
				<footer class="foot">
					<span class="grow" />
					<button type="button" class="btn" :disabled="busy" @click="cancel">Cancel</button>
					<button type="button" class="btn primary" :disabled="busy || !answer" :aria-busy="busy ? 'true' : undefined" @click="confirm">
						{{ busy ? 'Marking done…' : 'Mark done' }}
					</button>
				</footer>
			</div>
		</div>
	</Teleport>
</template>

<style scoped>
.pm-md-backdrop {
	position: fixed; inset: 0; z-index: 9999; display: flex; align-items: flex-start; justify-content: center; padding: 8vh 16px 16px;
	background: rgba(0, 0, 0, 0.4); font-family: var(--theme--fonts--sans--font-family, inherit); color: var(--theme--foreground);
}
.pm-md {
	width: min(460px, 100%); max-height: 84vh; display: flex; flex-direction: column;
	border: 1px solid var(--d1-line); border-radius: var(--d1-radius); background: var(--d1-surface); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3); overflow: hidden;
}
.top { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px 10px; border-bottom: 1px solid var(--d1-line); }
.top h2 { flex: 1; min-width: 0; margin: 0; font-size: var(--fs-lg, 15px); font-weight: 600; overflow-wrap: anywhere; }
.top h2:focus { outline: none; }
.x { border: 0; background: transparent; color: inherit; font-size: 22px; line-height: 1; padding: 0 4px; cursor: pointer; border-radius: 6px; }
.x:hover:not(:disabled) { background: var(--d1-tile); }
.body { overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
.lead { margin: 0; font-size: var(--fs-md, 13px); color: var(--d1-dim); }
.refused { padding: 8px 12px; border: 1px solid var(--d1-bad); border-radius: 8px; background: color-mix(in srgb, var(--theme--danger) 10%, var(--d1-surface)); font-size: var(--fs-sm, 12px); }
.why { margin: 0 0 4px; font-weight: 650; color: var(--d1-bad); }
.refused ul { margin: 0; padding-left: 18px; }
.refused li.warn { color: var(--d1-warn); }
.foot { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--d1-line); }
.grow { flex: 1; }
.btn {
	padding: 6px 14px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface); color: inherit; font: inherit; font-size: var(--fs-md, 13px); font-weight: 600; cursor: pointer;
}
.btn:hover:not(:disabled) { border-color: var(--d1-accent, var(--theme--primary)); }
.btn.primary { background: var(--d1-accent, var(--theme--primary)); border-color: var(--d1-accent, var(--theme--primary)); color: var(--d1-on-accent, #fff); }
.btn:focus-visible, .x:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
.btn:disabled, .x:disabled { opacity: 0.55; cursor: default; }
</style>
