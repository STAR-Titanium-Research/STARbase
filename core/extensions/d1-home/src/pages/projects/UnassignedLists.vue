<script setup lang="ts">
import { computed } from 'vue';
import {
	DataTable, LIST_CAP, LoadState, RecordLink, Section, StatusBadge, formatDate, hasPassCode, indexRoute, operationLabel, processLabel, type SectionState,
} from '@d1/ui';

// "Not in a campaign": records that carry this project but no campaign. Three short lists, each
// loading on its own and capped at LIST_CAP with a pointer to the Data Studio for the rest.
// `projectId` scopes the "see all" links: each list page has a Project filter, so the full list
// opens already narrowed to this project (without it, plain).
const props = defineProps<{ samples: SectionState<any[]>; operations: SectionState<any[]>; tests: SectionState<any[]>; projectId?: string | null }>();
const forThisProject = (collection: string) => indexRoute(collection, props.projectId ? { query: { 'f.project_id': props.projectId } } : {});
const seeAll = (what: string) => (props.projectId ? `See all of this project's ${what}` : 'See the full list');

const cap = <T,>(b: SectionState<T[]>) => b.data.slice(0, LIST_CAP);
const capped = (b: SectionState<any[]>) => b.data.length > LIST_CAP;
const sampleRows = computed(() => cap(props.samples));
const opRows = computed(() => cap(props.operations));
const testRows = computed(() => cap(props.tests));
const isEmpty = (b: SectionState<any[]>) => !b.loading && !b.error && !b.data.length;
</script>

<template>
	<Section id="unassigned-samples" title="Samples not in a campaign" :count="props.samples.loading ? null : sampleRows.length" :empty="isEmpty(props.samples)" empty-text="Every sample of this project that you can see is in a campaign.">
		<LoadState :loading="props.samples.loading" :error="props.samples.error">
			<DataTable>
				<thead><tr><th>Sample</th><th>Form</th><th>Material</th><th>Status</th></tr></thead>
				<tbody>
					<tr v-for="s in sampleRows" :key="s.sample_id">
						<td><RecordLink collection="physical_samples" :id="s.sample_id" class="mono">{{ s.sample_code || 'Sample' }}</RecordLink></td>
						<td>{{ s.form ?? '' }}</td>
						<td>{{ s.material_id?.common_name ?? '' }}</td>
						<td><StatusBadge kind="sample" :value="s.current_status" /></td>
					</tr>
				</tbody>
			</DataTable>
			<p v-if="capped(props.samples)" class="d1-note cap">Showing the first {{ LIST_CAP }}. <router-link :to="forThisProject('physical_samples')">{{ seeAll('samples') }}</router-link>.</p>
		</LoadState>
	</Section>

	<Section id="unassigned-operations" title="Operations not in a campaign" :count="props.operations.loading ? null : opRows.length" :empty="isEmpty(props.operations)" empty-text="Every operation of this project that you can see is in a campaign.">
		<LoadState :loading="props.operations.loading" :error="props.operations.error">
			<DataTable>
				<thead><tr><th>Pass</th><th>Process</th><th>Sample</th><th>Date</th></tr></thead>
				<tbody>
					<tr v-for="o in opRows" :key="o.operation_id">
						<td><RecordLink collection="manufacturing_operations" :id="o.operation_id" :class="{ mono: hasPassCode(o) }">{{ operationLabel(o) }}</RecordLink></td>
						<td>{{ processLabel(o.process_category) }}</td>
						<td>{{ o.sample_id?.sample_code ?? '' }}</td>
						<td :class="{ dim: !o.operation_date }">{{ formatDate(o.operation_date, 'undated') }}</td>
					</tr>
				</tbody>
			</DataTable>
			<p v-if="capped(props.operations)" class="d1-note cap">Showing the newest {{ LIST_CAP }}. <router-link :to="forThisProject('manufacturing_operations')">{{ seeAll('operations') }}</router-link>.</p>
		</LoadState>
	</Section>

	<Section id="unassigned-tests" title="Tests not in a campaign" :count="props.tests.loading ? null : testRows.length" :empty="isEmpty(props.tests)" empty-text="Every test of this project that you can see is in a campaign.">
		<LoadState :loading="props.tests.loading" :error="props.tests.error">
			<DataTable>
				<thead><tr><th>Test</th><th>Sample</th><th>Date</th><th>Status</th></tr></thead>
				<tbody>
					<tr v-for="t in testRows" :key="t.session_id">
						<td><RecordLink collection="test_sessions" :id="t.session_id">{{ t.test_type || 'Test' }}</RecordLink></td>
						<td>{{ t.sample_id?.sample_code ?? '' }}</td>
						<td :class="{ dim: !t.session_date }">{{ formatDate(t.session_date, 'undated') }}</td>
						<td><StatusBadge kind="test" :value="t.status" /></td>
					</tr>
				</tbody>
			</DataTable>
			<p v-if="capped(props.tests)" class="d1-note cap">Showing the newest {{ LIST_CAP }}. <router-link :to="forThisProject('test_sessions')">{{ seeAll('tests') }}</router-link>.</p>
		</LoadState>
	</Section>
</template>

<style scoped>
.cap { margin-top: 8px; }
</style>
