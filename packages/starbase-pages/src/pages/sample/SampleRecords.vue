<script setup lang="ts">
import { computed } from 'vue';
import {
	DataTable, LIST_CAP, LoadState, RecordLink, Section, StatusBadge, analysisLink, formatDate, indexRoute, hasPassCode, operationLabel, processLabel, type SectionState,
} from '@d1/ui';

// The sample's operations and tests as tables: each row links to its page, tests carry their
// status, and machining / FAST operations offer the matching analysis dashboard.
// `sampleCode` scopes the "see all" links: the list pages search sample codes, so the full list
// opens already narrowed to this sample (without a code it opens plain).
const props = defineProps<{ operations: SectionState<any[]>; tests: SectionState<any[]>; sampleCode?: string | null }>();

const ops = computed(() => props.operations.data.slice(0, LIST_CAP));
const testRows = computed(() => props.tests.data.slice(0, LIST_CAP));
const opsCapped = computed(() => props.operations.data.length > LIST_CAP);
const testsCapped = computed(() => props.tests.data.length > LIST_CAP);
const forThisSample = (collection: string) => indexRoute(collection, props.sampleCode ? { query: { q: props.sampleCode } } : {});
</script>

<template>
	<Section id="operations" title="Operations" :count="operations.loading ? null : ops.length" :empty="!operations.loading && !operations.error && !ops.length" empty-text="No operations recorded for this sample.">
		<LoadState :loading="operations.loading" :error="operations.error">
			<DataTable>
				<thead>
					<tr><th class="fit">#</th><th>Pass</th><th>Process</th><th>Method</th><th>Date</th><th>Machine</th><th /></tr>
				</thead>
				<tbody>
					<tr v-for="o in ops" :key="o.operation_id">
						<td class="fit dim num">{{ o.operation_sequence ?? '' }}</td>
						<td><RecordLink collection="manufacturing_operations" :id="o.operation_id" :class="{ mono: hasPassCode(o) }">{{ operationLabel(o) }}</RecordLink></td>
						<td>{{ processLabel(o.process_category) }}</td>
						<td>{{ o.method_id?.method_name ?? '' }}</td>
						<td :class="{ dim: !o.operation_date }">{{ formatDate(o.operation_date, 'undated') }}</td>
						<td>{{ o.equipment_id?.equipment_name ?? '' }}</td>
						<td class="actions">
							<router-link v-if="analysisLink(o.operation_id, o.process_category)" :to="analysisLink(o.operation_id, o.process_category)!.to" class="action">
								{{ analysisLink(o.operation_id, o.process_category)!.label }}
							</router-link>
						</td>
					</tr>
				</tbody>
			</DataTable>
			<p v-if="opsCapped" class="d1-note cap">
				Showing the first {{ LIST_CAP }} operations.
				<router-link :to="forThisSample('manufacturing_operations')">{{ sampleCode ? "See all of this sample's operations" : 'See the full list' }}</router-link>.
			</p>
		</LoadState>
	</Section>

	<Section id="tests" title="Tests" :count="tests.loading ? null : testRows.length" :empty="!tests.loading && !tests.error && !testRows.length" empty-text="No tests recorded for this sample.">
		<LoadState :loading="tests.loading" :error="tests.error">
			<DataTable>
				<thead>
					<tr><th>Test</th><th>Category</th><th>Date</th><th>Status</th><th>Equipment</th></tr>
				</thead>
				<tbody>
					<tr v-for="t in testRows" :key="t.session_id">
						<td><RecordLink collection="test_sessions" :id="t.session_id">{{ t.test_type || 'Test' }}</RecordLink></td>
						<td>{{ t.test_category ?? '' }}</td>
						<td :class="{ dim: !t.session_date }">{{ formatDate(t.session_date, 'undated') }}</td>
						<td><StatusBadge kind="test" :value="t.status" /></td>
						<td>{{ t.equipment_id?.equipment_name ?? '' }}</td>
					</tr>
				</tbody>
			</DataTable>
			<p v-if="testsCapped" class="d1-note cap">
				Showing the first {{ LIST_CAP }} tests.
				<router-link :to="forThisSample('test_sessions')">{{ sampleCode ? "See all of this sample's tests" : 'See the full list' }}</router-link>.
			</p>
		</LoadState>
	</Section>
</template>

<style scoped>
.action { font-size: var(--fs-sm); font-weight: 600; text-decoration: none; color: var(--d1-accent, var(--theme--primary)); }
.action:hover { text-decoration: underline; }
.cap { margin-top: 10px; }
</style>
