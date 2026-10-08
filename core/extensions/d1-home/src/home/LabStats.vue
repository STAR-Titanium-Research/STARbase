<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { useRouter } from 'vue-router';
import { collectionRoute } from '@d1/ui';
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
	<section aria-labelledby="stats-h">
		<h2 id="stats-h" class="h">At a glance</h2>
		<p class="sub">Counts of the records you can see: yours, ones you co-own, those of projects where you are PI or investigator (including through the project's campaigns), campaigns you own or that hold a sample you own or co-own, projects where you own a campaign, sample, operation or test, and the operations and tests of samples you can see.</p>
		<div class="stats">
			<button v-for="st in stats" :key="st.label" class="stat" @click="go(router, st.to)">
				<v-icon :name="st.icon" class="s-icon" />
				<span class="s-value">{{ st.value }}</span>
				<span class="s-label">{{ st.label }}</span>
			</button>
		</div>
	</section>
</template>

<style scoped>
.h { margin: 0 0 4px; font-size: 18px; font-weight: 750; }
.sub { margin: 0 0 10px; font-size: 13px; color: var(--theme--foreground-subdued); }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.stat {
	display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 14px 16px; cursor: pointer;
	font: inherit; color: var(--theme--foreground); text-align: left;
	border: 1px solid var(--theme--border-color-subdued); border-radius: 14px; background: var(--theme--background);
}
.stat:hover { border-color: var(--theme--primary); }
.s-icon { --v-icon-color: var(--theme--primary); margin-bottom: 4px; }
.s-value { font-size: 24px; font-weight: 760; letter-spacing: -0.02em; }
.s-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--theme--foreground-subdued); font-weight: 600; }
</style>
