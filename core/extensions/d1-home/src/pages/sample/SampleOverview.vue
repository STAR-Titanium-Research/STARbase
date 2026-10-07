<script setup lang="ts">
import { computed } from 'vue';
import { CompositionBar, KeyValueGrid, LoadState, StatusBadge, estimateMassGrams, formatDate, formatNumber, type KeyValue } from '@d1/ui';
import { buildGeometry, dimsText } from '../../geometry';

// The overview card: the drawing of the sample at its real dimensions, the material with its
// composition bar, and the key facts.
const props = defineProps<{
	sample: any;
	elements: any[];
	elementsLoading: boolean;
	elementsError: string;
}>();

// Directus may send numeric columns as strings; the drawing and the estimate want numbers.
const n = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const dims = computed(() => ({
	form: props.sample.form ?? null,
	diameter_mm: n(props.sample.diameter_mm),
	length_mm: n(props.sample.length_mm),
	width_mm: n(props.sample.width_mm),
	thickness_mm: n(props.sample.thickness_mm),
	gauge_length_mm: n(props.sample.gauge_length_mm),
	gauge_width_mm: n(props.sample.gauge_width_mm),
}));
const svg = computed(() => buildGeometry(dims.value));
const dimensions = computed(() => dimsText(dims.value));

const material = computed(() => props.sample.material_id ?? null);
const mass = computed(() => {
	const measured = n(props.sample.mass_grams);
	if (measured !== null) return formatNumber(measured, 'g');
	const est = estimateMassGrams(dims.value, n(material.value?.density_g_per_cm3));
	return est === null ? '' : `≈ ${formatNumber(est, 'g', est >= 100 ? 0 : 2)} (estimated from dimensions)`;
});

const facts = computed<KeyValue[]>(() => [
	{ label: 'Dimensions', value: dimensions.value },
	{ label: 'Mass', value: mass.value },
	{ label: 'Manufacturing method', value: props.sample.primary_method_id?.method_name },
	{ label: 'Manufacturing route', value: props.sample.manufacturing_route },
	{ label: 'Manufactured', value: formatDate(props.sample.manufactured_date) },
	{ label: 'Surface finish', value: props.sample.surface_finish },
	{ label: 'Location', value: props.sample.location },
	{ label: 'Item type', value: props.sample.item_type },
	{ label: 'Stock category', value: props.sample.stock_category },
	{ label: 'Mounted', value: props.sample.mounted ? (props.sample.mounting_method || 'Yes') : '' },
]);
</script>

<template>
	<div class="overview">
		<div class="drawing">
			<div v-if="svg" class="canvas" v-html="svg"></div>
			<p v-else class="no-drawing">No drawing for this form.</p>
			<span v-if="dimensions" class="caption"><span class="form">{{ sample.form?.replace(/_/g, ' ') }}</span> · {{ dimensions }}</span>
		</div>

		<div class="facts">
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

			<KeyValueGrid :items="facts" />

			<div v-if="sample.current_status || sample.notes" class="condition">
				<span class="mat-label">Condition</span>
				<StatusBadge kind="sample" :value="sample.current_status" />
				<span v-if="sample.notes" class="notes">{{ sample.notes }}</span>
			</div>
		</div>
	</div>
</template>

<style scoped>
.overview {
	display: grid;
	grid-template-columns: minmax(220px, 300px) 1fr;
	gap: 28px;
	padding: 20px 24px;
	border: 1px solid var(--theme--border-color-subdued);
	border-radius: 16px;
	background: var(--theme--background);
}
.drawing {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 8px;
	padding: 14px;
	border-radius: 12px;
	background: var(--theme--background-subdued);
}
.canvas { width: 100%; }
.canvas :deep(svg) { width: 100%; max-width: 280px; height: auto; display: block; margin: 0 auto; }
.no-drawing { margin: 0; font-style: italic; font-size: 13px; color: var(--theme--foreground-subdued); }
.caption { font-size: 11.5px; color: var(--theme--foreground-subdued); text-align: center; }
.form { text-transform: capitalize; }
.facts { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.mat-label {
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	font-weight: 600;
	color: var(--theme--foreground-subdued);
}
.mat-name { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
.mat-name strong { font-size: 17px; }
.alloy { font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: 13px; color: var(--theme--foreground-subdued); }
.none { font-style: italic; color: var(--theme--foreground-subdued); font-size: 13px; }
.condition { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.notes { font-size: 13.5px; color: var(--theme--foreground-subdued); overflow-wrap: anywhere; }

/* The drawing's classes. geometry.ts emits them; scripts/sync_geometry.sh --check requires each
   one to be styled here. */
.canvas :deep(.gt) { fill: #dbeafe; stroke: #1d4ed8; stroke-width: 1.3; stroke-linejoin: round; }
.canvas :deep(.gl) { fill: #bfdbfe; stroke: #1d4ed8; stroke-width: 1.3; stroke-linejoin: round; }
.canvas :deep(.gr) { fill: #93c5fd; stroke: #1d4ed8; stroke-width: 1.3; stroke-linejoin: round; }
.canvas :deep(.gh) { fill: #fff; stroke: #1d4ed8; stroke-width: 1.2; }
.canvas :deep(.gdim) { stroke: #475569; stroke-width: 0.8; }
.canvas :deep(.gext) { stroke: #94a3b8; stroke-width: 0.5; }
.canvas :deep(.gdimt) { fill: #334155; font-size: 8px; font-weight: 700; text-anchor: middle;
	font-family: -apple-system, "Segoe UI", Roboto, sans-serif; paint-order: stroke; stroke: #fff; stroke-width: 2.5px; }
.canvas :deep(.gsupport) { fill: #94a3b8; stroke: #475569; stroke-width: 0.6; }
.canvas :deep(.gload) { stroke: #b91c1c; stroke-width: 1.4; }

@media (max-width: 760px) {
	.overview { grid-template-columns: 1fr; }
}
</style>
