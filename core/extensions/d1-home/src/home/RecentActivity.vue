<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { DataTable, Section, analysisLink, errorText, formatDate, hasPassCode, operationLabel, recordRoute, type AnalysisLink } from '@d1/ui';
import { samplesBookmarkLink, SAMPLES_LIST } from './samplesBookmark';

// Recent activity: samples, operations and tests merged into one feed, each tagged with its kind,
// newest first. Links go through recordRoute; a FAST run opens its Operation page like any other
// operation and keeps a second action to its FAST dashboard (the kit's analysisLink).
type Kind = 'sample' | 'operation' | 'fast' | 'test';
// `plain`: the code is a description (an operation without a pass code), so it is not set in monospace.
interface Activity { kind: Kind; id: string; code: string; meta: string; date: string; to: string; extra?: AnalysisLink | null; plain?: boolean }
const KIND_LABEL: Record<Kind, string> = { sample: 'Sample', operation: 'Operation', fast: 'FAST', test: 'Test' };

const api = useApi();
const recent = ref<Activity[]>([]);
const samplesLink = ref(SAMPLES_LIST);
const error = ref('');

// Each source loads on its own: one the role cannot read leaves the others in the feed, and the
// failure is named instead of showing an empty feed that claims "No activity yet".
const SOURCES: { label: string; read: () => Promise<Activity[]> }[] = [
	{
		label: 'samples',
		read: async () => {
			const res = await api.get('/items/physical_samples', {
				params: { sort: '-created_at', limit: 6, fields: ['sample_id', 'sample_code', 'form', 'created_at', 'material_id.common_name'] },
			});
			return (res.data.data ?? []).map((r: any) => ({
				kind: 'sample' as const, id: r.sample_id, code: r.sample_code,
				meta: r.material_id?.common_name || r.form || '—', date: r.created_at,
				to: recordRoute('physical_samples', r.sample_id),
			}));
		},
	},
	{
		label: 'operations',
		read: async () => {
			const res = await api.get('/items/manufacturing_operations', {
				params: { sort: '-created_at', limit: 8, fields: ['operation_id', 'pass_code', 'operation_sequence', 'created_at', 'process_category', 'sample_id.sample_code'] },
			});
			return (res.data.data ?? []).map((r: any) => {
				const isFast = r.process_category === 'sintering';
				return {
					kind: isFast ? ('fast' as const) : ('operation' as const),
					id: r.operation_id, code: operationLabel(r), plain: !hasPassCode(r),
					// Without a pass code the label already names the sample: do not print it twice.
					meta: hasPassCode(r) ? (r.sample_id?.sample_code || '—') : '', date: r.created_at,
					to: recordRoute('manufacturing_operations', r.operation_id),
					extra: isFast ? analysisLink(r.operation_id, r.process_category) : null,
				};
			});
		},
	},
	{
		label: 'tests',
		read: async () => {
			const res = await api.get('/items/test_sessions', {
				params: { sort: '-created_at', limit: 6, fields: ['session_id', 'test_type', 'created_at', 'sample_id.sample_code'] },
			});
			return (res.data.data ?? []).map((r: any) => ({
				kind: 'test' as const, id: r.session_id, code: r.test_type || 'Test',
				meta: r.sample_id?.sample_code || '—', date: r.created_at,
				to: recordRoute('test_sessions', r.session_id),
			}));
		},
	},
];

onMounted(async () => {
	samplesBookmarkLink(api).then((to) => (samplesLink.value = to));
	const results = await Promise.allSettled(SOURCES.map((s) => s.read()));
	const failed: string[] = [];
	const merged: Activity[] = [];
	results.forEach((r, i) => {
		if (r.status === 'fulfilled') merged.push(...r.value);
		else failed.push(`${SOURCES[i].label} (${errorText(r.reason)})`);
	});
	recent.value = merged
		.filter((a) => a.date)
		.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
		.slice(0, 9);
	error.value = failed.length ? `Could not load recent ${failed.join(', ')}.` : '';
});
</script>

<template>
	<Section title="Recent activity" :count="recent.length || null" :empty="!recent.length && !error" empty-text="No activity yet.">
		<template #actions><router-link :to="samplesLink" class="link">View samples →</router-link></template>
		<p v-if="error" class="d1-note bad error" role="alert">{{ error }}</p>
		<!-- One row per record, newest first: nine cards made the eye zig-zag to read a list. The
		     columns are as wide as their content and the last one takes the rest, so a row reads
		     in one glance instead of across the whole page. -->
		<DataTable v-if="recent.length">
			<thead>
				<tr><th class="fit">Created</th><th class="fit">Type</th><th class="fit">Record</th><th class="fit">Detail</th><th /></tr>
			</thead>
			<tbody>
				<tr v-for="r in recent" :key="`${r.kind}-${r.id}`">
					<td class="fit dim">{{ formatDate(r.date) }}</td>
					<td class="fit"><span class="r-kind" :class="`k-${r.kind}`">{{ KIND_LABEL[r.kind] }}</span></td>
					<td class="fit"><router-link :to="r.to" class="r-code" :class="{ mono: !r.plain }">{{ r.code }}</router-link></td>
					<td class="fit dim">{{ r.meta !== r.code ? r.meta : '' }}</td>
					<td class="actions"><router-link v-if="r.extra" :to="r.extra.to" class="link">{{ r.extra.label }} →</router-link></td>
				</tr>
			</tbody>
		</DataTable>
	</Section>
</template>

<style scoped>
.link { color: var(--d1-accent, var(--theme--primary)); font-weight: 600; font-size: var(--fs-sm); text-decoration: none; white-space: nowrap; }
.link:hover { text-decoration: underline; }
.error { margin-bottom: 8px; }
.r-kind { display: inline-block; font-size: var(--fs-xs); font-weight: 700; padding: 1px 8px; border-radius: 99px; white-space: nowrap; }
.k-sample { color: var(--d1-accent, var(--theme--primary)); background: color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 12%, transparent); }
.k-operation { color: var(--d1-ok); background: color-mix(in srgb, var(--theme--success) 18%, transparent); }
.k-fast { color: var(--d1-warn); background: color-mix(in srgb, var(--theme--warning) 18%, transparent); }
.k-test { color: var(--d1-dim); background: var(--theme--background-normal); }
.r-code { color: var(--d1-accent, var(--theme--primary)); text-decoration: none; overflow-wrap: anywhere; }
.r-code:hover { text-decoration: underline; }
</style>
