<template>
	<div class="d1-operation-code">
		<v-input
			:model-value="shownValue"
			placeholder="built by the database on save…"
			@update:model-value="onType"
		>
			<template #append>
				<v-icon
					v-if="showRefresh"
					v-tooltip="'Back to automatic'"
					name="refresh"
					clickable
					@click="regenerate"
				/>
				<v-icon v-else v-tooltip="'Automatic'" name="auto_fix_high" class="active" />
			</template>
		</v-input>
		<small class="hint" :class="{ error: hintIsError }">{{ hint }}</small>
	</div>
</template>

<script setup lang="ts">
// The database builds the operation code (trigger mfg_op_set_code, rule operation_code_for).
// This box only previews that code (POST /d1-next-number/operation-code) and lets the user
// take over by typing. In automatic mode it NEVER emits, so pass_code stays out of the save
// payload and the database builds the code; typing emits, and the refresh icon emits null.
// The mode (Automatic / Typed) of an existing operation comes from the endpoint's `automatic`, which the
// server computes from the SAVED row (the trigger's own test), never from a preview of the form's
// values: those are half-built while the form and other automatic interfaces mount.
import { inject, ref, computed, watch, onMounted, onBeforeUnmount, type Ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { keyState, answerMatches, keyChangeResets, decideMode, onTyped, onRegenerate, shown, hint as hintFor, canRegenerate } from './state.js';

const props = defineProps<{ value: string | null; primaryKey?: string | number | null }>();
const emit = defineEmits<{ (e: 'input', value: string | null): void }>();

const values = inject<Ref<Record<string, any>>>('values', ref({}));
const api = useApi();

const mode = ref<'auto' | 'typed'>('auto');
// true once the first successful answer (or the user typing / pressing the refresh icon) has settled the
// mode; from then on answers only change the displayed preview.
const decided = ref(false);
const preview = ref<string | null>(null);
const previewHidden = ref(false); // 403: the user may not read the operation or sample
const previewFailed = ref(false); // 500 / network / anything else
const frozen = ref(false); // imported from the experiment sheets: the saved code is fixed

// The form sends changed fields only, so pass_code itself must not retrigger previews
// (typing in the box would otherwise cause a request per keystroke).
const watchKey = computed(() => {
	const { pass_code: _ignored, ...rest } = values.value ?? {};
	try {
		return JSON.stringify(rest);
	} catch {
		return String(Math.random());
	}
});

let timer: ReturnType<typeof setTimeout> | null = null;
let requestCounter = 0;

// No wait for the form to hold the record: the mode does not depend on the values, and an answer built
// from a half-loaded form is replaced by the next one (each change of the values previews again).
// But the primary key must be there (keyState 'pending' sends nothing), and an answer counts only for
// the key it was sent with (answerMatches).
async function fetchPreview() {
	const sentKey = props.primaryKey;
	const ks = keyState(sentKey);
	if (ks === 'pending') return;
	const req = ++requestCounter;
	try {
		const res = await api.post('/d1-next-number/operation-code', {
			values: values.value ?? {},
			operation_id: ks === 'new' ? undefined : sentKey,
		});
		if (req !== requestCounter) return; // a newer request is in flight; drop this one
		if (!answerMatches({ sentKey, currentKey: props.primaryKey })) return;
		preview.value = res?.data?.code ?? null;
		frozen.value = res?.data?.frozen === true;
		previewHidden.value = false;
		previewFailed.value = false;
		const m = decideMode({
			isNew: ks === 'new',
			decided: decided.value,
			automatic: res?.data?.automatic,
			current: mode.value,
		});
		if (m !== null) {
			mode.value = m;
			decided.value = true;
		}
	} catch (err: any) {
		if (req !== requestCounter) return;
		if (!answerMatches({ sentKey, currentKey: props.primaryKey })) return;
		preview.value = null;
		// frozen is kept: it comes from the saved row (source_system), which a failed request does not change.
		if (err?.response?.status === 403) {
			previewHidden.value = true;
			previewFailed.value = false;
		} else {
			previewHidden.value = false;
			previewFailed.value = true;
		}
		// Mode stays undecided: a later successful answer decides it.
	}
}

function schedule(delay: number) {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		timer = null;
		void fetchPreview();
	}, delay);
}

onMounted(() => schedule(0)); // next tick, so a late-arriving form state is included
watch(watchKey, () => schedule(300));
// The key can arrive after mount (pending -> ready): preview then. A switch to another ready key starts
// over, so the new item's own answer decides its mode.
watch(
	() => props.primaryKey,
	(newKey, oldKey) => {
		if (keyChangeResets(oldKey, newKey)) {
			requestCounter++; // drop anything in flight for the old key
			decided.value = false;
			mode.value = 'auto';
			preview.value = null;
			frozen.value = false;
			previewHidden.value = false;
			previewFailed.value = false;
		}
		if (keyState(newKey) !== 'pending') schedule(0);
	},
);
onBeforeUnmount(() => {
	if (timer) clearTimeout(timer);
	requestCounter++; // ignore anything still in flight
});

const shownValue = computed(() => {
	// Before the first answer, or when no preview is available, show the saved code rather
	// than an empty box (automatic mode never changes props.value).
	const saved = props.value ?? '';
	if (!decided.value) return saved;
	if (mode.value === 'auto' && preview.value == null && (previewHidden.value || previewFailed.value)) return saved;
	return shown({
		mode: mode.value,
		value: props.value,
		preview: preview.value,
		error: previewFailed.value,
	});
});

const showRefresh = computed(() => canRegenerate({ mode: mode.value, frozen: frozen.value }));
const hintIsError = computed(() => !frozen.value && mode.value === 'auto' && previewFailed.value);
const CONFORM_FORMAT = 'Format DD-MM-YY-CF-run-die dia.';
const hint = computed(() => {
	const conform = values.value?.process_category === 'conform';
	const text = hintFor({
		mode: mode.value,
		frozen: frozen.value,
		hidden: previewHidden.value,
		failed: previewFailed.value,
		noPreview: decided.value && preview.value == null && !previewHidden.value && !previewFailed.value,
		// A Conform run, like a sintering run, has no code until its run number is set.
		sintering: values.value?.process_category === 'sintering' || conform,
	});
	// Say what the automatic code looks like; a typed or imported code needs no format.
	return conform && !frozen.value && mode.value === 'auto' && !previewFailed.value ? `${text} ${CONFORM_FORMAT}` : text;
});

function onType(val: string | null) {
	const r = onTyped(val, preview.value);
	mode.value = r.mode;
	decided.value = true;
	emit('input', r.emit);
}

function regenerate() {
	const r = onRegenerate();
	mode.value = r.mode;
	decided.value = true;
	emit('input', r.emit);
}
</script>

<style scoped>
.d1-operation-code { width: 100%; }
.hint {
	display: block;
	margin-top: 4px;
	font-size: 12px;
	color: var(--theme--foreground-subdued, #999);
	font-style: italic;
}
.hint.error { color: var(--theme--danger, #c62828); font-style: normal; }
.v-icon.active { color: var(--theme--primary, #1565c0); }
</style>
