import { computed, ref } from 'vue';
import type { Ref } from 'vue';
import type { IndexDef } from './indexConfig';
import { SELECT_MAX, selectionRoute } from './indexView';

type Row = Record<string, unknown>;

// Ticked rows of a list (every index page ticks, for the With-selected menu). The ticks are kept across pages,
// filters and views, in the order ticked, up to SELECT_MAX; the def's selectAction (samples: Print labels) takes
// them to the route the def names; a bulk action reads them and, once done, leaves only the rows it skipped ticked.
export function useRowSelection(
	def: IndexDef,
	rows: Ref<Row[]>,
	rowKey: (row: Row) => string,
	navigate: (to: string) => void,
) {
	const picked = ref<string[]>([]);
	const isPicked = (row: Row): boolean => picked.value.includes(rowKey(row));
	const full = computed(() => picked.value.length >= SELECT_MAX);
	const allPicked = computed(() => rows.value.length > 0 && rows.value.every(isPicked));
	function toggle(row: Row): void {
		const k = rowKey(row);
		if (picked.value.includes(k)) picked.value = picked.value.filter((x) => x !== k);
		else if (!full.value) picked.value = [...picked.value, k];
	}
	function togglePage(): void {
		const keys = rows.value.map(rowKey);
		picked.value = allPicked.value
			? picked.value.filter((k) => !keys.includes(k))
			: [...picked.value, ...keys.filter((k) => !picked.value.includes(k))].slice(0, SELECT_MAX);
	}
	function run(): void {
		if (def.selectAction && picked.value.length) navigate(selectionRoute(def.selectAction, picked.value));
	}
	// After a bulk action: tick exactly these keys (the rows it skipped), nothing else.
	function keepOnly(keys: readonly string[]): void {
		picked.value = keys.slice(0, SELECT_MAX);
	}
	return { picked, isPicked, full, allPicked, toggle, togglePage, run, keepOnly };
}
