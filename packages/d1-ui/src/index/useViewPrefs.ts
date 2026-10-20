// The View rail's settings of one index page: the list's saved prefs (layout, density, columns, rows per page,
// group-by; listPrefs.ts), kept on this device as soon as one changes, the def as the person's columns make it
// (what the table, cards and list draw), and the page's own width, which is only known once it is on screen
// (the rail opens by default from 1500px of it).
import { computed, reactive, ref, watch } from 'vue';
import { shownColumns } from './columnPicker';
import type { IndexDef } from './indexConfig';
import { readListPrefs, writeListPrefs } from './listPrefs';
import type { ListPrefs } from './listPrefs';

// A picker (the sample picker over the process map) keeps its own settings and its own open/closed, under `<slug>.pick`,
// so choosing columns there does not change the list page. `key` is what they are stored under (listPrefsKey).
export function useViewPrefs(def: IndexDef, pick = false) {
	const key = pick ? `${def.slug}.pick` : def.slug;
	const prefs = reactive<ListPrefs>(readListPrefs(key, def));
	watch(prefs, () => writeListPrefs(key, prefs));
	// The table and the cards show the columns the person chose; what can be sorted by stays the def's own.
	const viewDef = computed<IndexDef>(() => ({ ...def, columns: shownColumns(def, prefs.columns) }));

	// Put `grid` on the page's grid: `gridWidth` is its width once it is drawn (null before).
	const grid = ref<HTMLElement | null>(null);
	const gridWidth = ref<number | null>(null);
	watch(grid, (el) => { if (el && gridWidth.value === null) gridWidth.value = el.clientWidth || window.innerWidth; }, { flush: 'post' });
	return { prefs, key, viewDef, grid, gridWidth };
}
