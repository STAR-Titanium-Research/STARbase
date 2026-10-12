<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { useRouter } from 'vue-router';
import { collectionRoute } from '@d1/ui';
import { go } from './goto';

// The counts that Home always had, as one band across the top: six tiles in a row down to a container of 640px (about a 950px window with the sidebar), then three
// and then two (never a lone tile on a second row). Every count reads as the signed-in
// user, so since ADR-0011 it is what that user may see (see "What you see" in the Explorer pages
// wiki page for every path), not the lab's total. Lab Admins still see everything.
const api = useApi();
const router = useRouter();

// Tiles are keyed, not positional: fill() finds its tile by key, so adding or reordering a tile
// cannot make a count land on the wrong one.
interface Stat { key: string; label: string; value: string; icon: string; to: string; }
const stats = ref<Stat[]>([
	{ key: 'samples', label: 'Samples', value: '—', icon: 'science', to: collectionRoute('physical_samples') },
	{ key: 'machining', label: 'Machining', value: '—', icon: 'build', to: collectionRoute('manufacturing_operations') },
	{ key: 'fast', label: 'FAST', value: '—', icon: 'whatshot', to: '/d1-fast-dashboard' },
	{ key: 'tests', label: 'Tests', value: '—', icon: 'biotech', to: collectionRoute('test_sessions') },
	{ key: 'projects', label: 'Projects', value: '—', icon: 'folder_open', to: collectionRoute('projects') },
	{ key: 'campaigns', label: 'Campaigns', value: '—', icon: 'flag', to: collectionRoute('campaigns') },
]);

function fill(key: string, patch: Partial<Stat>) {
	const tile = stats.value.find((st) => st.key === key);
	if (tile) Object.assign(tile, patch);
}

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

onMounted(() => {
	// Each tile fills as its own count arrives. Machining and FAST (sintering) are one collection split.
	const reads: [string, string, any?][] = [
		['samples', 'physical_samples'],
		['machining', 'manufacturing_operations', { process_category: { _neq: 'sintering' } }],
		['fast', 'manufacturing_operations', { process_category: { _eq: 'sintering' } }],
		['tests', 'test_sessions'],
		['projects', 'projects'],
		['campaigns', 'campaigns'],
	];
	for (const [key, collection, filter] of reads) count(collection, filter).then((value) => fill(key, { value }));
});
</script>

<template>
	<section class="band" aria-label="At a glance">
		<div class="stats">
			<button v-for="st in stats" :key="st.key" class="stat" @click="go(router, st.to)">
				<span class="s-value">{{ st.value }}</span>
				<span class="s-label"><v-icon :name="st.icon" x-small class="s-icon" />{{ st.label }}</span>
			</button>
		</div>
		<!-- The full rule, one click away: as a paragraph above the tiles it was the heaviest thing
		     in the block. -->
		<details class="rule">
			<summary>Counts of the records you can see. Which are those?</summary>
			<p>Yours, ones you co-own, those of projects where you are PI or investigator (including through the project's campaigns), campaigns you own or that hold a sample you own or co-own, projects where you own a campaign, sample, operation or test, and the operations and tests of samples you can see.</p>
		</details>
	</section>
</template>

<style scoped>
/* A container query, not a viewport one: the Explorer's rail and panel take a variable share of the width. */
.band {
	container-type: inline-size;
	padding: 10px 12px;
	background: var(--d1-surface);
	border: 1px solid var(--d1-line);
	border-radius: var(--d1-radius);
	box-shadow: var(--d1-shadow);
}
.stats { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
@container (max-width: 640px) { .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@container (max-width: 340px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.stat {
	display: flex; flex-direction: column; align-items: flex-start; gap: 1px; min-width: 0; padding: 8px 12px; cursor: pointer;
	font: inherit; color: var(--theme--foreground); text-align: left;
	border: 1px solid var(--d1-line); border-radius: 10px; background: var(--d1-tile);
	transition: border-color 0.12s ease;
}
.stat:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.s-value { font-size: var(--fs-2xl); font-weight: 700; line-height: 1.15; font-variant-numeric: tabular-nums; }
.s-label { max-width: 100%; overflow: hidden; text-overflow: ellipsis; font-size: var(--fs-sm); font-weight: 600; color: var(--d1-dim); white-space: nowrap; }
.s-icon { margin-right: 4px; vertical-align: -2px; --v-icon-color: var(--d1-dim); }
.rule { margin-top: 8px; font-size: var(--fs-xs); color: var(--d1-dim); }
.rule summary { cursor: pointer; font-weight: 600; width: fit-content; }
.rule p { margin: 6px 0 0; max-width: 72ch; line-height: 1.5; font-size: var(--fs-sm); }
</style>
