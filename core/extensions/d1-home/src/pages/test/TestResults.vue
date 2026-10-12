<script setup lang="ts">
import { computed } from 'vue';
import { DataTable, FactList, Section, TEST_DONE_STATUSES, TEST_STATUS_ORDER, summaryCount, summaryGroups } from '@d1/ui';

// `summary_stats` grouped by the top-level key each worker writes under (basic, fft_analysis ...):
// scalars as a key-value grid, lists of records as small tables. See summary.ts in @d1/ui.
const props = defineProps<{ stats: unknown; status?: string | null }>();

const groups = computed(() => summaryGroups(props.stats));
const count = computed(() => summaryCount(groups.value));
// Not finished and not failed: registered, pending_processing, processing and analysing.
const pending = computed(
	() => !!props.status && props.status !== 'failed' && TEST_STATUS_ORDER.includes(props.status) && !TEST_DONE_STATUSES.includes(props.status),
);
</script>

<template>
	<Section
		title="Results"
		:count="count || null"
		:empty="!groups.length"
		:empty-text="pending ? 'The analysis workers have not produced results yet.' : 'No processed results are recorded for this test.'"
	>
		<div v-for="g in groups" :key="g.key" class="group">
			<h3>{{ g.title }}</h3>
			<FactList :facts="g.entries.map((e) => ({ label: e.label, value: e.value, unit: e.unit }))" />
			<div v-for="t in g.tables" :key="t.label">
				<h4>{{ t.label }}</h4>
				<DataTable dense fit-content figures>
					<thead><tr><th v-for="c in t.columns" :key="c">{{ c }}</th></tr></thead>
					<tbody>
						<tr v-for="(row, i) in t.rows" :key="i"><td v-for="(cell, j) in row" :key="j">{{ cell }}</td></tr>
					</tbody>
				</DataTable>
				<p v-if="t.more" class="d1-note more">{{ t.more }} more rows are not shown.</p>
			</div>
		</div>
	</Section>
</template>

<style scoped>
.group + .group { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--d1-line); }
h3 { margin: 0 0 8px; font-size: var(--fs-sm); font-weight: 650; letter-spacing: 0.01em; color: var(--d1-dim); }
h4 { margin: 12px 0 4px; font-size: var(--fs-md); font-weight: 650; }
.more { margin-top: 6px; }
</style>
