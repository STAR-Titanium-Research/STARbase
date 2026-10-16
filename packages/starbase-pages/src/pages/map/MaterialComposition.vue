<script setup lang="ts">
import { computed } from 'vue';
import { CompositionBar, type ElementRow } from '@d1/ui';

// A material's nominal composition for the hover card and the rail: the stacked wt% bar, whose legend is the
// list (element and wt%, balance last), and nothing at all when no composition is known (not read yet, none
// recorded, or refused): the name above it stands alone. The bar leaves out an element with no weight (its share
// lands in the balance), so a caption under it names those; when none has a weight, the elements are just listed.
const props = defineProps<{ elements?: ElementRow[] | null }>();

const rows = computed(() => (props.elements ?? []).filter((r) => r.symbol));
const weighed = computed(() => rows.value.some((r) => Number(r.weight_percent) > 0));
/** Elements recorded without a weight: not in the bar. */
const unweighed = computed(() => rows.value.filter((r) => r.weight_percent == null || Number.isNaN(Number(r.weight_percent))).map((r) => r.symbol));
</script>

<template>
	<div v-if="rows.length" class="pm-comp">
		<div class="head">Nominal composition</div>
		<template v-if="weighed">
			<CompositionBar :elements="rows" />
			<div v-if="unweighed.length" class="also">Also: {{ unweighed.join(', ') }} (no wt%)</div>
		</template>
		<div v-else class="bare">{{ rows.map((r) => r.symbol).join(', ') }}</div>
	</div>
</template>

<style scoped>
.pm-comp { display: flex; flex-direction: column; gap: 2px; }
.head { font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-dim); }
.also { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.bare { font-size: var(--fs-md, 13px); }
/* The bar is the plot; the kit's own padding would only widen the card. */
.pm-comp :deep(.d1-composition) { gap: 6px; padding: 2px 0; }
.pm-comp :deep(.bar) { height: 20px; }
</style>
