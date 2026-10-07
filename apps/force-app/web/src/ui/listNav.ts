// Keyboard navigation for the typeahead dropdowns (LookupField, CutPicker). Before this, Enter
// always took the FIRST match and nothing further down the list was reachable without a mouse.
// Arrow keys move a highlight; Enter picks the highlighted item, or the first when none is.
// Disabled items (already picked elsewhere, see pickList.ts) are skipped by both.
import { nextTick, ref, type Ref } from 'vue';

export function useListNav<T>(
	items: () => readonly T[],
	pick: (item: T) => void,
	// The menu element, to keep the highlighted option scrolled into view. Options mark the
	// highlight with data-active="true" (aria-selected is the picked/current value, not this).
	menu?: Ref<HTMLElement | null>,
	isDisabled: (item: T) => boolean = () => false,
) {
	const active = ref(-1);

	function move(delta: 1 | -1) {
		const list = items();
		const n = list.length;
		const enabled = (i: number) => !isDisabled(list[i]);
		if (!n || !list.some((_, i) => enabled(i))) { active.value = -1; return; }
		let i = active.value < 0 ? (delta > 0 ? -1 : n) : active.value;
		// Step to the next enabled item in that direction; stay put at the end of the list.
		for (let j = i + delta; j >= 0 && j < n; j += delta) {
			if (enabled(j)) { i = j; break; }
		}
		if (i < 0 || i >= n || !enabled(i)) return;
		active.value = i;
		void nextTick(() => menu?.value?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }));
	}

	/** Picks the highlighted item (or the first enabled one); returns whether anything was picked. */
	function pickActive(): boolean {
		const list = items();
		const hi = active.value >= 0 && active.value < list.length ? list[active.value] : undefined;
		const item = hi !== undefined && !isDisabled(hi) ? hi : list.find((it) => !isDisabled(it));
		if (item === undefined) return false;
		pick(item);
		return true;
	}

	// New results: the old index points at a different item now.
	function reset() { active.value = -1; }

	return { active, move, pickActive, reset };
}
