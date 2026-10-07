<script setup lang="ts">
import { computed } from 'vue';
import { buildComposition, compositionAria, toElements, type ElementRow } from '../composition';

// Stacked wt% bar of a material's alloying elements, with a legend. The rows are
// material_alloying_elements ({ symbol, weight_percent }).
const props = withDefaults(
	defineProps<{ elements: ElementRow[]; emptyText?: string; noWeightsText?: string }>(),
	{
		emptyText: 'No alloying elements recorded yet.',
		noWeightsText: 'Add a weight % to each element to see the stacked breakdown.',
	},
);

const parsed = computed(() => toElements(props.elements));
const comp = computed(() => buildComposition(parsed.value));
const aria = computed(() => compositionAria(comp.value.segments));
</script>

<template>
	<div class="d1-composition">
		<p v-if="!parsed.length" class="notice">{{ emptyText }}</p>

		<!-- Elements present but none has a weight % -->
		<div v-else-if="comp.specifiedSum === 0" class="notice">
			<div class="chips"><span v-for="e in parsed" :key="e.symbol" class="chip">{{ e.symbol }}</span></div>
			<span>{{ noWeightsText }}</span>
		</div>

		<template v-else>
			<div class="bar" role="img" :aria-label="aria">
				<div
					v-for="seg in comp.segments"
					:key="seg.key"
					class="seg"
					:style="{ width: seg.widthPct + '%', background: seg.color }"
					:title="seg.label + ' — ' + seg.pctLabel"
				>
					<span v-if="seg.widthPct >= 7" class="seg-label">{{ seg.symbol }}</span>
				</div>
			</div>
			<div class="legend">
				<span v-for="seg in comp.segments" :key="'l-' + seg.key" class="legend-item">
					<span class="swatch" :style="{ background: seg.color }"></span>
					<b>{{ seg.label }}</b>&nbsp;{{ seg.pctLabel }}
				</span>
			</div>
			<div v-if="comp.overspecified" class="warn">
				⚠ Specified elements sum to {{ comp.specifiedSum.toFixed(1) }} wt% (over 100). Bar is shown normalised.
			</div>
		</template>
	</div>
</template>

<style scoped>
.d1-composition { display: flex; flex-direction: column; gap: 10px; padding: 6px 0; }
.bar {
	display: flex;
	width: 100%;
	height: 28px;
	border-radius: 6px;
	overflow: hidden;
	box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
}
.seg { display: flex; align-items: center; justify-content: center; min-width: 2px; transition: width 0.25s ease; }
.seg-label { font-size: 11px; font-weight: 600; color: #fff; text-shadow: 0 1px 1px rgba(0, 0, 0, 0.35); white-space: nowrap; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--theme--foreground); }
.legend-item { display: inline-flex; align-items: center; gap: 5px; }
.swatch { width: 11px; height: 11px; border-radius: 3px; display: inline-block; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.15); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.chip { background: var(--theme--background-normal); border-radius: 4px; padding: 2px 8px; font-size: 12px; font-weight: 600; }
.notice { margin: 0; color: var(--theme--foreground-subdued); font-style: italic; font-size: 13px; }
.warn { color: var(--theme--warning); font-size: 12px; }
</style>
