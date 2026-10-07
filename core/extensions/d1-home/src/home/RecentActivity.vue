<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { analysisLink, errorText, formatDate, recordRoute, type AnalysisLink } from '@d1/ui';
import { samplesBookmarkLink, SAMPLES_LIST } from './samplesBookmark';

// Recent activity: samples, operations and tests merged into one feed, each tagged with its kind,
// newest first. Links go through recordRoute; a FAST run opens its Operation page like any other
// operation and keeps a second action to its FAST dashboard (the kit's analysisLink).
type Kind = 'sample' | 'operation' | 'fast' | 'test';
interface Activity { kind: Kind; id: string; code: string; meta: string; date: string; to: string; extra?: AnalysisLink | null }
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
				params: { sort: '-created_at', limit: 8, fields: ['operation_id', 'pass_code', 'created_at', 'process_category', 'sample_id.sample_code'] },
			});
			return (res.data.data ?? []).map((r: any) => {
				const isFast = r.process_category === 'sintering';
				return {
					kind: isFast ? ('fast' as const) : ('operation' as const),
					id: r.operation_id, code: r.pass_code || r.sample_id?.sample_code || '—',
					meta: r.sample_id?.sample_code || '—', date: r.created_at,
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
	<section aria-labelledby="recent-h">
		<div class="section-head">
			<h2 id="recent-h">Recent activity</h2>
			<router-link :to="samplesLink" class="link">View samples →</router-link>
		</div>
		<p v-if="error" class="error" role="alert">{{ error }}</p>
		<div v-if="recent.length" class="recent-grid">
			<div v-for="r in recent" :key="`${r.kind}-${r.id}`" class="rcard">
				<span class="r-top">
					<span class="r-kind" :class="`k-${r.kind}`">{{ KIND_LABEL[r.kind] }}</span>
					<span class="r-date">{{ formatDate(r.date) }}</span>
				</span>
				<router-link :to="r.to" class="r-code">{{ r.code }}</router-link>
				<span class="r-meta">{{ r.meta }}</span>
				<router-link v-if="r.extra" :to="r.extra.to" class="r-extra">{{ r.extra.label }} →</router-link>
			</div>
		</div>
		<p v-else-if="!error" class="empty">No activity yet.</p>
	</section>
</template>

<style scoped>
.section-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 14px; }
.section-head h2 { margin: 0; font-size: 18px; font-weight: 750; }
.link { color: var(--theme--primary); font-weight: 600; font-size: 13px; text-decoration: none; }
.link:hover { text-decoration: underline; }
.recent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
.rcard {
	position: relative; display: flex; flex-direction: column; gap: 6px; padding: 14px 16px; min-width: 0;
	border: 1px solid var(--theme--border-color-subdued); border-radius: 14px;
	background: var(--theme--background); color: var(--theme--foreground);
	transition: border-color 0.14s ease, box-shadow 0.14s ease;
}
.rcard:hover { border-color: var(--theme--primary); box-shadow: 0 10px 22px -16px rgba(15, 23, 42, 0.4); }
.r-top { display: flex; align-items: center; justify-content: space-between; }
.r-kind { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; padding: 2px 8px; border-radius: 99px; }
.k-sample { color: var(--theme--primary); background: var(--theme--primary-background); }
.k-operation { color: var(--theme--success); background: var(--theme--success-background); }
.k-fast { color: var(--theme--warning); background: var(--theme--warning-background); }
.k-test { color: var(--theme--foreground-subdued); background: var(--theme--background-normal); }
.r-code { font-family: var(--theme--fonts--monospace--font-family, monospace); font-weight: 700; font-size: 14px; overflow-wrap: anywhere; color: inherit; text-decoration: none; }
/* The whole card opens the record: the code link stretches over it, the extra action sits above. */
.r-code::after { content: ''; position: absolute; inset: 0; border-radius: 14px; }
.r-extra { position: relative; z-index: 1; align-self: flex-start; font-size: 12px; font-weight: 600; color: var(--theme--primary); text-decoration: none; }
.r-extra:hover { text-decoration: underline; }
.r-meta { font-size: 12.5px; color: var(--theme--foreground-subdued); }
.r-date { font-size: 11px; color: var(--theme--foreground-subdued); }
.empty { color: var(--theme--foreground-subdued); }
.error { margin: 0 0 12px; font-size: 13px; color: var(--theme--danger); }
</style>
