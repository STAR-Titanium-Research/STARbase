<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { useRouter } from 'vue-router';
import { Section, collectionRoute } from '@d1/ui';
import { go } from './goto';
import { SAMPLES_LIST, samplesBookmarkLink } from './samplesBookmark';

// The counts that Home always had, a quiet strip under "my work". Every count reads as the signed-in
// user, so since ADR-0011 it is what that user may see (see "What you see" in the Explorer pages
// wiki page for every path), not the lab's total. Lab Admins still see everything.
const api = useApi();
const router = useRouter();

const stats = ref([
	{ label: 'Samples', value: '—', icon: 'science', to: SAMPLES_LIST },
	{ label: 'Machining', value: '—', icon: 'build', to: collectionRoute('manufacturing_operations') },
	{ label: 'FAST', value: '—', icon: 'whatshot', to: '/d1-fast-dashboard' },
	{ label: 'Tests', value: '—', icon: 'biotech', to: collectionRoute('test_sessions') },
	{ label: 'Campaigns', value: '—', icon: 'flag', to: collectionRoute('campaigns') },
]);

async function count(collection: string, filter?: any): Promise<string> {
	try {
		const params: any = { aggregate: { count: '*' }, limit: 1 };
		if (filter) params.filter = filter;
		const res = await api.get(`/items/${collection}`, { params });
		return Number(res.data.data[0].count).toLocaleString('en-GB');
	} catch {
		return '—';
	}
}

onMounted(async () => {
	samplesBookmarkLink(api).then((to) => (stats.value[0].to = to));
	// Split manufacturing_operations into machining vs FAST (sintering) counts.
	const [s, mach, fast, t, c] = await Promise.all([
		count('physical_samples'),
		count('manufacturing_operations', { process_category: { _neq: 'sintering' } }),
		count('manufacturing_operations', { process_category: { _eq: 'sintering' } }),
		count('test_sessions'),
		count('campaigns'),
	]);
	[s, mach, fast, t, c].forEach((v, i) => (stats.value[i].value = v));
});
</script>

<template>
	<Section title="At a glance">
		<template #actions><span class="sub">Counts of the records you can see</span></template>
		<div class="stats">
			<button v-for="st in stats" :key="st.label" class="stat" @click="go(router, st.to)">
				<span class="s-value">{{ st.value }}</span>
				<span class="s-label"><v-icon :name="st.icon" x-small class="s-icon" />{{ st.label }}</span>
			</button>
		</div>
		<!-- The full rule, one click away: as a paragraph above the tiles it was the heaviest thing
		     in the block. -->
		<details class="rule">
			<summary>Which records can I see?</summary>
			<p>Yours, ones you co-own, those of projects where you are PI or investigator (including through the project's campaigns), campaigns you own or that hold a sample you own or co-own, projects where you own a campaign, sample, operation or test, and the operations and tests of samples you can see.</p>
		</details>
	</Section>
</template>

<style scoped>
.sub { font-size: var(--fs-xs); color: var(--d1-dim); }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
.stat {
	display: flex; flex-direction: column; align-items: flex-start; gap: 1px; min-width: 0; padding: 8px 12px; cursor: pointer;
	font: inherit; color: var(--theme--foreground); text-align: left;
	border: 1px solid var(--d1-line); border-radius: 10px; background: var(--d1-tile);
	transition: border-color 0.12s ease;
}
.stat:hover { border-color: var(--theme--primary); }
.s-value { font-size: var(--fs-2xl); font-weight: 700; line-height: 1.15; font-variant-numeric: tabular-nums; }
.s-label { font-size: var(--fs-sm); font-weight: 600; color: var(--d1-dim); white-space: nowrap; }
.s-icon { margin-right: 4px; vertical-align: -2px; --v-icon-color: var(--d1-dim); }
.rule { margin-top: 10px; font-size: var(--fs-sm); color: var(--d1-dim); }
.rule summary { cursor: pointer; font-weight: 600; width: fit-content; }
.rule p { margin: 6px 0 0; max-width: 72ch; line-height: 1.5; }
</style>
