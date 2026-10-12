<script setup lang="ts">
import { computed } from 'vue';
import { CompositionBar, FactList, LoadState, Section, type Fact } from '@d1/ui';

// The "Material and details" panel: the material with its composition bar, the sample's remaining
// facts (what the rail does not show) and the condition notes. The drawing is in the rail
// (SampleGeometry); the status is in the rail too.
const props = defineProps<{
	sample: any;
	facts: Fact[];
	elements: any[];
	elementsLoading: boolean;
	elementsError: string;
}>();

const material = computed(() => props.sample.material_id ?? null);
</script>

<template>
	<Section id="details" title="Material and details">
		<div class="body">
			<div class="material">
				<div class="mat-name">
					<span class="mat-label">Material</span>
					<template v-if="material">
						<strong>{{ material.common_name || material.alloy_code }}</strong>
						<span v-if="material.common_name && material.alloy_code" class="alloy">{{ material.alloy_code }}</span>
					</template>
					<span v-else class="none">Not recorded</span>
				</div>
				<LoadState v-if="material" :loading="elementsLoading" :error="elementsError">
					<CompositionBar :elements="elements" />
				</LoadState>
			</div>

			<FactList :facts="facts" />

			<div v-if="sample.notes" class="condition">
				<span class="mat-label">Condition notes</span>
				<span class="notes">{{ sample.notes }}</span>
			</div>
		</div>
	</Section>
</template>

<style scoped>
.body { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.mat-label { font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.01em; color: var(--d1-dim); }
.mat-name { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
.mat-name strong { font-size: var(--fs-lg); }
.alloy { font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: var(--fs-sm); color: var(--d1-dim); }
.none { color: var(--d1-dim); font-size: var(--fs-md); }
.condition { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 12px; }
.notes { flex: 1 1 320px; font-size: var(--fs-md); line-height: 1.5; color: var(--d1-dim); overflow-wrap: anywhere; }
</style>
