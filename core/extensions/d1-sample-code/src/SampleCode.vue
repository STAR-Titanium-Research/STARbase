<template>
	<div class="d1-sample-code">
		<v-input
			:model-value="shownValue"
			placeholder="Auto-built from alloy, method & date…"
			@update:model-value="onType"
		>
			<template #append>
				<v-icon
					name="autorenew"
					clickable
					v-tooltip="'Assign the next available number (renumber)'"
					@click="rebuild(true)"
				/>
			</template>
		</v-input>
		<div class="hint">
			<span v-if="parts">{{ parts }}</span>
			<span v-else class="muted">Pick alloy + method to auto-build the code.</span>
		</div>
		<div v-if="previewError" class="hint error">{{ previewError }}</div>
		<div v-else-if="hasPlaceholder" class="hint"><span class="muted">The number is a preview; the database assigns the final one on save.</span></div>
	</div>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch, type Ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';

const props = defineProps<{ value: string | null; primaryKey?: string | number | null }>();
const emit = defineEmits<{ (e: 'input', value: string | null): void }>();

const values = inject<Ref<Record<string, any>>>('values', ref({}));
const api = useApi();

const parts = ref<string>('');

// The sample number is assigned by the database when the record is saved (a trigger on
// physical_samples replaces a leading {seq}- with the next free number, under a lock). The
// interface only composes the rest of the code and shows a PREVIEW of the number. A failed read is
// reported -- it never falls back to "1".
const SEQ = '{seq}';
const seqEstimate = ref<number | null>(null);
const previewError = ref<string>('');
const hasPlaceholder = computed(() => (props.value ?? '').startsWith(`${SEQ}-`));
const shownValue = computed(() => {
	const v = props.value ?? '';
	if (!v.startsWith(`${SEQ}-`)) return props.value;
	return `${seqEstimate.value != null ? seqEstimate.value : '?'}${v.slice(SEQ.length)}`;
});

// Was this component opened on an already-saved item that had a code? Captured
// once at setup so an async value load can't flip it later.
const openedWithCode = /^\d+-/.test(props.value ?? '');

// An EXISTING item: it has a real primary key ('+' / null means a new, unsaved
// item). We pause all auto-generation for existing items so merely opening or
// editing one can never recalculate/renumber its code — only the autorenew
// button (force) may. New items still auto-build as you fill alloy/method/date.
function isExistingItem(): boolean {
	const pk = props.primaryKey;
	return (pk !== undefined && pk !== null && pk !== '+') || openedWithCode;
}

function onType(v: string | null) {
	if (v === shownValue.value) return; // the preview echoed back: keep the placeholder
	emit('input', v);
}

async function lookup(collection: string, id: string, field: string): Promise<string | null> {
	try {
		const res = await api.get(`/items/${collection}/${id}`, { params: { fields: [field] } });
		return res?.data?.data?.[field] ?? null;
	} catch {
		return null;
	}
}

// PREVIEW of the next free sequence number, asked of the database: /d1-next-number/sample runs the
// same rule as the trigger that assigns it on save, over every sample whatever this user can read.
// Excludes this sample's own row when renumbering. Returns null and sets previewError on failure.
async function nextSequence(): Promise<number | null> {
	try {
		const pk = props.primaryKey;
		const exclude = pk != null && pk !== '+' ? String(pk) : undefined;
		const res = await api.get('/d1-next-number/sample', { params: exclude ? { exclude } : {} });
		const n = Number(res?.data?.next);
		if (!Number.isFinite(n)) throw new Error('no number returned');
		previewError.value = '';
		return n;
	} catch {
		previewError.value = 'Could not read the next sample number, so no preview is available. The database still assigns the number when you save.';
		return null;
	}
}

// `force` = deliberately assign a fresh next number (the autorenew button).
// Otherwise the sequence number is PRESERVED from the current code — only the
// alloy/method/date parts regenerate — so editing a sample never renumbers it.
async function rebuild(force = false) {
	// Pause auto-generation for existing items (only the renumber button forces it).
	if (!force && isExistingItem()) return;
	const v = values.value ?? {};
	const alloy = v.material_id ? await lookup('materials', v.material_id, 'alloy_code') : null;
	const method = v.primary_method_id ? await lookup('manufacturing_methods', v.primary_method_id, 'method_code') : null;
	if (!alloy || !method) {
		parts.value = '';
		return;
	}
	const d = v.manufactured_date ? new Date(v.manufactured_date) : new Date();

	const existing = /^(\d+)-/.exec(props.value ?? '');
	// A hand-typed code with no leading number is left untouched (unless forced).
	if (props.value && !existing && !force) return;
	const keep = existing && !force ? parseInt(existing[1], 10) : null;
	if (keep == null) seqEstimate.value = await nextSequence();
	// A kept number is concrete; a new or renumbered one is left to the database.
	const seq = keep ?? SEQ;
	const shownSeq = keep ?? (seqEstimate.value != null ? seqEstimate.value : '?');

	const code = `${seq}-${alloy}-${method}-${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
	parts.value = `${shownSeq} · ${alloy} · ${method} · ${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
	if (code !== props.value) emit('input', code); // avoid marking the form dirty on open
}

// Regenerate only on a genuine user change to the inputs — NOT on open (no
// `immediate`), and never for an existing item (rebuild() pauses on those).
// This double-guards against the code being recalculated when a saved sample
// is merely opened.
watch(
	() => [values.value?.material_id, values.value?.primary_method_id, values.value?.manufactured_date],
	() => rebuild(false),
);
</script>

<style scoped>
.d1-sample-code { width: 100%; }
.hint { margin-top: 4px; font-size: 12px; color: var(--theme--primary, #1565c0); }
.hint.error { color: var(--theme--danger, #c62828); }
.hint .muted { color: var(--theme--foreground-subdued, #999); font-style: italic; }
</style>
