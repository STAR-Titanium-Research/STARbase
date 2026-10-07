<template>
	<div class="d1-test-category">
		<span v-if="label" class="chip" :class="current">{{ label }}</span>
		<span v-else class="muted">— set automatically from the Test Type —</span>
	</div>
</template>

<script setup lang="ts">
import { inject, computed, watch, ref, type Ref } from 'vue';

const props = defineProps<{ value: string | null; primaryKey?: string | number | null }>();
const emit = defineEmits<{ (e: 'input', value: string | null): void }>();

// Directus injects the live form values as a Vue Ref. test_type is a scalar on
// the same record, so we read it directly — no API call needed.
const values = inject<Ref<Record<string, any>>>('values', ref({}));

const TYPE_TO_CAT: Record<string, string> = {
	optical_microscopy: 'nde', sem: 'nde', tem: 'nde', xrd: 'nde',
	alicona: 'nde', clemx: 'nde', dct: 'nde', ct_scan: 'nde',
	tensile: 'destructive', hardness: 'destructive', charpy: 'destructive',
	compression: 'destructive', tribology: 'destructive',
	fatigue: 'dynamic', creep: 'dynamic', dma: 'dynamic',
};
const CAT_LABEL: Record<string, string> = {
	nde: 'NDE / Imaging', destructive: 'Destructive', dynamic: 'Dynamic', other: 'Other',
};

const current = ref<string | null>(props.value ?? null);
const label = computed(() => (current.value ? CAT_LABEL[current.value] ?? current.value : null));

const testType = computed<string | null>(() => values.value?.test_type ?? null);

watch(
	testType,
	(t) => {
		const cat = t ? TYPE_TO_CAT[t] ?? 'other' : null;
		// A saved record's category is never cleared just because the form has no test type yet.
		const existing = props.primaryKey != null && props.primaryKey !== '+';
		if (cat === null && existing) return;
		if (cat !== current.value) {
			current.value = cat;
			emit('input', cat);
		}
	},
	{ immediate: true },
);
</script>

<style scoped>
.d1-test-category {
	display: flex;
	align-items: center;
	min-height: var(--theme--form--field--input--height, 60px);
}
.chip {
	font-weight: 600;
	padding: 4px 12px;
	border-radius: 16px;
	font-size: 14px;
	background: var(--theme--primary-background, #e3f2fd);
	color: var(--theme--primary, #1565c0);
}
.chip.destructive { background: #ffebee; color: #b71c1c; }
.chip.dynamic { background: #fff3e0; color: #e65100; }
.chip.nde { background: #e8f5e9; color: #2e7d32; }
.muted {
	color: var(--theme--foreground-subdued, #999);
	font-style: italic;
	font-size: 13px;
}
</style>
