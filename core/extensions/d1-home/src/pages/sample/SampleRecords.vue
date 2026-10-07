<script setup lang="ts">
import { computed } from 'vue';
import {
	LIST_CAP, LoadState, RecordLink, Section, StatusBadge, analysisLink, collectionRoute, formatDate, processLabel, type SectionState,
} from '@d1/ui';

// The sample's operations and tests as tables: each row links to its page, tests carry their
// status, and machining / FAST operations offer the matching analysis dashboard.
const props = defineProps<{ operations: SectionState<any[]>; tests: SectionState<any[]> }>();

const ops = computed(() => props.operations.data.slice(0, LIST_CAP));
const testRows = computed(() => props.tests.data.slice(0, LIST_CAP));
const opsCapped = computed(() => props.operations.data.length > LIST_CAP);
const testsCapped = computed(() => props.tests.data.length > LIST_CAP);
</script>

<template>
	<Section title="Operations" :count="operations.loading ? null : ops.length" :empty="!operations.loading && !operations.error && !ops.length" empty-text="No operations recorded for this sample.">
		<LoadState :loading="operations.loading" :error="operations.error">
			<table class="d1-table">
				<thead>
					<tr><th>#</th><th>Pass</th><th>Process</th><th>Method</th><th>Date</th><th>Machine</th><th /></tr>
				</thead>
				<tbody>
					<tr v-for="o in ops" :key="o.operation_id">
						<td class="num">{{ o.operation_sequence ?? '' }}</td>
						<td><RecordLink collection="manufacturing_operations" :id="o.operation_id" class="mono">{{ o.pass_code || 'Operation' }}</RecordLink></td>
						<td>{{ processLabel(o.process_category) }}</td>
						<td>{{ o.method_id?.method_name ?? '' }}</td>
						<td>{{ formatDate(o.operation_date, 'undated') }}</td>
						<td>{{ o.equipment_id?.equipment_name ?? '' }}</td>
						<td class="actions">
							<router-link v-if="analysisLink(o.operation_id, o.process_category)" :to="analysisLink(o.operation_id, o.process_category)!.to" class="action">
								{{ analysisLink(o.operation_id, o.process_category)!.label }}
							</router-link>
						</td>
					</tr>
				</tbody>
			</table>
			<p v-if="opsCapped" class="cap">
				Showing the first {{ LIST_CAP }} operations.
				<router-link :to="collectionRoute('manufacturing_operations')">Open the collection in the Data Studio (unfiltered)</router-link> for the rest.
			</p>
		</LoadState>
	</Section>

	<Section title="Tests" :count="tests.loading ? null : testRows.length" :empty="!tests.loading && !tests.error && !testRows.length" empty-text="No tests recorded for this sample.">
		<LoadState :loading="tests.loading" :error="tests.error">
			<table class="d1-table">
				<thead>
					<tr><th>Test</th><th>Category</th><th>Date</th><th>Status</th><th>Equipment</th></tr>
				</thead>
				<tbody>
					<tr v-for="t in testRows" :key="t.session_id">
						<td><RecordLink collection="test_sessions" :id="t.session_id">{{ t.test_type || 'Test' }}</RecordLink></td>
						<td>{{ t.test_category ?? '' }}</td>
						<td>{{ formatDate(t.session_date, 'undated') }}</td>
						<td><StatusBadge kind="test" :value="t.status" /></td>
						<td>{{ t.equipment_id?.equipment_name ?? '' }}</td>
					</tr>
				</tbody>
			</table>
			<p v-if="testsCapped" class="cap">
				Showing the first {{ LIST_CAP }} tests.
				<router-link :to="collectionRoute('test_sessions')">Open the collection in the Data Studio (unfiltered)</router-link> for the rest.
			</p>
		</LoadState>
	</Section>
</template>

<style scoped>
.d1-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.d1-table th {
	text-align: left;
	padding: 6px 12px 6px 0;
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	font-weight: 600;
	color: var(--theme--foreground-subdued);
	border-bottom: 1px solid var(--theme--border-color);
}
.d1-table td { padding: 8px 12px 8px 0; border-bottom: 1px solid var(--theme--border-color-subdued); vertical-align: middle; }
.d1-table tbody tr:hover { background: var(--theme--background-subdued); }
.num { color: var(--theme--foreground-subdued); width: 32px; }
.mono { font-family: var(--theme--fonts--monospace--font-family, monospace); }
.actions { text-align: right; white-space: nowrap; }
.action {
	display: inline-block;
	padding: 2px 10px;
	border-radius: 99px;
	font-size: 12px;
	font-weight: 600;
	text-decoration: none;
	color: var(--theme--primary);
	background: var(--theme--primary-background);
}
.action:hover { text-decoration: underline; }
.cap { margin: 10px 0 0; font-size: 12.5px; color: var(--theme--foreground-subdued); }
.cap a { color: var(--theme--primary); }
</style>
