<script setup lang="ts">
import { computed } from 'vue';
import { CompositionBar, type ElementRow } from '@d1/ui';

// A material's nominal composition for the hover card and the rail: the stacked wt% bar, whose legend is the
// list (element and wt%, balance last), and nothing at all when no composition is known (not read yet, none
// recorded, or refused): the name above it stands alone. Elements with no weight recorded are only named.
const props = defineProps<{ elements?: ElementRow[] | null }>();

const rows = computed(() => (props.elements ?? []).filter((r) => r.symbol));
const weighed = computed(() => rows.value.some((r) => Number(r.weight_percent) > 0));
</script>

<template>
	<div v-if="rows.length" class="pm-comp">
		<div class="head">Nominal composition</div>
		<CompositionBar v-if="weighed" :elements="rows" />
		<div v-else class="bare">{{ rows.map((r) => r.symbol).join(', ') }}</div>
	</div>
</template>

<style scoped>
.pm-comp { display: flex; flex-direction: column; gap: 2px; }
.head { font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-dim); }
.bare { font-size: var(--fs-md, 13px); }
/* The bar is the plot; the kit's own padding would only widen the card. */
.pm-comp :deep(.d1-composition) { gap: 6px; padding: 2px 0; }
.pm-comp :deep(.bar) { height: 20px; }
</style>
