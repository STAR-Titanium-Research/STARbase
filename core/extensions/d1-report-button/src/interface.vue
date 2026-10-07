<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { useRouter } from 'vue-router';

const props = withDefaults(
	defineProps<{
		primaryKey?: string | number | null;
		collection?: string;
		label?: string;
		report?: string;
	}>(),
	{ label: 'Generate PDF', report: 'auto' },
);

const api = useApi();
const router = useRouter();

// New (unsaved) items have primaryKey '+' — nothing to report yet.
const isNew = computed(() => props.primaryKey == null || props.primaryKey === '+');

const reportType = computed(() => {
	if (props.report && props.report !== 'auto') return props.report;
	if (props.collection === 'manufacturing_operations') return 'operation';
	if (props.collection === 'test_sessions') return 'test';
	if (props.collection === 'physical_samples') return 'sample';
	return null; // no report for this collection: show nothing rather than a wrong one
});

const url = computed(() => `/d1-report/${reportType.value}/${props.primaryKey}`);
const canReport = computed(() => !isNew.value && reportType.value !== null);

function open() {
	if (canReport.value) window.open(url.value, '_blank', 'noopener');
}

// Sample forms also get label buttons: one label for this sample, and the picker page
// for printing several (paste codes / tick samples) - Directus has no bulk-action hook
// on the list view, so that is where "print labels for selected" lives.
const isSample = computed(() => props.collection === 'physical_samples' && !isNew.value);
function printLabel() {
	window.open(`/d1-report/label?ids=${encodeURIComponent(String(props.primaryKey))}`, '_blank', 'noopener');
}
function printLabels() {
	window.open('/d1-report/labels', '_blank', 'noopener');
}

// "View Force Analysis" — only offered for a saved machining_operations record
// that already has a processed (status='done') machining_force_analysis row.
const hasForceAnalysis = ref(false);
async function checkForceAnalysis() {
	hasForceAnalysis.value = false;
	if (isNew.value || props.collection !== 'manufacturing_operations') return;
	try {
		const res = await api.get('/items/machining_force_analysis', {
			params: {
				filter: { operation_id: { _eq: props.primaryKey }, status: { _eq: 'done' } },
				limit: 1,
				fields: ['id'],
			},
		});
		hasForceAnalysis.value = (res.data?.data ?? []).length > 0;
	} catch {
		hasForceAnalysis.value = false;
	}
}
// "View FAST Analysis" — for a saved sintering operation with an imported trace.
const hasFastRun = ref(false);
async function checkFastRun() {
	hasFastRun.value = false;
	if (isNew.value || props.collection !== 'manufacturing_operations') return;
	try {
		const res = await api.get('/items/fast_run_data', {
			params: {
				filter: { operation_id: { _eq: props.primaryKey }, status: { _eq: 'done' } },
				limit: 1, fields: ['id'],
			},
		});
		hasFastRun.value = (res.data?.data ?? []).length > 0;
	} catch {
		hasFastRun.value = false;
	}
}

watch(() => [props.collection, props.primaryKey], () => { checkForceAnalysis(); checkFastRun(); }, { immediate: true });

function openForceAnalysis() {
	router.push(`/d1-force-dashboard?operation=${props.primaryKey}`);
}
function openFastAnalysis() {
	router.push(`/d1-fast-dashboard?operation=${props.primaryKey}`);
}
</script>

<template>
	<!-- Only offered once the record exists (nothing to report on a brand-new item). -->
	<div v-if="!isNew" class="d1-report-button">
		<v-button v-if="reportType" @click="open">
			<v-icon name="picture_as_pdf" left />
			{{ label }}
		</v-button>
		<v-button v-if="isSample" secondary @click="printLabel">
			<v-icon name="label" left />
			Print label
		</v-button>
		<v-button v-if="isSample" secondary @click="printLabels">
			<v-icon name="print" left />
			Print several labels
		</v-button>
		<v-button v-if="hasForceAnalysis" secondary @click="openForceAnalysis">
			<v-icon name="insights" left />
			View Force Analysis
		</v-button>
		<v-button v-if="hasFastRun" secondary @click="openFastAnalysis">
			<v-icon name="whatshot" left />
			View FAST Analysis
		</v-button>
	</div>
</template>

<style scoped>
.d1-report-button {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 10px;
	max-width: 100%;
}
.d1-report-button :deep(.v-button) { max-width: 100%; }
.d1-report-button :deep(.v-button .button) { white-space: normal; height: auto; min-height: 44px; padding: 8px 14px; }
.hint {
	color: var(--theme--foreground-subdued, #6c7789);
	font-size: 13px;
	font-style: italic;
}
</style>
