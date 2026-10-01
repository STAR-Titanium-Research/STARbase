<template>
	<div class="geometry-preview">
		<div v-if="!geoSvg" class="no-data">
			<span class="notice">Select a geometry to see a shape preview</span>
		</div>
		<div v-else class="geo-canvas" v-html="geoSvg"></div>

		<div class="dims">
			<span v-for="d in dimChips" :key="d">{{ d }}</span>
			<span v-if="massLabel" class="mass"><b>m</b> {{ massLabel }}</span>
		</div>
	</div>
</template>

<script setup lang="ts">
import { inject, computed, ref, watch, type Ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { buildGeometry, FORM_FIELDS, isRoundBar, isUprightCylinder } from './geometry';

// Directus 11 injects the live form values as a Vue Ref — read `.value`.
const values = inject<Ref<Record<string, any>>>('values', ref({}));
const v = computed(() => values.value ?? {});
const api = useApi();

const num = (x: any): number | null => {
	const n = typeof x === 'string' ? parseFloat(x) : x;
	return typeof n === 'number' && !Number.isNaN(n) ? n : null;
};

const geoSvg = computed(() => buildGeometry(v.value as any));

// Dimension chips from the fields relevant to the chosen form.
const SHORT: Record<string, string> = { diameter_mm: 'Ø', length_mm: 'L', width_mm: 'W', thickness_mm: 't', gauge_length_mm: 'G', gauge_width_mm: 'Wg' };
const dimChips = computed(() => (FORM_FIELDS[(v.value.form || '').toLowerCase()] || [])
	.filter((k) => num(v.value[k]) != null)
	.map((k) => `${SHORT[k]} ${num(v.value[k])} mm`));

// Material density (g/cm³) → estimated mass, same as before.
const density = ref<number | null>(null);
watch(() => v.value.material_id, async (id) => {
	if (!id) { density.value = null; return; }
	try {
		const res = await api.get(`/items/materials/${id}`, { params: { fields: ['density_g_per_cm3'] } });
		density.value = num(res?.data?.data?.density_g_per_cm3);
	} catch { density.value = null; }
}, { immediate: true });

const volumeMm3 = computed<number | null>(() => {
	const d = num(v.value.diameter_mm), L = num(v.value.length_mm), t = num(v.value.thickness_mm), w = num(v.value.width_mm);
	const g = (v.value.form || '').toLowerCase();
	if (g.includes('disc')) return d && (t ?? L) ? Math.PI * (d / 2) ** 2 * (t ?? L)! : null;
	if (isUprightCylinder(g) || isRoundBar(g)) return d && L ? Math.PI * (d / 2) ** 2 * L : null;
	if (w && L && t) return w * L * t; // box-like
	return null;
});
const enteredMass = computed(() => num(v.value.mass_grams));
const estMass = computed<number | null>(() => (volumeMm3.value == null || density.value == null) ? null : (volumeMm3.value / 1000) * density.value);
const isEstimate = computed(() => enteredMass.value == null && estMass.value != null);
const massValue = computed<number | null>(() => enteredMass.value != null ? enteredMass.value : estMass.value);
const massLabel = computed<string | null>(() => {
	if (massValue.value == null) return null;
	const g = massValue.value >= 100 ? massValue.value.toFixed(0) : massValue.value.toFixed(2);
	return isEstimate.value ? `≈ ${g} g (est.)` : `${g} g`;
});
</script>

<style scoped>
.geometry-preview { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 12px 0; }
.geo-canvas :deep(svg) { width: 240px; max-width: 100%; height: auto; }
.geo-canvas :deep(.gt) { fill: #dbeafe; stroke: #1d4ed8; stroke-width: 1.3; stroke-linejoin: round; }
.geo-canvas :deep(.gl) { fill: #bfdbfe; stroke: #1d4ed8; stroke-width: 1.3; stroke-linejoin: round; }
.geo-canvas :deep(.gr) { fill: #93c5fd; stroke: #1d4ed8; stroke-width: 1.3; stroke-linejoin: round; }
.geo-canvas :deep(.gh) { fill: #fff; stroke: #1d4ed8; stroke-width: 1.2; }
.geo-canvas :deep(.gdim) { stroke: #475569; stroke-width: 0.8; }
.geo-canvas :deep(.gext) { stroke: #94a3b8; stroke-width: 0.5; }
.geo-canvas :deep(.gdimt) { fill: #334155; font-size: 8px; font-weight: 700; text-anchor: middle;
	paint-order: stroke; stroke: #fff; stroke-width: 2.5px; }
.geo-canvas :deep(.gsupport) { fill: #94a3b8; stroke: #475569; stroke-width: 0.6; }
.geo-canvas :deep(.gload) { stroke: #b91c1c; stroke-width: 1.4; }
.no-data .notice { color: var(--foreground-subdued, #999); font-style: italic; font-size: 13px; }
.dims { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--foreground-normal, #333); justify-content: center; }
.dims span { background: var(--background-subdued, #f5f5f5); padding: 2px 8px; border-radius: 4px; }
</style>
