<script setup lang="ts">
// The Explorer sidebar (spec section 3): the lab's own grouping of pages, with each collection's
// saved views nested under it. It sits in the host's navigation column; the host supplies the
// ExplorerHost (ExplorerView in d1-home) and this component only reads it.
//
// Active state is ours (`.on`, from linkActive, which reads the query too); vue-router ignores the
// query, so its own active classes are switched off on the links.
//
// Plain HTML, the kit's tokens and the host's navigation theme variables, so it can move to the
// standalone app unchanged. The "Find a record" box only emits; the finder dialog is wired by
// the host page.
import { computed, inject, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import '../components/tokens.css';
import { EXPLORER_HOST } from '../host';
import { linkForBookmark } from './navConfig';
import type { Bookmark, NavLink } from './navConfig';
import { linkActive, readCollapsed, writeCollapsed } from './navState';
import { useExplorerNav } from './useExplorerNav';

defineEmits<{ (e: 'open-finder'): void }>();

// The brand block (name and tagline). Inside Directus the project header above the navigation
// slot already shows it, so ExplorerView turns it off; the standalone app leaves it on.
withDefaults(defineProps<{ showBrand?: boolean }>(), { showBrand: true });

const host = inject(EXPLORER_HOST);
if (!host) throw new Error('ExplorerNav needs an ExplorerHost: render it inside ExplorerView');
const { nav, loading, error, refresh } = useExplorerNav(host);

const route = useRoute();
const router = useRouter();

const active = (to: string) => linkActive(to, route.path, route.query);
const bookmarkTo = (b: Bookmark) => linkForBookmark(b);

// /d1-report/* is an API page, not an app route: open it from the server root, as the Home
// buttons do (home/goto.ts). An app route resolves with the app's base path.
function newTabHref(to: string): string {
	return to.startsWith('/d1-report/') ? to : router.resolve(to).href;
}

// Collapsible groups. `collapsed` is what the user chose (remembered in this browser); `forced`
// holds the groups opened because the current page is inside them, which is not remembered.
const collapsed = ref<Set<string>>(new Set(readCollapsed()));
const forced = ref<Set<string>>(new Set());

const isOpen = (id: string) => forced.value.has(id) || !collapsed.value.has(id);

function toggle(id: string) {
	const next = new Set(collapsed.value);
	if (isOpen(id)) {
		next.add(id);
		const f = new Set(forced.value);
		f.delete(id);
		forced.value = f;
	} else {
		next.delete(id);
	}
	collapsed.value = next;
	writeCollapsed([...next]);
}

type VisibleLink = NavLink & { bookmarks: Bookmark[] };
const holdsPage = (links: VisibleLink[]) => links.some((l) => active(l.to) || l.bookmarks.some((b) => active(bookmarkTo(b))));

// Open the group holding the page you are on, when you arrive on it (a link, the finder) and when
// the list first loads; not on every render, so a group you close stays closed.
// Only the ids matter: the computed re-evaluates (to a new array) whenever the nav reloads, and a
// group the user just closed must not be re-opened by that.
const holdingGroups = computed(() => nav.value.groups.filter((g) => g.collapsible && holdsPage(g.links)).map((g) => g.id));
watch(
	() => holdingGroups.value.join(),
	() => {
		const ids = holdingGroups.value;
		if (ids.length) forced.value = new Set([...forced.value, ...ids]);
	},
	{ immediate: true },
);
</script>

<template>
	<nav class="d1-kit d1-nav" aria-label="Explorer">
		<div v-if="showBrand" class="brand">
			STARBase
			<small>A sisyphean pursuit</small>
		</div>

		<button type="button" class="find" @click="$emit('open-finder')">
			<span>Find a record…</span>
			<kbd>Ctrl K</kbd>
		</button>

		<section v-for="group in nav.groups" :key="group.id" class="group">
			<template v-if="group.label">
				<button
					v-if="group.collapsible"
					type="button"
					class="head toggle"
					:aria-expanded="isOpen(group.id)"
					:aria-controls="`d1-nav-${group.id}`"
					@click="toggle(group.id)"
				>
					<span>{{ group.label }}</span>
					<span class="chev" :class="{ open: isOpen(group.id) }" aria-hidden="true"></span>
				</button>
				<h2 v-else class="head">{{ group.label }}</h2>
			</template>

			<ul v-show="!group.collapsible || isOpen(group.id)" :id="`d1-nav-${group.id}`" class="list">
				<li v-for="link in group.links" :key="link.to">
					<a v-if="link.newTab" class="item" :href="newTabHref(link.to)" target="_blank" rel="noopener">
						<span class="label">{{ link.label }}</span>
						<span class="ext" aria-hidden="true">↗</span>
						<span class="sr">(opens in a new tab)</span>
					</a>
					<router-link
						v-else
						class="item"
						:class="{ on: active(link.to) }"
						active-class=""
						exact-active-class=""
						:to="link.to"
						:aria-current="active(link.to) ? 'page' : undefined"
					>
						<span class="label">{{ link.label }}</span>
					</router-link>

					<ul v-if="link.bookmarks.length" class="subs" :aria-label="`${link.label} saved views`">
						<li v-for="b in link.bookmarks" :key="b.id">
							<router-link
								class="item sub"
								:class="{ on: active(bookmarkTo(b)) }"
								active-class=""
								exact-active-class=""
								:to="bookmarkTo(b)"
								:aria-current="active(bookmarkTo(b)) ? 'page' : undefined"
							>
								<span class="label">{{ b.bookmark }}</span>
							</router-link>
						</li>
					</ul>
				</li>
			</ul>
		</section>

		<p v-if="loading" class="note" role="status">Loading pages…</p>
		<p v-else-if="error" class="note" role="status">
			Couldn't load the list of pages.
			<button type="button" class="retry" @click="refresh">Retry</button>
		</p>
	</nav>
</template>

<style scoped>
.d1-nav {
	--nav-fg: var(--theme--navigation--list--foreground, var(--theme--foreground));
	--nav-dim: color-mix(in srgb, var(--nav-fg) 62%, transparent);
	--nav-hover: var(--theme--navigation--list--background-hover, var(--d1-tint));
	--nav-on: var(--theme--navigation--list--background-active, var(--d1-tint));
	display: flex;
	flex-direction: column;
	padding: 12px 8px 24px;
	font-family: var(--theme--navigation--list--font-family, var(--theme--fonts--sans--font-family, inherit));
	font-size: var(--fs-md, 13px);
	line-height: 1.4;
	color: var(--nav-fg);
}
.brand { padding: 4px 10px 10px; font-size: var(--fs-lg, 15px); font-weight: 700; }
.brand small { display: block; font-size: var(--fs-xs, 11px); font-weight: 400; color: var(--nav-dim); }

.find {
	display: flex; align-items: center; justify-content: space-between; gap: 8px;
	margin: 0 4px 10px; height: 30px; padding: 0 10px;
	border: 1px solid var(--d1-line); border-radius: 8px;
	background: var(--d1-surface); color: var(--nav-dim);
	font: inherit; font-size: var(--fs-sm, 12px); cursor: pointer;
}
.find:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.find kbd {
	font: inherit; font-size: var(--fs-xs, 11px); padding: 0 4px;
	border: 1px solid var(--d1-line); border-radius: 4px;
}

.group { margin: 0; }
.head {
	display: flex; align-items: center; justify-content: space-between; width: 100%;
	margin: 12px 0 4px; padding: 0 10px;
	border: 0; background: none; color: var(--nav-dim); text-align: left;
	font: inherit; font-size: var(--fs-xs, 11px); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
}
.head.toggle { cursor: pointer; border-radius: 7px; padding-top: 2px; padding-bottom: 2px; }
.head.toggle:hover { color: var(--nav-fg); }
.chev {
	width: 6px; height: 6px; margin-right: 2px;
	border-right: 2px solid currentColor; border-bottom: 2px solid currentColor;
	transform: rotate(-45deg); transition: transform 0.12s ease;
}
.chev.open { transform: rotate(45deg); }

.list, .subs { list-style: none; margin: 0; padding: 0; }
.item {
	display: flex; align-items: center; justify-content: space-between; gap: 6px;
	padding: 4px 10px; border-radius: 7px;
	color: var(--nav-fg); text-decoration: none;
}
.item:hover { background: var(--nav-hover); }
.item.on { background: var(--nav-on); font-weight: 600; }
.item.sub { padding-left: 26px; font-size: var(--fs-sm, 12px); }
.label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ext { font-size: var(--fs-xs, 11px); color: var(--nav-dim); }

.note { margin: 14px 10px 0; font-size: var(--fs-sm, 12px); color: var(--nav-dim); }
.retry {
	margin-left: 4px; padding: 0; border: 0; background: none; cursor: pointer;
	font: inherit; font-weight: 600; color: var(--d1-accent, var(--theme--primary)); text-decoration: underline;
}

.find:focus-visible, .head.toggle:focus-visible, .item:focus-visible, .retry:focus-visible {
	outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px;
}
.sr {
	position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
	clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
</style>
