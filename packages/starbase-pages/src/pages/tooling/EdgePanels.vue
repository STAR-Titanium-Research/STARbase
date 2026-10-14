<script setup lang="ts">
import { computed } from 'vue';
import {
	AppLink, DataTable, LIST_CAP, LoadState, RecordLink, Section, StatusBadge, analysisLink, formatDate, mergeHistory, processLabel, type SectionState,
} from '@d1/ui';

// An edge's history under the stage: the tests and the machining operations run with it, merged and
// newest first, each a link to its page; machining operations add "View forces". The two lists load
// on their own, so one that fails says so without hiding the other.
const props = defineProps<{ tests: SectionState<any[]>; operations: SectionState<any[]> }>();

const entries = computed(() => mergeHistory(props.tests.data, props.operations.data).slice(0, LIST_CAP));
const capped = computed(() => props.tests.data.length > LIST_CAP || props.operations.data.length > LIST_CAP);
const loading = computed(() => props.tests.loading || props.operations.loading);
const error = computed(() => [props.tests.error, props.operations.error].filter(Boolean).join(' '));
const settled = computed(() => !loading.value && !error.value);
const kindLabel = (k: 'test' | 'operation', category: string | null) => (k === 'test' ? 'Test' : processLabel(category));
</script>

<template>
	<Section id="history" title="History" :count="loading ? null : entries.length" :empty="settled && !entries.length" empty-text="No test or operation used this edge.">
		<LoadState v-if="(loading && !entries.length) || error" :loading="loading && !entries.length" :error="error" />
		<DataTable v-if="entries.length">
			<thead>
				<tr><th>Date</th><th>Record</th><th>Kind</th><th>Sample</th><th>Status</th><th /></tr>
			</thead>
			<tbody>
				<tr v-for="e in entries" :key="e.id">
					<td :class="{ dim: !e.date }">{{ formatDate(e.date, 'undated') }}</td>
					<td><RecordLink :collection="e.collection" :id="e.id" :class="{ mono: e.kind === 'operation' }">{{ e.label }}</RecordLink></td>
					<td>{{ kindLabel(e.kind, e.category) }}</td>
					<td :class="{ dim: !e.sampleCode }">{{ e.sampleCode ?? '' }}</td>
					<td><StatusBadge v-if="e.kind === 'test'" kind="test" :value="e.status" /></td>
					<td class="actions">
						<AppLink v-if="e.kind === 'operation' && analysisLink(e.id, e.category)" :to="analysisLink(e.id, e.category)!.to" class="action">
							{{ analysisLink(e.id, e.category)!.label }}
						</AppLink>
					</td>
				</tr>
			</tbody>
		</DataTable>
		<p v-if="capped" class="d1-note cap">Showing the newest {{ LIST_CAP }} records.</p>
	</Section>
</template>

<style scoped>
.action { font-size: var(--fs-sm); font-weight: 600; text-decoration: none; color: var(--d1-accent, var(--theme--primary)); }
.action:hover { text-decoration: underline; }
.cap { margin-top: 10px; }
</style>
