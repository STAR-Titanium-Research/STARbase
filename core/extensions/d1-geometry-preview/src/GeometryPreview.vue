<template>
	<div class="geometry-preview">
		<div v-if="presetItems.length" class="standard">
			<span class="standard-label">Standard</span>
			<v-select
				class="standard-select"
				:items="presetItems"
				:model-value="currentPreset"
				:disabled="disabled"
				placeholder="Custom (choose a standard…)"
				@update:model-value="applyPreset"
			/>
		</div>
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
import { buildGeometry, FORM_FIELDS, isRoundBar, isUprightCylinder, matchingPreset, presetDims, presetLabel, presetsFor } from './geometry';

defineProps<{ disabled?: boolean }>();
// The Directus form listens for this on every interface (v-form: onSetFieldValue -> setValue(field, value)),
// so the picker can fill the sibling dimension fields. Declared here or the event never leaves the component.
const emit = defineEmits<{ (e: 'setFieldValue', payload: { field: string; value: unknown }): void }>();

// Directus 11 injects the live form values as a Vue Ref — read `.value`.
const values = inject<Ref<Record<string, any>>>('values', ref({}));
const v = computed(() => values.value ?? {});
const api = useApi();

const num = (x: any): number | null => {
	const n = typeof x === 'string' ? parseFloat(x) : x;
	return typeof n === 'number' && !Number.isNaN(n) ? n : null;
};

const geoSvg = computed(() => buildGeometry(v.value as any));

// "Standard" picker: the named standards of the chosen form (tensile coupon, fatigue specimen, bend bar, Charpy specimen). It shows the
// standard the dimensions already equal, else nothing selected ("Custom"). Picking one fills the
// dimensions it fixes; thickness is never touched, and every field stays editable.
const presetItems = computed(() => presetsFor(v.value.form).map((p) => ({ text: presetLabel(p), value: p.id })));
const currentPreset = computed(() => matchingPreset(v.value.form, v.value));
// The form applies setFieldValue against the values it last rendered, so several emits in one tick
// overwrite each other and only one dimension sticks (seen on the preview copy). Emit one field at a
// time and wait until the form's values show it (or 500 ms) before the next.
function landed(field: string, value: unknown): Promise<void> {
	return new Promise((resolve) => {
		let done = false;
		let stop: (() => void) | null = null;
		const finish = () => { if (done) return; done = true; stop?.(); clearTimeout(timer); resolve(); };
		const timer = setTimeout(finish, 500);
		stop = watch(() => values.value?.[field], (x) => { if (x == value) finish(); });
		if (values.value?.[field] == value) finish();
	});
}
async function applyPreset(id: string | null) {
	if (!id) return;
	const dims = presetDims(v.value.form, id);
	if (!dims) return;
	for (const [field, value] of Object.entries(dims)) {
		emit('setFieldValue', { field, value });
		await landed(field, value);
	}
}

// Dimension chips from the fields relevant to the chosen form.
const SHORT: Record<string, string> = { diameter_mm: 'Ø', inner_diameter_mm: 'ID', length_mm: 'L', width_mm: 'W', thickness_mm: 't', gauge_length_mm: 'G', gauge_width_mm: 'Wg' };
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
	if (g === 'ring') { const di = num(v.value.inner_diameter_mm) ?? 0, h = t ?? L; return d && h && di < d ? Math.PI / 4 * (d ** 2 - di ** 2) * h : null; }
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
.standard { display: flex; align-items: center; gap: 10px; align-self: stretch; }
.standard-label { font-size: 12px; font-weight: 600; color: var(--foreground-subdued, #6b7684); white-space: nowrap; }
.standard-select { flex: 1; min-width: 0; }
.no-data .notice { color: var(--foreground-subdued, #999); font-style: italic; font-size: 13px; }
.dims { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--foreground-normal, #333); justify-content: center; }
.dims span { background: var(--background-subdued, #f5f5f5); padding: 2px 8px; border-radius: 4px; }
</style>
