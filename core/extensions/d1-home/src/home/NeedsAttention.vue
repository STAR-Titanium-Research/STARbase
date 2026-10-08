<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { LoadState, collectionRoute, errorText, useItems, useRequestGate } from '@d1/ui';
import { bookmarkId } from './samplesBookmark';
import { ATTENTION, ATTENTION_LIST_LIMIT, type AttentionDef, type AttentionItem } from './attention';

// Counts of things that need a look. Each tile loads its own count (a role that cannot read one
// collection still gets the others) and opens, on click, the matching records right below the
// tiles, each linking to its Explorer page. The same filters typed into the Data Studio give the
// same numbers (see attention.ts).
const props = defineProps<{ isAdmin: boolean }>();

const { getItems } = useItems();
const api = useApi();
const gate = useRequestGate();

const defs = computed(() => ATTENTION.filter((d) => !d.adminOnly || props.isAdmin));

interface TileState { count: number | null; error: string; loading: boolean }
const state = ref<Record<string, TileState>>({});
const open = ref<string | null>(null);
const list = ref<{ loading: boolean; error: string; items: AttentionItem[] }>({ loading: false, error: '', items: [] });
const listGate = useRequestGate();

async function loadCount(def: AttentionDef, token: number) {
	state.value[def.key] = { count: null, error: '', loading: true };
	try {
		const rows = await getItems(def.collection, { aggregate: { count: '*' }, filter: def.filter, limit: 1 });
		if (gate.isCurrent(token)) state.value[def.key] = { count: Number(rows[0]?.count ?? 0), error: '', loading: false };
	} catch (e: any) {
		if (gate.isCurrent(token)) state.value[def.key] = { count: null, error: `Could not count: ${errorText(e)}`, loading: false };
	}
}

async function toggle(def: AttentionDef) {
	if (open.value === def.key) {
		open.value = null;
		return;
	}
	open.value = def.key;
	const token = listGate.begin();
	list.value = { loading: true, error: '', items: [] };
	try {
		const rows = await getItems(def.collection, {
			filter: def.filter,
			fields: def.fields,
			sort: def.sort,
			limit: ATTENTION_LIST_LIMIT,
		});
		if (listGate.isCurrent(token)) list.value = { loading: false, error: '', items: rows.map(def.toItem) };
	} catch (e: any) {
		if (listGate.isCurrent(token)) list.value = { loading: false, error: `Could not load the list: ${errorText(e)}`, items: [] };
	}
}

const openDef = computed(() => defs.value.find((d) => d.key === open.value) ?? null);
// A tile whose filter exists as a Data Studio bookmark ("Failed") links to that filtered view,
// found by name since its id differs between installs. Without it the link is the plain, unfiltered
// collection and says so.
const bookmarkIds = ref<Record<string, number>>({});
const moreLink = computed(() => {
	const d = openDef.value;
	if (!d) return null;
	const id = bookmarkIds.value[d.key];
	return id === undefined
		? { to: collectionRoute(d.collection), text: 'Open the collection in the Data Studio (unfiltered)' }
		: { to: `/content/${d.collection}?bookmark=${id}`, text: `Open the "${d.bookmark}" bookmark in the Data Studio` };
});
const openCount = computed(() => (open.value ? (state.value[open.value]?.count ?? 0) : 0));

onMounted(() => {
	const token = gate.begin();
	for (const d of defs.value) {
		loadCount(d, token);
		if (d.bookmark) {
			bookmarkId(api, d.collection, d.bookmark).then((id) => {
				if (id !== null) bookmarkIds.value = { ...bookmarkIds.value, [d.key]: id };
			});
		}
	}
});
onBeforeUnmount(() => {
	gate.cancel();
	listGate.cancel();
});

const show = (s: TileState | undefined) => (!s || s.loading ? '…' : s.count === null ? '–' : s.count.toLocaleString('en-GB'));
</script>

<template>
	<section class="attention" aria-labelledby="attention-h">
		<div class="section-head"><h2 id="attention-h">Needs attention</h2></div>
		<p class="sub">Counts of the records you can see.</p>
		<div class="tiles">
			<button
				v-for="d in defs"
				:key="d.key"
				class="tile"
				:class="{ hot: (state[d.key]?.count ?? 0) > 0, open: open === d.key }"
				:disabled="!state[d.key] || state[d.key].loading || state[d.key].count === null || state[d.key].count === 0"
				:aria-expanded="open === d.key"
				:title="state[d.key]?.error || d.hint"
				@click="toggle(d)"
			>
				<v-icon :name="d.icon" class="t-icon" />
				<span class="t-value">{{ show(state[d.key]) }}</span>
				<span class="t-label">{{ d.label }}</span>
			</button>
		</div>

		<div v-if="openDef" class="panel">
			<LoadState :loading="list.loading" :error="list.error">
				<ul class="items">
					<li v-for="i in list.items" :key="i.id">
						<router-link :to="i.to" class="i-title">{{ i.title }}</router-link>
						<span v-if="i.sub" class="i-sub">{{ i.sub }}</span>
					</li>
				</ul>
				<p v-if="moreLink && openCount > list.items.length" class="more">
					Showing {{ list.items.length }} of {{ openCount }}.
					<router-link :to="moreLink.to">{{ moreLink.text }}</router-link>
				</p>
			</LoadState>
		</div>
	</section>
</template>

<style scoped>
.section-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 4px; }
.section-head h2 { margin: 0; font-size: 18px; font-weight: 750; }
.sub { margin: 0 0 10px; font-size: 13px; color: var(--theme--foreground-subdued); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.tile {
	display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 14px 16px; text-align: left;
	font: inherit; color: var(--theme--foreground); cursor: pointer;
	border: 1px solid var(--theme--border-color-subdued); border-radius: 14px; background: var(--theme--background);
	transition: border-color 0.14s ease, box-shadow 0.14s ease;
}
.tile:disabled { cursor: default; opacity: 0.85; }
.tile:not(:disabled):hover, .tile.open { border-color: var(--theme--primary); }
.tile.hot { border-color: var(--theme--warning); }
.tile.hot .t-value { color: var(--theme--warning); }
.t-icon { --v-icon-color: var(--theme--foreground-subdued); margin-bottom: 4px; }
.tile.hot .t-icon { --v-icon-color: var(--theme--warning); }
.t-value { font-size: 26px; font-weight: 760; letter-spacing: -0.02em; }
.t-label { font-size: 12.5px; color: var(--theme--foreground-subdued); font-weight: 600; }
.panel {
	margin-top: 12px; padding: 12px 16px; border-radius: 14px;
	border: 1px solid var(--theme--border-color-subdued); background: var(--theme--background);
}
.items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.items li { display: flex; gap: 12px; align-items: baseline; }
.i-title { color: var(--theme--primary); font-weight: 650; text-decoration: none; font-family: var(--theme--fonts--monospace--font-family, monospace); }
.i-title:hover { text-decoration: underline; }
.i-sub { font-size: 12.5px; color: var(--theme--foreground-subdued); }
.more { margin: 10px 0 0; font-size: 12.5px; color: var(--theme--foreground-subdued); }
.more a { color: var(--theme--primary); }
</style>
