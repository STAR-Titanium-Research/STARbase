<template>
	<div class="composition-bar">
		<!-- Unsaved record: no PK to query the junction yet -->
		<div v-if="!materialId" class="notice">Save the material to see its composition breakdown.</div>

		<div v-else-if="loading" class="notice">Loading composition…</div>

		<!-- The stacked wt% bar, or the "no elements" / "no weights" notices: the bar and its maths
		     live in @d1/ui, shared with the Sample page. -->
		<CompositionBar
			v-else
			:elements="elements"
			empty-text="No alloying elements recorded yet. Add elements above to build the breakdown."
			no-weights-text="Add a weight % to each element (then save) to see the stacked breakdown."
		/>
	</div>
</template>

<script setup lang="ts">
import { inject, computed, ref, watch, type Ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { CompositionBar, type ElementRow } from '@d1/ui';

// Directus injects the live form values as a Vue Ref.
const values = inject<Ref<Record<string, any>>>('values', ref({}));
const v = computed(() => values.value ?? {});
const api = useApi();

// materials PK column is `material_id`.
const materialId = computed(() => v.value.material_id ?? null);

const elements = ref<ElementRow[]>([]);
const loading = ref(false);

async function load(id: string | null) {
	if (!id) { elements.value = []; return; }
	loading.value = true;
	try {
		const res = await api.get('/items/material_alloying_elements', {
			params: {
				filter: { material_id: { _eq: id } },
				fields: ['symbol', 'weight_percent'],
				limit: -1,
			},
		});
		elements.value = (res?.data?.data ?? []) as ElementRow[];
	} catch {
		elements.value = [];
	} finally {
		loading.value = false;
	}
}

// Reload on material change and whenever the linked-element set changes
// (add/remove/save of the M2M field re-triggers the fetch).
watch(materialId, (id) => load(id), { immediate: true });
watch(
	() => {
		const a = v.value.alloying_elements;
		return Array.isArray(a) ? a.length : a;
	},
	() => load(materialId.value),
);
</script>

<style scoped>
.composition-bar {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 6px 0;
}

.notice {
	color: var(--theme--foreground-subdued);
	font-style: italic;
	font-size: 13px;
}
</style>
