import { computed, watch } from 'vue';
import type { Ref } from 'vue';
import { pickText, pickedRows, rootElement } from './pickMode';
import type { PickNouns, PickedRow } from './pickMode';
import type { useRowSelection } from './useRowSelection';

type Row = Record<string, unknown>;

// The state of picker mode over the page's row ticking (useRowSelection): rows already on the canvas ("taken")
// cannot be ticked, the confirm button says how many, and confirming hands the rows back and starts over. Rows
// ticked on an earlier page are remembered by their code, so they come back named even though they are no longer on screen.
export function usePickMode(o: {
	sel: ReturnType<typeof useRowSelection>;
	rows: Ref<Row[]>;
	rowKey: (row: Row) => string;
	rowLabel: (row: Row) => string;
	/** The page's root: a DOM element, or a component whose `$el` is one. */
	root: Ref<unknown>;
	taken: () => readonly string[];
	nouns: PickNouns;
	emit: (rows: PickedRow[]) => void;
}) {
	const labels = new Map<string, string>();
	const takenSet = computed(() => new Set(o.taken()));
	const isTaken = (row: Row): boolean => takenSet.value.has(o.rowKey(row));

	// A tick can only be made on a row that is on screen, so this sees every row before it is ticked away from view.
	watch(
		[o.sel.picked, o.rows],
		() => {
			for (const r of o.rows.value) if (o.sel.isPicked(r)) labels.set(o.rowKey(r), o.rowLabel(r));
		},
		{ immediate: true, flush: 'sync' },
	);

	const keys = computed(() => o.sel.picked.value.filter((k) => !takenSet.value.has(k)));
	const count = computed(() => keys.value.length);
	const text = computed(() => pickText(count.value, o.nouns));

	function toggle(row: Row): void {
		if (!isTaken(row)) o.sel.toggle(row);
	}
	function confirm(): void {
		if (!keys.value.length) return;
		const rows = pickedRows(keys.value, labels, rootElement(o.root.value));
		o.sel.picked.value = [];
		labels.clear();
		o.emit(rows);
	}
	return { isTaken, toggle, count, text, confirm };
}
