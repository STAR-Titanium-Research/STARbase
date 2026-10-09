<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { LoadState, Section, collectionRoute, errorText, useItems, useRequestGate } from '@d1/ui';
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
	<Section title="Needs attention">
		<template #actions><span class="sub">Counts of the records you can see</span></template>
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
				<span class="t-value">{{ show(state[d.key]) }}</span>
				<span class="t-label"><v-icon :name="d.icon" x-small class="t-icon" />{{ d.label }}</span>
			</button>
		</div>

		<div v-if="openDef" class="list">
			<LoadState :loading="list.loading" :error="list.error">
				<ul class="items">
					<li v-for="i in list.items" :key="i.id">
						<router-link :to="i.to" class="i-title" :class="{ plain: i.plain }">{{ i.title }}</router-link>
						<span v-if="i.sub" class="i-sub">{{ i.sub }}</span>
					</li>
				</ul>
				<p v-if="moreLink && openCount > list.items.length" class="d1-note more">
					Showing {{ list.items.length }} of {{ openCount }}.
					<router-link :to="moreLink.to">{{ moreLink.text }}</router-link>
				</p>
			</LoadState>
		</div>
	</Section>
</template>

<style scoped>
.sub { font-size: var(--fs-xs); color: var(--d1-dim); }
/* 260px keeps the longest label ("Force analysis errors on my operations") on one line. */
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 8px; }
/* A count the size of the Record page's readouts, with what it counts beside it. */
.tile {
	display: flex; align-items: center; gap: 12px; min-width: 0; padding: 8px 12px; text-align: left;
	font: inherit; color: var(--theme--foreground); cursor: pointer;
	border: 1px solid var(--d1-line); border-radius: 10px; background: var(--d1-tile);
	transition: border-color 0.12s ease;
}
.tile:disabled { cursor: default; }
.tile:not(:disabled):hover, .tile.open { border-color: var(--d1-accent, var(--theme--primary)); }
.tile.hot { border-color: var(--theme--warning); background: color-mix(in srgb, var(--theme--warning) 10%, var(--d1-surface)); }
.tile.hot .t-value { color: var(--d1-warn); }
.tile.hot.open { box-shadow: inset 0 0 0 1px var(--theme--warning); }
.t-value { flex: none; min-width: 1.2em; font-size: var(--fs-2xl); font-weight: 700; line-height: 1.15; font-variant-numeric: tabular-nums; }
.tile:disabled .t-value { color: var(--d1-dim); }
.t-label { font-size: var(--fs-sm); font-weight: 600; line-height: 1.3; color: var(--d1-dim); }
.t-icon { margin-right: 4px; vertical-align: -2px; --v-icon-color: var(--d1-dim); }
.tile.hot .t-icon { --v-icon-color: var(--d1-warn); }
.list { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--d1-line); }
.items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.items li { display: flex; flex-wrap: wrap; gap: 2px 12px; align-items: baseline; }
.i-title { color: var(--d1-accent, var(--theme--primary)); font-weight: 650; text-decoration: none; overflow-wrap: anywhere; font-family: var(--theme--fonts--monospace--font-family, monospace); }
.i-title.plain { font-family: inherit; }
.i-title:hover { text-decoration: underline; }
.i-sub { font-size: var(--fs-sm); color: var(--d1-dim); }
.more { margin-top: 10px; }
</style>
