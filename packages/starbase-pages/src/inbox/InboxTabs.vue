<script setup lang="ts">
import { AppLink } from '@d1/ui';
import { TABS, filtersToQuery, type InboxFilters } from './inboxModel';

// The tabs of the Inbox are links (the tab is part of the address, so a link, Back and a reload all work): the one you are on carries
// aria-current. Each keeps the other filters.
const props = defineProps<{ filters: InboxFilters; counts: (id: string) => number | null }>();

function to(id: string): string {
	const q = new URLSearchParams(filtersToQuery({ ...props.filters, tab: id as InboxFilters['tab'] })).toString();
	return q ? `/inbox?${q}` : '/inbox';
}
</script>

<template>
	<nav class="tabs" aria-label="Inbox tabs">
		<AppLink
			v-for="t in TABS"
			:key="t.id"
			:to="to(t.id)"
			class="tab"
			:class="{ on: filters.tab === t.id }"
			:aria-current="filters.tab === t.id ? 'page' : undefined"
			:data-test="`tab-${t.id}`"
		>
			{{ t.label }}<span v-if="counts(t.id)" class="n">{{ counts(t.id) }}</span>
		</AppLink>
	</nav>
</template>

<style scoped>
.tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--d1-line); }
.tab {
	display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; border-bottom: 2px solid transparent; margin-bottom: -1px;
	color: var(--d1-dim); font-size: var(--fs-md, 13px); font-weight: 600; text-decoration: none;
}
.tab:hover { color: var(--theme--foreground); }
.tab.on { color: var(--theme--foreground); border-bottom-color: var(--d1-accent, var(--theme--primary)); }
.tab:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -2px; }
.n { padding: 0 6px; border-radius: 99px; font-size: var(--fs-xs, 11px); font-weight: 700; background: color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 16%, transparent); color: var(--d1-accent, var(--theme--primary)); }
</style>
