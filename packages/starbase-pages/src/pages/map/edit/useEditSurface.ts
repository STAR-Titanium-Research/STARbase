// What the page puts on the canvas for edit mode, assembled: the socket interactions (useEditCanvas), the Add menu (useAddMenu),
// the sample picker's state and the keyboard (useEditKeys), and the pointer they open at. The page binds what this returns; the
// rules live in the modules it is made of.

import { computed, getCurrentInstance, onBeforeUnmount, onMounted, type Ref } from 'vue';
import type { useMapCanvas } from '../useMapCanvas';
import type { useProcessMap } from '../useProcessMap';
import { useAddMenu } from './useAddMenu';
import { useEditCanvas } from './useEditCanvas';
import { useEditKeys } from './useEditKeys';
import { useSamplePicking } from './useSamplePicking';
import type { EditMode } from './useEditMode';

type Canvas = ReturnType<typeof useMapCanvas>;
type ProcessMap = ReturnType<typeof useProcessMap>;

export function useEditSurface(o: { edit: EditMode; map: ProcessMap; canvas: Canvas; canvasEl: Ref<HTMLElement | null> }) {
	const { edit, canvasEl } = o;

	/** The sample picker over the canvas (E7) and the fly-in of what it picks. */
	const picking = useSamplePicking(o);
	const pickerOpen = picking.open;

	// ---- the pointer: where a menu opens "at the pointer" -----------------------------------------------
	let pointer = { x: 0, y: 0 };
	const track = (e: PointerEvent) => void (pointer = { x: e.clientX, y: e.clientY });
	if (getCurrentInstance()) {
		onMounted(() => window.addEventListener('pointermove', track, { passive: true }));
		onBeforeUnmount(() => window.removeEventListener('pointermove', track));
	}
	/** The pointer if it is over the canvas, else the middle of it. */
	function pointerOnCanvas(): { x: number; y: number } {
		const r = canvasEl.value?.getBoundingClientRect();
		if (!r) return pointer;
		const inside = pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
		return inside ? pointer : { x: r.left + r.width / 2, y: r.top + r.height / 3 };
	}

	// ---- the pieces ------------------------------------------------------------------------------------------
	const addMenuRef: { open: (t: Parameters<ReturnType<typeof useAddMenu>['open']>[0]) => void } = { open: () => undefined };
	const build = useEditCanvas({ ...o, openMenu: (t) => addMenuRef.open(t) });
	const menu = useAddMenu({
		edit,
		canvas: o.canvas,
		canvasEl,
		ensureSample: build.ensureSample,
		pickSamples: () => void (pickerOpen.value = true),
	});
	addMenuRef.open = menu.open;

	/** Shift+A, the lid's Add and a right click on empty canvas: the menu with nothing to connect to. */
	const addUnconnected = (at: { x: number; y: number } = pointerOnCanvas()) => menu.open({ sock: null, at });
	const blocked = computed(() => !!menu.target.value || pickerOpen.value);
	useEditKeys({ editing: () => edit.editing.value, blocked: () => blocked.value, pointer: pointerOnCanvas, add: addUnconnected });

	/** A right click on empty canvas opens the menu there (E8); on a card or a control it keeps its own meaning. */
	function onContextMenu(e: MouseEvent): boolean {
		if (!edit.editing.value) return false;
		const target = e.target as HTMLElement | null;
		if (!target || target.closest('.vue-flow__node, .vue-flow__controls, .vue-flow__minimap, .vue-flow__edge, .pm-wirepreview')) return false;
		e.preventDefault();
		addUnconnected({ x: e.clientX, y: e.clientY });
		return true;
	}

	return { ...build, menu, picking, pickerOpen, undo: picking.undo, redo: picking.redo, addUnconnected, onContextMenu, blocked };
}

export type EditSurface = ReturnType<typeof useEditSurface>;
