// What the page puts on the canvas for edit mode, assembled: the socket interactions (useEditCanvas), the Add menu (useAddMenu),
// "Connect to…", the sample picker and its fly-in (useSamplePicking), the keyboard (useEditKeys) with what its keys do to the selected
// card or wire (remove and dissolve in useEditRemoval; duplicate, ×N here), and the pointer they open at. The page binds what this returns; the rules live in the modules
// it is made of.

import { computed, getCurrentInstance, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, type Ref } from 'vue';
import type { DraftItem } from '@d1/ui';
import type { MapEdit } from '../nodes/actions';
import type { useMapCanvas } from '../useMapCanvas';
import type { useProcessMap } from '../useProcessMap';
import { collectionOf, recordKey } from './checks';
import { writableValues } from './catalog';
import { connectTargets, type ConnectEntry, type ConnectNames } from './connectModel';
import { focusCanvas } from './focusCanvas';
import { sampleLabel } from './menuModel';
import { draftKeysOfNode } from './socketRefs';
import type { MenuTarget } from './menuTarget';
import { dropVerdict } from './wireDrop';
import { resolveEnd, type SocketRef } from './socketRefs';
import { useAddMenu } from './useAddMenu';
import { useEditCanvas } from './useEditCanvas';
import type { EditMode } from './useEditMode';
import { useEditKeys } from './useEditKeys';
import { useEditRemoval } from './useEditRemoval';
import { useSamplePicking } from './useSamplePicking';

type Canvas = ReturnType<typeof useMapCanvas>;
type ProcessMap = ReturnType<typeof useProcessMap>;

