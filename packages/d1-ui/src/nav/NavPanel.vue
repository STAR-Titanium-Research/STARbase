<script setup lang="ts">
// The panel of the Explorer sidebar: the selected section's title and its groups of links, with
// each list's saved views nested under it. The Kit section holds two collapsible groups
// (Inventory, Resources); the others are one plain list under the title.
//
// Active state is ours (`.on`, from linkActive, which reads the query too); vue-router ignores the
// query, so its own active classes are switched off on the links.
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { linkForBookmark } from './navConfig';
import type { Bookmark } from './navConfig';
import { linkActive, readCollapsed, writeCollapsed } from './navState';
import type { RailGroup, RailSection } from './railModel';

const props = defineProps<{ section: RailSection }>();

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

const holdsPage = (group: RailGroup) => group.links.some((l) => active(l.to) || l.bookmarks.some((b) => active(bookmarkTo(b))));

// Open the group holding the page you are on, when you arrive on it (a link, the finder) and when
// the list first loads; not on every render, so a group you close stays closed.
// Only the ids matter: the computed re-evaluates (to a new array) whenever the nav reloads, and a
// group the user just closed must not be re-opened by that.
const holdingGroups = computed(() => props.section.groups.filter((g) => g.collapsible && holdsPage(g)).map((g) => g.id));
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
	<div class="d1-panel">
		<h2 class="title">{{ section.label }}</h2>

		<section v-for="group in section.groups" :key="group.id" class="group">
			<button
				v-if="group.collapsible && group.label"
				type="button"
				class="head toggle"
				:aria-expanded="isOpen(group.id)"
				:aria-controls="`d1-nav-${group.id}`"
				@click="toggle(group.id)"
			>
				<span>{{ group.label }}</span>
				<span class="chev" :class="{ open: isOpen(group.id) }" aria-hidden="true"></span>
			</button>

			<ul v-show="!group.collapsible || isOpen(group.id)" :id="`d1-nav-${group.id}`" class="list">
				<li v-for="link in group.links" :key="link.to">
					<a v-if="link.newTab" class="item" :href="newTabHref(link.to)" target="_blank" rel="noopener">
						<span class="label" :title="link.label">{{ link.label }}</span>
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
						<span class="label" :title="link.label">{{ link.label }}</span>
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
								<span class="label" :title="b.bookmark">{{ b.bookmark }}</span>
							</router-link>
						</li>
					</ul>
				</li>
			</ul>
		</section>
	</div>
</template>

<style scoped>
.d1-panel { min-width: 0; }
.title {
	margin: 0 0 6px; padding: 0 10px;
	font-size: var(--fs-xs, 11px); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
	color: var(--nav-dim);
}
.group { margin: 0; }
.head {
	display: flex; align-items: center; justify-content: space-between; width: 100%;
	margin: 12px 0 4px; padding: 2px 10px;
	border: 0; border-radius: 7px; background: none; color: var(--nav-dim); text-align: left;
	font: inherit; font-size: var(--fs-xs, 11px); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
	cursor: pointer;
}
.head:hover { color: var(--nav-fg); }
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
.item.sub { padding-left: 22px; font-size: var(--fs-sm, 12px); }
.label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ext { font-size: var(--fs-xs, 11px); color: var(--nav-dim); }

.head:focus-visible, .item:focus-visible {
	outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px;
}
.sr {
	position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
	clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
</style>
