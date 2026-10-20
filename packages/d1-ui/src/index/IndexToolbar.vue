<script setup lang="ts">
// The toolbar of an index page (IndexPage), above the table only: the saved-view chips, the search box, one filter
// per chip and "Clear filters". These choose WHICH rows show (they go in the URL); how rows look is the View rail's
// (IndexViewRail) and the page's buttons are IndexActions'. It draws what IndexPage hands it and reports clicks;
// the state lives in useIndexPage.
import type { IndexDef } from './indexConfig';
import { toggledBookmark } from './indexQuery';
import type { ChipView } from './useIndexPage';

defineProps<{
	def: IndexDef;
	bookmarks: { id: number; bookmark: string }[];
	activeBookmark: number | null;
	bookmarkUnavailable: boolean;
	searchText: string;
	chips: ChipView[];
	hasFilters: boolean;
}>();
const emit = defineEmits<{
	bookmark: [id: number | null];
	search: [text: string];
	filter: [field: string, value: string];
	clear: [];
}>();
</script>

<template>
	<div v-if="bookmarks.length" class="chips" role="group" aria-label="Saved views">
		<span class="lbl">Saved views</span>
		<span v-for="b in bookmarks" :key="b.id" class="chip" :class="{ on: activeBookmark === b.id }">
			<button type="button" class="chip-main" :aria-pressed="activeBookmark === b.id" @click="emit('bookmark', toggledBookmark(activeBookmark, b.id))">{{ b.bookmark }}</button>
			<button v-if="activeBookmark === b.id" type="button" class="chip-x" :aria-label="`Clear saved view ${b.bookmark}`" @click="emit('bookmark', null)">×</button>
		</span>
	</div>
	<p v-if="bookmarkUnavailable" class="d1-note warn" role="status">
		That saved view isn't available.
		<button type="button" class="link" @click="emit('bookmark', null)">Show the whole list</button>
	</p>

	<div class="filters">
		<label class="field search">
			<span>Search</span>
			<input
				type="search"
				:value="searchText"
				:placeholder="`Search ${def.title.toLowerCase()}`"
				:aria-label="`Search ${def.title.toLowerCase()}`"
				@input="emit('search', ($event.target as HTMLInputElement).value)"
			/>
		</label>
		<template v-for="chip in chips" :key="chip.field">
			<button
				v-if="chip.flag"
				type="button"
				class="flag"
				:class="{ on: chip.value === 'true' }"
				:aria-pressed="chip.value === 'true'"
				@click="emit('filter', chip.field, chip.value === 'true' ? '' : 'true')"
			>{{ chip.label }}</button>
			<label v-else class="field">
				<span>{{ chip.label }}</span>
				<select :value="chip.value" :aria-label="`Filter by ${chip.label.toLowerCase()}`" @change="emit('filter', chip.field, ($event.target as HTMLSelectElement).value)">
					<option value="">Any {{ chip.label.toLowerCase() }}</option>
					<option v-for="o in chip.options" :key="o.value" :value="o.value">{{ o.label }}</option>
				</select>
			</label>
		</template>
		<button v-if="hasFilters" type="button" class="link clear" @click="emit('clear')">Clear filters</button>
	</div>
</template>

<style scoped>
.filters, .chips { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.filters { align-items: flex-end; }
.link {
	border: 0; background: none; padding: 0; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600;
	color: var(--d1-accent, var(--theme--primary)); cursor: pointer; text-decoration: underline;
}
.clear { align-self: center; margin-top: 16px; }

.lbl { font-size: var(--fs-xs, 11px); font-weight: 600; color: var(--d1-dim); margin-right: 2px; }
.chip {
	display: inline-flex; align-items: center; border-radius: 99px;
	border: 1px solid var(--d1-line); background: var(--d1-surface);
	font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-accent, var(--theme--primary)); white-space: nowrap;
}
.chip.on { background: var(--d1-accent, var(--theme--primary)); border-color: var(--d1-accent, var(--theme--primary)); color: var(--d1-on-accent, #fff); }
.chip button { border: 0; background: none; font: inherit; color: inherit; cursor: pointer; }
.chip-main { padding: 3px 10px; border-radius: 99px; }
.chip.on .chip-main { padding-right: 4px; }
.chip-x { padding: 3px 8px 3px 2px; border-radius: 99px; font-size: var(--fs-lg, 15px); line-height: 1; }

.field { display: flex; flex-direction: column; gap: 3px; font-size: var(--fs-xs, 11px); font-weight: 600; color: var(--d1-dim); }
.field input, .field select {
	height: 30px; min-width: 140px; padding: 0 10px;
	border: 1px solid var(--theme--border-color); border-radius: 8px;
	background: var(--theme--form--field--input--background, var(--theme--background));
	color: var(--theme--foreground); font: inherit; font-size: var(--fs-md, 13px);
}
.field.search input { min-width: 240px; }
.flag {
	height: 30px; padding: 0 12px; border: 1px solid var(--theme--border-color); border-radius: 99px; background: var(--d1-surface);
	color: var(--theme--foreground); font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; cursor: pointer; align-self: flex-end;
}
.flag:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.flag.on { background: var(--d1-accent, var(--theme--primary)); border-color: var(--d1-accent, var(--theme--primary)); color: var(--d1-on-accent, #fff); }

.d1-note.warn { color: var(--d1-warn); }
</style>