export function useEditSurface(o: { edit: EditMode; map: ProcessMap; canvas: Canvas; canvasEl: Ref<HTMLElement | null>; /** Something else the page has open over the map (the Mark done dialog, the Finder): the keys leave it alone. */ blockedBy?: () => boolean }) {
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
	const late: { menu: (t: MenuTarget) => void; connect: (t: MenuTarget) => void; dropWire: (s: SocketRef, socketId: string) => boolean } = { menu: () => undefined, connect: () => undefined, dropWire: () => false };
	const build = useEditCanvas({ ...o, openMenu: (t) => late.menu(t), openConnect: (t) => late.connect(t), dropWire: (s, id) => late.dropWire(s, id) });
	// Remove, Dissolve and wire removal (R4); what it has to say goes where the canvas says its own problems.
	const removal = useEditRemoval({ edit, map: o.map, canvasEl, say: (text) => void (build.problem.value = text) });
	late.dropWire = removal.dropWireAt;
	const menu = useAddMenu({
		edit,
		canvas: o.canvas,
		canvasEl,
		ensureSample: build.ensureSample,
		pickSamples: () => void (pickerOpen.value = true),
		connect: (t) => late.connect(t),
	});
	late.menu = menu.open;

	// ---- Connect to… (E21) -----------------------------------------------------------------------------------
	/** The socket the list is for, where it opened, and the card it is on. */
	const connecting = shallowRef<MenuTarget | null>(null);
	const names = computed<ConnectNames>(() => ({
		sample: (item) => sampleLabel(edit.body.value, item.key, (id) => edit.catalog.samples.get(id)?.code),
		operation: (item, row) => {
			const method = typeof item.values.method_id === 'string' ? edit.catalog.methodById.value.get(item.values.method_id)?.name : undefined;
			const base = method ?? 'Operation';
			return item.kind === 'operation' && item.rows.length > 1 ? `${base} (piece ${row + 1})` : base;
		},
		test: (item) => edit.catalog.testTypes.value.find((t) => t.value === item.values.test_type)?.name ?? 'Test',
	}));
	/** A socket's card called by what the lists call it. */
	function labelOf(sock: SocketRef): string {
		const end = resolveEnd(edit.body.value, sock);
		const item = end ? edit.body.value.items.find((i) => i.key === end.key) : undefined;
		if (!item) return sock.kind === 'sample' ? 'this sample' : 'this card';
		return item.kind === 'sample' ? names.value.sample(item) : item.kind === 'operation' ? names.value.operation(item, end?.row ?? 0) : names.value.test(item);
	}
	/** A card of the draft called by what the canvas calls it (Checks lists cards by it). */
	function labelForKey(key: string): string {
		const item = edit.body.value.items.find((i) => i.key === key);
		if (!item) return key;
		return item.kind === 'sample' ? names.value.sample(item) : item.kind === 'operation' ? names.value.operation(item, 0) : names.value.test(item);
	}
	/** Selects the card a draft item is drawn as, and brings it into view. */
	function selectKey(key: string): void {
		const node = o.map.graph.value?.nodes.find((n) => draftKeysOfNode(edit.body.value, n).includes(key));
		if (node) o.map.select(node.id, { centre: true });
	}
	const connectEntries = computed<ConnectEntry[]>(() => (connecting.value?.sock ? connectTargets(edit.body.value, connecting.value.sock, names.value) : []));
	/** The list opens for a socket; a sample of the loaded history is tried as if the draft held it (it joins when the wire is made). */
	late.connect = (t) => {
		if (edit.editing.value && t.sock) connecting.value = t;
	};
	async function connectTo(entry: ConnectEntry): Promise<void> {
		const t = connecting.value;
		connecting.value = null;
		if (!t?.sock) return;
		const v = dropVerdict(edit.body.value, t.sock, entry.sock);
		if (v.ok) await build.connect(v, t.anchor);
	}

	// ---- remove and duplicate the selected draft item -----------------------------------------------------------
	const duplicating = ref<{ what: string } | null>(null);
	const selectedItem = (): DraftItem | null => edit.selectedItem.value;
	const WORD = { sample: 'sample', operation: 'operation', test: 'test' } as const;

	/** Duplicate: `n` copies of the selected item (a record that exists is copied from what was read of it: that is "new from"). */
	function duplicateSelected(n = 1): boolean {
		const item = selectedItem();
		if (!item) return false;
		const loaded = item.existing ? edit.catalog.records.get(recordKey(collectionOf(item), item.existing.id))?.values : undefined;
		// Only what a new record may carry: the row read with `*` also holds short_id, code_sort, restricted and the alias arrays, which the server refuses.
		const record = loaded ? writableValues(item.kind, loaded, edit.catalog.rawFields.value[collectionOf(item)]) : undefined;
		if (item.existing && !record) {
			build.problem.value = 'That record is still being read, so it cannot be copied yet. Try again in a moment.';
			return true;
		}
		// The copies are laid out beside the card they were copied from.
		edit.apply({ type: 'duplicate', key: item.key, n, record }, { anchor: o.map.selectedId.value ?? undefined });
		return true;
	}
	/** Shift+Ctrl+D: asks how many. */
	function askDuplicate(): boolean {
		const item = selectedItem();
		if (!item) return false;
		duplicating.value = { what: `this ${WORD[item.kind]}` };
		return true;
	}
	function confirmDuplicate(n: number): void {
		duplicating.value = null;
		duplicateSelected(n);
	}

	/** Shift+A, the lid's Add and a right click on empty canvas: the menu with nothing to connect to. */
	const addUnconnected = (at: { x: number; y: number } = pointerOnCanvas()) => menu.open({ sock: null, at });
	const blocked = computed(() => !!menu.target.value || !!connecting.value || !!duplicating.value || pickerOpen.value || !!o.blockedBy?.());
	useEditKeys({
		editing: () => edit.editing.value,
		blocked: () => blocked.value,
		pointer: pointerOnCanvas,
		add: addUnconnected,
		undo: () => picking.undo(),
		redo: () => picking.redo(),
		remove: removal.removeSelected,
		dissolve: removal.dissolveSelected,
		duplicate: () => duplicateSelected(1),
		duplicateMany: askDuplicate,
	});

	/** A right click on empty canvas opens the menu there (E8); on a card or a control it keeps its own meaning. */
	function onContextMenu(e: MouseEvent): boolean {
		if (!edit.editing.value) return false;
		const target = e.target as HTMLElement | null;
		if (!target || target.closest('.vue-flow__node, .vue-flow__controls, .vue-flow__minimap, .vue-flow__edge, .pm-wirepreview')) return false;
		e.preventDefault();
		addUnconnected({ x: e.clientX, y: e.clientY });
		return true;
	}

	return {
		...build,
		/** What the cards read: the canvas's, and the wire selection and locks of removal. */
		mapEdit: { ...build.mapEdit, selectedWire: removal.selectedWire, selectWire: removal.selectWire, lockOf: removal.lockOf, wireLock: removal.wireLock } as MapEdit,
		menu,
		picking,
		pickerOpen,
		undo: picking.undo,
		redo: picking.redo,
		addUnconnected,
		onContextMenu,
		blocked,
		connecting,
		connectEntries,
		connectFrom: computed(() => (connecting.value?.sock ? labelOf(connecting.value.sock) : '')),
		connectTo,
		labelForKey,
		selectKey,
		duplicating,
		confirmDuplicate,
		removeSelected: removal.removeSelected,
		dissolveSelected: removal.dissolveSelected,
		selectedWire: removal.selectedWire,
		canRemove: removal.canRemove,
		onCanvasClick: removal.onCanvasClick,
		dropWireAt: removal.dropWireAt,
		canDissolve: removal.canDissolve,
		duplicateSelected,
	};
}

export type EditSurface = ReturnType<typeof useEditSurface>;
