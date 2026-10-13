import { computed, ref } from 'vue';
import type { ComputedRef } from 'vue';
import { dropIndex, dropResult, sameOrder } from './pinDrag';
import type { PinRef, ResolvedPin } from './sidebarModel';
import type { PinsState } from './usePins';

// Drag-and-drop of the sidebar's pins with HTML5 drag events. `drag` is the pin being dragged: a row of
// Pinned (reorder) or of a section (pin). `dropAt` is where the drop would land among the rows shown
// (0 = before the first, `rowCount` = after the last). The placement maths is in pinDrag.ts.
export function usePinDrag(o: {
	pins: PinsState;
	// Every pin that resolves (the saved list's order), not only the rows drawn.
	shown: ComputedRef<ResolvedPin[]>;
	// How many rows are drawn (the Pinned list may be cut to "Show all").
	rowCount: () => number;
	ready: () => boolean;
}) {
	const { pins } = o;
	const drag = ref<PinRef | null>(null);
	const dropAt = ref<number | null>(null);
	const pinnedBlock = ref<HTMLElement | null>(null);

	const dragIsNew = computed(() => !!drag.value && !pins.isPinned(drag.value));

	function startDrag(ref_: PinRef | null, e: DragEvent) {
		if (!ref_ || !o.ready()) {
			e.preventDefault();
			return;
		}
		drag.value = { kind: ref_.kind, target: ref_.target };
	}
	function endDrag() {
		drag.value = null;
		dropAt.value = null;
	}

	function overRow(index: number, e: DragEvent) {
		if (!drag.value) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		dropAt.value = dropIndex(index, rect.height ? (e.clientY - rect.top) / rect.height : 0);
	}
	function overBlock(e: DragEvent) {
		if (!drag.value) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		// Anywhere that is not a row (the heading, the empty list, the "Drop here to pin" zone): at the end.
		if (!(e.target as Element).closest('[data-pin-row]')) dropAt.value = o.rowCount();
	}
	function leaveBlock(e: DragEvent) {
		if (!pinnedBlock.value?.contains(e.relatedTarget as Node | null)) dropAt.value = null;
	}

	async function drop(e: DragEvent) {
		e.preventDefault();
		const item = drag.value;
		const at = dropAt.value;
		endDrag();
		if (!item || at === null || !o.ready()) return;
		const { next, pinFirst } = dropResult(pins.pins.value, o.shown.value, item, at);
		if (pinFirst) {
			await pins.toggle(item);
			// The pin failed (the list says so): there is nothing to place.
			if (!pins.isPinned(item)) return;
		}
		if (!sameOrder(next, pins.pins.value)) await pins.reorder(next);
	}

	return { drag, dropAt, dragIsNew, pinnedBlock, startDrag, endDrag, overRow, overBlock, leaveBlock, drop };
}
