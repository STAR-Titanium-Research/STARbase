<script setup lang="ts">
import { computed } from 'vue';
import { KeyValueGrid, Section, TEST_DONE_STATUSES, TEST_STATUS_ORDER, summaryCount, summaryGroups } from '@d1/ui';

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
			<KeyValueGrid :items="g.entries.map((e) => ({ label: e.label, value: e.value, unit: e.unit }))" />
			<div v-for="t in g.tables" :key="t.label" class="table-wrap">
				<h4>{{ t.label }}</h4>
				<table class="d1-table">
					<thead><tr><th v-for="c in t.columns" :key="c">{{ c }}</th></tr></thead>
					<tbody>
						<tr v-for="(row, i) in t.rows" :key="i"><td v-for="(cell, j) in row" :key="j" class="num">{{ cell }}</td></tr>
					</tbody>
				</table>
				<p v-if="t.more" class="more">{{ t.more }} more rows are not shown.</p>
			</div>
		</div>
	</Section>
</template>

<style scoped>
.group + .group { margin-top: 22px; }
h3 {
	margin: 0 0 10px;
	font-size: 12px;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	color: var(--theme--foreground-subdued);
}
h4 { margin: 14px 0 6px; font-size: 13px; font-weight: 650; }
.table-wrap { overflow-x: auto; }
.d1-table { border-collapse: collapse; font-size: 13px; min-width: 320px; }
.d1-table th {
	text-align: right;
	padding: 5px 16px 5px 0;
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	font-weight: 600;
	color: var(--theme--foreground-subdued);
	border-bottom: 1px solid var(--theme--border-color);
	white-space: nowrap;
}
.d1-table th:first-child, .d1-table td:first-child { text-align: left; }
.d1-table td { padding: 5px 16px 5px 0; border-bottom: 1px solid var(--theme--border-color-subdued); }
.num { font-variant-numeric: tabular-nums; text-align: right; }
.more { margin: 6px 0 0; font-size: 12px; color: var(--theme--foreground-subdued); }
</style>
