<script setup lang="ts">
import { computed } from 'vue';
import { KIND_FILTER_ITEMS, STRENGTH_FILTER_ITEMS, hasActiveFilters, type InboxFilters } from './inboxModel';

// The filter bar of the Inbox: kind, match, folder text, file date range and (when the person has team folders) whose folder. Every change
// is reported as a patch; the page writes it into the URL. Native controls in the labels page's field style, so both hosts draw them alike.
const props = defineProps<{
	filters: InboxFilters;
	/** The teams whose folders the person can see, for the owner menu. */
	teams: Array<{ team_id: string; name: string }>;
	/** The person has a folder of their own (so "My folder" means something). */
	hasOwn: boolean;
}>();
const emit = defineEmits<{ (e: 'patch', patch: Partial<InboxFilters>): void; (e: 'clear'): void }>();

const owners = computed(() => [
	{ value: 'any', text: 'All my folders' },
	...(props.hasOwn ? [{ value: 'me', text: 'My folder' }] : []),
	...props.teams.map((t) => ({ value: `team:${t.team_id}`, text: `${t.name} team folder` })),
]);
// A link can carry a list that is not one of the choices ("code,none"): the menu then shows it as such instead of a blank.
const strengths = computed(() =>
	STRENGTH_FILTER_ITEMS.some((o) => o.value === props.filters.strength) ? STRENGTH_FILTER_ITEMS : [...STRENGTH_FILTER_ITEMS, { value: props.filters.strength, text: 'Several kinds of match' }],
);
const showOwner = computed(() => props.teams.length > 0 || props.filters.owner !== 'any');
const active = computed(() => hasActiveFilters(props.filters));
const on = (e: Event) => (e.target as HTMLInputElement).value;
</script>

<template>
	<div class="bar lf-row" role="group" aria-label="Filter found files">
		<label class="lf-field">Kind
			<select :value="filters.kind" data-test="filter-kind" @change="emit('patch', { kind: on($event) })">
				<option v-for="o in KIND_FILTER_ITEMS" :key="o.value" :value="o.value">{{ o.text }}</option>
			</select>
		</label>
		<label class="lf-field">Match
			<select :value="filters.strength" data-test="filter-strength" @change="emit('patch', { strength: on($event) })">
				<option v-for="o in strengths" :key="o.value" :value="o.value">{{ o.text }}</option>
			</select>
		</label>
		<label v-if="showOwner" class="lf-field">Folder of
			<select :value="filters.owner" data-test="filter-owner" @change="emit('patch', { owner: on($event) })">
				<option v-for="o in owners" :key="o.value" :value="o.value">{{ o.text }}</option>
			</select>
		</label>
		<label class="lf-field grow">Folder contains
			<input type="search" :value="filters.folder" placeholder="e.g. sem" data-test="filter-folder" @change="emit('patch', { folder: on($event).trim() })" @keyup.enter="emit('patch', { folder: on($event).trim() })" />
		</label>
		<label class="lf-field">From
			<input type="date" :value="filters.from" data-test="filter-from" @change="emit('patch', { from: on($event) })" />
		</label>
		<label class="lf-field">To
			<input type="date" :value="filters.to" data-test="filter-to" @change="emit('patch', { to: on($event) })" />
		</label>
		<button v-if="active" type="button" class="lf-link clear" @click="emit('clear')">Clear filters</button>
	</div>
</template>

<style scoped>
.bar { align-items: flex-end; }
.grow { flex: 1 1 160px; }
.clear { align-self: center; }
</style>
