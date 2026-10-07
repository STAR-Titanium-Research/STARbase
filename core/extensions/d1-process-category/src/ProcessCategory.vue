<template>
	<div class="d1-process-category">
		<span v-if="label" class="chip">{{ label }}</span>
		<span v-else class="muted">— set automatically from the Manufacturing Method —</span>
		<small v-if="lookupError" class="err">{{ lookupError }}</small>
		<small v-else-if="unmapped" class="muted">This method has no process category; set the operation's category by hand if it needs one.</small>
	</div>
</template>

<script setup lang="ts">
import { inject, computed, watch, ref, type Ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';

const props = defineProps<{ value: string | null; primaryKey?: string | number | null }>();
const emit = defineEmits<{ (e: 'input', value: string | null): void }>();

// Directus injects the live form values as a Vue Ref.
const values = inject<Ref<Record<string, any>>>('values', ref({}));
const api = useApi();

// The method -> category map lives in Postgres (manufacturing_methods.process_category); a trigger
// on manufacturing_operations applies it on save. This interface only displays it, and sets the
// form value on a NEW record so the typed parameter panels (Directus field conditions on
// process_category) can show before the first save. It never writes null over a stored value.
const CAT_LABEL: Record<string, string> = {
	machining: 'Machining', sintering: 'Sintering (FAST / HIP)',
	heat_treatment: 'Heat Treatment', deformation: 'Deformation', additive: 'Additive',
	sample_prep: 'Sample Preparation',
};

const isExisting = () => props.primaryKey != null && props.primaryKey !== '+';

const current = ref<string | null>(props.value ?? null);
watch(() => props.value, (v) => { if (v) current.value = v; });
const label = computed(() => (current.value ? CAT_LABEL[current.value] ?? current.value : null));
const lookupError = ref('');
const unmapped = ref(false);

const methodId = computed<string | null>(() => values.value?.method_id ?? null);
let openedWithMethod: string | null | undefined; // method the record had when first seen (existing records)
let req = 0;
let derivedHere = false; // this form emitted the current value (so clearing the method may clear it)

watch(
	methodId,
	async (id) => {
		const mine = ++req;
		if (openedWithMethod === undefined) openedWithMethod = id;
		const userChanged = id !== openedWithMethod; // the user picked another method since opening
		lookupError.value = '';
		unmapped.value = false;
		if (!id) {
			// A new record whose method was cleared drops the category this form derived;
			// a saved record's stored category is never cleared by the form.
			if (!isExisting() && derivedHere && current.value !== null) {
				current.value = null;
				derivedHere = false;
				emit('input', null);
			}
			return;
		}
		try {
			const res = await api.get(`/items/manufacturing_methods/${id}`, {
				params: { fields: ['process_category'] },
			});
			if (mine !== req) return; // a newer selection replaced this one
			const cat: string | null = res?.data?.data?.process_category ?? null;
			if (!cat) {
				unmapped.value = true; // method has no category: leave whatever is stored
				return;
			}
			// Never replace a stored category just because the record was opened; replace it
			// only for a new record, a blank one, or after the user changed the method.
			if (cat !== current.value && (!isExisting() || !current.value || userChanged)) {
				current.value = cat;
				derivedHere = true;
				emit('input', cat);
			}
		} catch {
			if (mine !== req) return;
			lookupError.value = 'Could not read the method\'s process category; the stored value is unchanged.';
		}
	},
	{ immediate: true },
);
</script>

<style scoped>
.d1-process-category {
	display: flex;
	align-items: center;
	min-height: var(--theme--form--field--input--height, 60px);
}
.chip {
	background: var(--theme--primary-background, #e3f2fd);
	color: var(--theme--primary, #1565c0);
	font-weight: 600;
	padding: 4px 12px;
	border-radius: 16px;
	font-size: 14px;
}
.err { color: var(--theme--danger, #c62828); margin-left: 8px; font-size: 12px; }
.muted {
	color: var(--theme--foreground-subdued, #999);
	font-style: italic;
	font-size: 13px;
}
</style>
