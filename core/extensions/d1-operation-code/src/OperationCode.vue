<template>
	<div class="d1-operation-code">
		<v-input
			:model-value="shownValue"
			placeholder="built by the database on save…"
			@update:model-value="onType"
		>
			<template #append>
				<v-icon
					v-if="mode === 'typed'"
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
import { inject, ref, computed, watch, onMounted, onBeforeUnmount, type Ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { initialMode, onTyped, onRegenerate, shown } from './state.js';

const props = defineProps<{ value: string | null; primaryKey?: string | number | null }>();
const emit = defineEmits<{ (e: 'input', value: string | null): void }>();

const values = inject<Ref<Record<string, any>>>('values', ref({}));
const api = useApi();

const isNew = () => props.primaryKey == null || props.primaryKey === '+';

const mode = ref<'auto' | 'typed'>('auto');
const decided = ref(false); // true once the first preview (or the user) has settled the mode
const preview = ref<string | null>(null);
const previewHidden = ref(false); // 403: the user may not read the operation or sample
const previewFailed = ref(false); // 500 / network / anything else

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

async function fetchPreview() {
	const req = ++requestCounter;
	try {
		const res = await api.post('/d1-next-number/operation-code', {
			values: values.value ?? {},
			operation_id: isNew() ? undefined : props.primaryKey,
		});
		if (req !== requestCounter) return; // a newer request is in flight; drop this one
		preview.value = res?.data?.code ?? null;
		previewHidden.value = false;
		previewFailed.value = false;
		if (!decided.value) {
			mode.value = initialMode({ isNew: isNew(), value: props.value, preview: preview.value });
			decided.value = true;
		}
	} catch (err: any) {
		if (req !== requestCounter) return;
		preview.value = null;
		if (err?.response?.status === 403) {
			previewHidden.value = true;
			previewFailed.value = false;
		} else {
			previewHidden.value = false;
			previewFailed.value = true;
		}
		// Mode stays undecided: a later successful preview decides it.
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

const hintIsError = computed(() => mode.value === 'auto' && previewFailed.value);
const hint = computed(() => {
	if (mode.value === 'typed') return 'Typed: kept as you wrote it — ↻ to go back to automatic.';
	if (previewHidden.value) return 'Automatic: the database builds the code on save.';
	if (previewFailed.value) return 'Preview unavailable — the database still builds the code on save.';
	if (decided.value && preview.value == null && values.value?.process_category === 'sintering') {
		return 'Set the run number to get a code.';
	}
	return 'Automatic: follows the fields below.';
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
