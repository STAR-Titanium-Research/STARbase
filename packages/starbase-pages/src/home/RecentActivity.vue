<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useExplorerHost, AppLink, Section, analysisLink, collectionRoute, errorText, hasPassCode, operationLabel, recordRoute } from '@d1/ui';
import { KIND_ICON, detailLine, mergeActivity, relativeTime, type Activity } from './activity';

// Recent activity: samples, operations and tests merged into one feed, each tagged with its kind,
// newest first, drawn as a compact list for Home's side rail (home.vue). Links go through recordRoute;
// a FAST run opens its Operation page like any other operation and keeps a second action to its FAST
// dashboard (the kit's analysisLink). The merging and the time text are in ./activity.ts.
const api = useExplorerHost().api;
const recent = ref<Activity[]>([]);
const samplesLink = collectionRoute('physical_samples');
const error = ref('');

// Each source loads on its own: one the role cannot read leaves the others in the feed, and the
// failure is named instead of showing an empty feed that claims "No activity yet".
const SOURCES: { label: string; read: () => Promise<Activity[]> }[] = [
	{
		label: 'samples',
		read: async () => {
			const res = await api.get('/items/physical_samples', {
				params: { sort: '-created_at', limit: 10, fields: ['sample_id', 'sample_code', 'form', 'created_at', 'material_id.common_name'] },
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
				params: { sort: '-created_at', limit: 12, fields: ['operation_id', 'pass_code', 'operation_sequence', 'created_at', 'process_category', 'sample_id.sample_code'] },
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
				params: { sort: '-created_at', limit: 10, fields: ['session_id', 'test_type', 'created_at', 'sample_id.sample_code'] },
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
	const results = await Promise.allSettled(SOURCES.map((s) => s.read()));
	const failed: string[] = [];
	const loaded: Activity[][] = [];
	results.forEach((r, i) => {
		if (r.status === 'fulfilled') loaded.push(r.value);
		else failed.push(`${SOURCES[i].label} (${errorText(r.reason)})`);
	});
	recent.value = mergeActivity(loaded);
	error.value = failed.length ? `Could not load recent ${failed.join(', ')}.` : '';
});
</script>

<template>
	<Section title="Recent activity" :count="recent.length || null" :empty="!recent.length && !error" empty-text="No activity yet.">
		<template #actions><AppLink :to="samplesLink" class="link">View samples →</AppLink></template>
		<p v-if="error" class="d1-note bad error" role="alert">{{ error }}</p>
		<!-- A compact list for the side rail: the kind's icon, the record, a one-line detail and when. -->
		<ul v-if="recent.length" class="feed">
			<li v-for="r in recent" :key="`${r.kind}-${r.id}`" class="item">
				<span class="r-icon" :class="`k-${r.kind}`" aria-hidden="true"><v-icon :name="KIND_ICON[r.kind]" small /></span>
				<div class="r-text">
					<AppLink :to="r.to" class="r-code" :class="{ mono: !r.plain }">{{ r.code }}</AppLink>
					<span class="r-detail">{{ detailLine(r) }}<template v-if="r.extra"> · <AppLink :to="r.extra.to" class="link">{{ r.extra.label }} →</AppLink></template></span>
				</div>
				<time class="r-time" :datetime="r.date" :title="r.date">{{ relativeTime(r.date) }}</time>
			</li>
		</ul>
	</Section>
</template>

<style scoped>
.link { color: var(--d1-accent, var(--theme--primary)); font-weight: 600; font-size: var(--fs-sm); text-decoration: none; white-space: nowrap; }
.link:hover { text-decoration: underline; }
.error { margin-bottom: 8px; }
.feed { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.item { display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; border-top: 1px solid var(--d1-line, var(--theme--border-color-subdued)); }
.item:first-child { border-top: 0; padding-top: 0; }
.item:last-child { padding-bottom: 0; }
.r-icon { flex: none; display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 99px; }
.k-sample { color: var(--d1-accent, var(--theme--primary)); background: color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 12%, transparent); }
.k-operation { color: var(--d1-ok); background: color-mix(in srgb, var(--theme--success) 18%, transparent); }
.k-fast { color: var(--d1-warn); background: color-mix(in srgb, var(--theme--warning) 18%, transparent); }
.k-test { color: var(--d1-dim); background: var(--theme--background-normal); }
.r-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.r-code { color: var(--d1-accent, var(--theme--primary)); text-decoration: none; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.r-code:hover { text-decoration: underline; }
.r-detail { font-size: var(--fs-sm); color: var(--d1-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.r-time { flex: none; font-size: var(--fs-xs); color: var(--d1-dim); white-space: nowrap; padding-top: 2px; }
</style>
