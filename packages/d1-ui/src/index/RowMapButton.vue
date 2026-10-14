<script setup lang="ts">
// A Process map pill at the end of an index row (and in a card's footer) of the kinds that have no record
// page: it opens the map on the record's used-in fan. Drawn only for those kinds. A click on it does not
// also open the row.
import { computed } from 'vue';
import AppLink from '../components/AppLink.vue';
import { MAP_ROW_COLLECTIONS, mapPath } from '../mapLink';

const props = defineProps<{
	collection: string;
	id: string;
	/** The row's own name (its code or label): in the accessible name, so a screen reader can tell the rows apart. */
	label?: string;
	/** `row`: a pill no taller than a table line (so a compact row does not grow); `card`: the full-size pill of a card's footer. */
	size?: 'row' | 'card';
}>();

const shown = computed(() => MAP_ROW_COLLECTIONS.includes(props.collection));
</script>

<template>
	<span v-if="shown" class="map" :class="size === 'card' ? 's-card' : 's-row'">
		<AppLink :to="mapPath(collection, id)" class="pill" title="Open the Process map" :aria-label="label ? `Process map of ${label}` : 'Process map'" @click.stop>
			<v-icon name="account_tree" x-small left />Process map
		</AppLink>
	</span>
</template>

<style scoped>
.map { display: inline-flex; gap: 4px; justify-content: flex-end; }
.pill {
	display: inline-flex; align-items: center; box-sizing: border-box; height: 22px; padding: 0 9px; border-radius: 99px;
	border: 1px solid var(--d1-line); background: var(--d1-tile); color: var(--d1-accent, var(--theme--primary));
	font-size: var(--fs-xs, 11px); font-weight: 600; text-decoration: none; white-space: nowrap;
}
/* In a table row the pill is no taller than a compact line, so the row does not grow when it arrives. */
.s-row { display: flex; }
.s-row .pill { height: 17px; padding: 0 8px; line-height: 1; }
.pill:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.pill:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
</style>
