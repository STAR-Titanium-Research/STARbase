<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
	useExplorerHost, AppLink, BOOKMARK_VISIBILITY_FILTER,
	attentionView, LoadState, Section, collectionRoute, errorText, indexRoute, pickBookmarkId, useItems, useRequestGate,
} from '@d1/ui';
import { ATTENTION, ATTENTION_LIST_LIMIT, type AttentionDef, type AttentionItem } from './attention';

// Things that need a look: only the ones with something in them are listed (one "Nothing needs you"
// line when none is). Each loads its own count (a role that cannot read one collection still gets
// the others) and opens, on click, the matching records right under it, each linking to its
// Explorer page. The same filters typed into the Data Studio give the
// same numbers (see attention.ts).
const props = defineProps<{ isAdmin: boolean }>();

const { getItems } = useItems();
const host = useExplorerHost();
const api = host.api;
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

// The id of a named bookmark on a collection, or null when there is none (or the role cannot read
// presets). Prefers the global bookmark, then a role's, then the user's own. An admin can read
// every user's presets, so the request carries the sidebar's visibility filter and the result is
// checked again against who is signed in: another user's private view is never linked.
async function bookmarkId(collection: string, name: string): Promise<number | null> {
	try {
		const res = await api.get('/presets', {
			params: {
				filter: JSON.stringify({ _and: [BOOKMARK_VISIBILITY_FILTER, { bookmark: { _eq: name } }, { collection: { _eq: collection } }] }),
				fields: ['id', 'user', 'role'],
				sort: ['id'],
				limit: -1,
			},
		});
		return pickBookmarkId(res.data.data ?? [], host.user.value);
	} catch {
		return null;
	}
}

const openDef = computed(() => defs.value.find((d) => d.key === open.value) ?? null);
// A tile whose filter exists as a saved view ("Failed") links to the Explorer list with that view
// applied, found by name since its id differs between installs. Without it the link is the plain list.
const bookmarkIds = ref<Record<string, number>>({});
const moreLink = computed(() => {
	const d = openDef.value;
	if (!d) return null;
	const id = bookmarkIds.value[d.key];
	return id === undefined
		? { to: collectionRoute(d.collection), text: 'See the list' }
		: { to: indexRoute(d.collection, { bookmark: id }), text: 'See all' };
});
const openCount = computed(() => (open.value ? (state.value[open.value]?.count ?? 0) : 0));

// Counts load for the tiles shown, and again for a tile that appears later: the admin-only one
// shows only once the host has learnt the user is an admin (it starts as a guess).
const token = gate.begin();
const started = new Set<string>();
function loadBookmark(d: AttentionDef) {
	if (!d.bookmark) return;
	bookmarkId(d.collection, d.bookmark).then((id) => {
		const next = { ...bookmarkIds.value };
		if (id !== null) next[d.key] = id;
		else delete next[d.key];
		bookmarkIds.value = next;
	});
}
watch(
	defs,
	(list) => {
		for (const d of list) {
			if (started.has(d.key)) continue;
			started.add(d.key);
			loadCount(d, token);
			loadBookmark(d);
		}
	},
	{ immediate: true },
);
// Who is signed in arrives after the page does: pick the views again with it.
watch(
	() => host.user.value?.id,
	() => {
		for (const d of defs.value) loadBookmark(d);
	},
);
onBeforeUnmount(() => {
	gate.cancel();
	listGate.cancel();
});

// Which rows to list, and whether to say "checking" or "nothing" instead (the rule is in @d1/ui adminHome.ts).
// A failed count shows for an admin; for anyone else it is hidden (a role that cannot read a collection
// would otherwise carry a permanent red row for it).
const view = computed(() =>
	attentionView(
		defs.value.map((d) => ({ key: d.key, count: state.value[d.key]?.count ?? null, error: state.value[d.key]?.error ?? '', loading: !state.value[d.key] || state.value[d.key].loading })),
		props.isAdmin,
	),
);
const shown = computed(() => defs.value.filter((d) => view.value.rows.includes(d.key)));

const show = (s: TileState | undefined) => (!s || s.loading ? '…' : s.count === null ? '–' : s.count.toLocaleString('en-GB'));
</script>

<template>
	<Section title="Needs attention">
		<template #actions><span class="sub">Counts of the records you can see</span></template>
		<p v-if="view.status === 'loading'" class="d1-note">Checking…</p>
		<p v-else-if="view.status === 'clear'" class="clear"><v-icon name="check_circle" small class="clear-icon" /> Nothing needs you</p>
		<ul v-else class="rows">
			<li v-for="d in shown" :key="d.key">
				<button
					class="tile"
					:class="{ hot: (state[d.key]?.count ?? 0) > 0, open: open === d.key }"
					:disabled="state[d.key]?.count === null || state[d.key]?.count === 0"
					:aria-expanded="open === d.key"
					:title="state[d.key]?.error || d.hint"
					@click="toggle(d)"
				>
					<span class="t-value">{{ show(state[d.key]) }}</span>
					<span class="t-label"><v-icon :name="d.icon" x-small class="t-icon" />{{ d.label }}</span>
				</button>
				<p v-if="state[d.key]?.error" class="d1-note bad">{{ state[d.key].error }}</p>
				<div v-if="open === d.key" class="list">
					<LoadState :loading="list.loading" :error="list.error">
						<ul class="items">
							<li v-for="i in list.items" :key="i.id">
								<AppLink :to="i.to" class="i-title" :class="{ plain: i.plain }">{{ i.title }}</AppLink>
								<span v-if="i.sub" class="i-sub">{{ i.sub }}</span>
							</li>
						</ul>
						<p v-if="moreLink && openCount > list.items.length" class="d1-note more">
							Showing {{ list.items.length }} of {{ openCount }}.
							<AppLink :to="moreLink.to">{{ moreLink.text }}</AppLink>
						</p>
					</LoadState>
				</div>
			</li>
		</ul>
	</Section>
</template>

<style scoped>
.sub { font-size: var(--fs-xs); color: var(--d1-dim); }
.clear { display: flex; align-items: center; gap: 8px; margin: 0; font-weight: 600; color: var(--d1-ok); }
.clear-icon { --v-icon-color: var(--d1-ok); }
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
/* A count the size of the Record page's readouts, with what it counts beside it, one row per item. */
.tile {
	display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; padding: 8px 12px; text-align: left;
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
.list { margin-top: 8px; padding: 2px 4px 4px; }
.items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.items li { display: flex; flex-wrap: wrap; gap: 2px 12px; align-items: baseline; }
.i-title { color: var(--d1-accent, var(--theme--primary)); font-weight: 650; text-decoration: none; overflow-wrap: anywhere; font-family: var(--theme--fonts--monospace--font-family, monospace); }
.i-title.plain { font-family: inherit; }
.i-title:hover { text-decoration: underline; }
.i-sub { font-size: var(--fs-sm); color: var(--d1-dim); }
.more { margin-top: 10px; }
</style>
