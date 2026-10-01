// Keyboard navigation for the typeahead dropdowns (LookupField, CutPicker). Before this, Enter
// always took the FIRST match and nothing further down the list was reachable without a mouse.
// Arrow keys move a highlight; Enter picks the highlighted item, or the first when none is.
import { nextTick, ref, type Ref } from 'vue';

export function useListNav<T>(
	items: () => readonly T[],
	pick: (item: T) => void,
	// The menu element, to keep the highlighted option scrolled into view.
	menu?: Ref<HTMLElement | null>,
) {
	const active = ref(-1);

	function move(delta: 1 | -1) {
		const n = items().length;
		if (!n) { active.value = -1; return; }
		active.value = active.value < 0
			? (delta > 0 ? 0 : n - 1)
			: Math.min(n - 1, Math.max(0, active.value + delta));
		void nextTick(() => menu?.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
	}

	/** Picks the highlighted item (or the first); returns whether anything was picked. */
	function pickActive(): boolean {
		const list = items();
		const item = list[active.value >= 0 && active.value < list.length ? active.value : 0];
		if (item === undefined) return false;
		pick(item);
		return true;
	}

	// New results: the old index points at a different item now.
	function reset() { active.value = -1; }

	return { active, move, pickActive, reset };
}
