// What the page puts on the canvas for edit mode, assembled: the socket interactions (useEditCanvas), the add search (useAddMenu) and the palette
// with its drags (usePalette, useAddDrag), insert before / after and a drop on a wire (useEditInsert), "Connect to…", the sample picker and its
// fly-in (useSamplePicking), the keyboard (useEditKeys) with what its keys do to the selected card or wire (remove and dissolve in
// useEditRemoval; duplicate, ×N here), and the pointer they open at. The page binds what this returns; the rules live in the modules it is
// made of.

import { computed, getCurrentInstance, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, type Ref } from 'vue';
import type { DraftItem, DraftKey } from '@d1/ui';
import type { MapNode } from '../model/types';
import type { MapEdit } from '../nodes/actions';
import type { useMapCanvas } from '../useMapCanvas';
import type { useProcessMap } from '../useProcessMap';
import { isKeyboardFocus } from '../keyboard';
import { collectionOf, recordKey } from './checks';
import { writableValues } from './catalog';
import { newKeys } from './draft';
import { connectTargets, type ConnectEntry, type ConnectNames } from './connectModel';
import { sampleLabel, type MenuChoice, type MenuEntry } from './menuModel';
import { draftKeysOfNode } from './socketRefs';
import type { MenuTarget } from './menuTarget';
import { recordedSocketReason } from './addDrop';
import { autoWireSource, isRepeatAdd } from './addFollowUp';
import { dropVerdict } from './wireDrop';
import { resolveEnd, type SocketRef } from './socketRefs';
import { useAddDrag } from './useAddDrag';
import { useAddMenu } from './useAddMenu';
import { useAttachPicking } from './useAttachPicking';
import { useEditCanvas } from './useEditCanvas';
import type { EditMode } from './useEditMode';
import { useEditInsert } from './useEditInsert';
import { useEditKeys } from './useEditKeys';
import { useEditRemoval } from './useEditRemoval';
import { draftId } from './toGraph';
import { usePalette } from './usePalette';
import { useTemplateUi } from './useTemplateUi';
import type { Templates } from './useTemplates';
import { useSamplePicking } from './useSamplePicking';
import { workChipOf } from './workChip';

type Canvas = ReturnType<typeof useMapCanvas>;
type ProcessMap = ReturnType<typeof useProcessMap>;

export function useEditSurface(o: { edit: EditMode; /** The templates this person may use (R7). */ templates: Templates; map: ProcessMap; canvas: Canvas; canvasEl: Ref<HTMLElement | null>; /** Something else the page has open over the map (the Mark done dialog, the Finder): the keys leave it alone. */ blockedBy?: () => boolean; /** Who is building: the palette's folded state and the recents are theirs. */ person?: () => string | null | undefined }) {
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
	const late: { menu: (t: MenuTarget) => void; connect: (t: MenuTarget) => void; attach: (t: MenuTarget) => void; dropWire: (s: SocketRef, socketId: string) => boolean; insert: (t: MenuTarget, c: MenuChoice) => Promise<DraftKey[] | boolean | void> | DraftKey[] | boolean | void } = { menu: () => undefined, connect: () => undefined, attach: () => undefined, dropWire: () => false, insert: () => undefined };
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
		attach: (t) => late.attach(t),
		person: o.person,
		insert: (t, c) => late.insert(t, c),
	});
	late.menu = menu.open;
	// "From database…": the picker of recorded operations with no input sample (R8); what it picks comes back through the menu's applyAt.
	const attaching = useAttachPicking({ edit, map: o.map, applyAt: menu.applyAt });
	late.attach = attaching.open;
	/** What the picker says it is for: the sample whose output it was opened on, else the canvas. */
	const attachHeading = computed(() => {
		const sock = attaching.target.value?.sock;
		const node = sock?.kind === 'sample' ? o.map.graph.value?.nodes.find((n) => n.id === `s:${sock.id}`) : undefined;
		return node?.type === 'record' ? `Attach to ${node.ref.code || 'this sample'}` : 'Add to the canvas';
	});

	// ---- insert before / after, a drop on a wire, and the palette (R1, R2, R3) ---------------------------------------
	const nameOf = (n: MapNode): string => (n.type === 'record' ? n.ref.code || 'this sample' : n.type === 'container' ? n.title || n.method || 'this step' : 'this card');
	const insert = useEditInsert({ edit, map: o.map, canvasEl, sampleActions: build.sampleActions, open: menu.open, nameOf, say: (text, at) => (at ? build.say(text, at) : void (build.problem.value = text)) });
	late.insert = insert.choose;
	const palette = usePalette({ methods: () => edit.catalog.methods.value, testTypes: () => edit.catalog.testTypes.value, templates: () => o.templates.items.value, recents: menu.recents, person: () => o.person?.() });
	// Save as template, and what the palette does to a template (R7).
	const templateUi = useTemplateUi({ edit, templates: o.templates, map: o.map, openPalette: () => palette.fold(false) });
	/** A drop on the canvas or a socket: it keeps the target the pointer chose (no auto-wire), then shows what it added like any other add (K10). */
	async function dropAt(t: MenuTarget, choice: MenuChoice): Promise<DraftKey[]> {
		const keys = await menu.applyAt(t, choice);
		showNew(keys);
		return keys;
	}
	/** A drop on a wire puts the card between its ends; it is shown as well. */
	function dropOnWire(wireId: string, choice: MenuChoice, flow: { x: number; y: number } | undefined, at: { x: number; y: number }): boolean {
		const before = edit.body.value;
		const done = insert.dropOnWire(wireId, choice, flow, at);
		if (done) showNew(newKeys(before, edit.body.value));
		return done;
	}
	const dragging = useAddDrag({
		body: () => edit.body.value,
		editing: () => edit.editing.value,
		canvas: o.canvas,
		canvasEl,
		drop: build.mapEdit.drop,
		applyAt: dropAt,
		wireVerdict: insert.wireVerdict,
		dropOnWire,
		whyNot: (s) => recordedSocketReason(o.map.graph.value, s),
		say: build.say,
	});
	/** What the palette draws and does, for the page to bind in one go. */
	const paletteProps = computed(() => ({ entries: palette.entries.value, grouped: palette.grouped.value, folded: palette.folded.value, drag: dragging.drag.value, consumeClick: dragging.consumeClick, ...templateUi.paletteProps.value }));
	const paletteEvents = { toggle: () => palette.toggle(), add: (e: MenuEntry) => paletteAdd(e), drag: dragging.start, ...templateUi.paletteEvents };
	/** The entry the last palette add was for, and when: a second click on it a moment later is the same click. */
	let lastAdd: { id: string; at: number } | null = null;
	/**
	 * Enter or a click on a palette entry (no dragging needed): "Existing sample…" opens the picker; anything else is added next to the selected card,
	 * else at the middle of the canvas, and the layout keeps it clear of every other card. An operation or a test is wired to the sample just added.
	 */
	function paletteAdd(entry: MenuEntry): void {
		if (!edit.editing.value || entry.disabled) return;
		if (entry.choice.kind === 'pickSamples') return void (pickerOpen.value = true);
		const now = Date.now();
		if (isRepeatAdd(lastAdd, entry.id, now)) return;
		const anchor = o.map.selectedId.value ?? undefined;
		const r = canvasEl.value?.getBoundingClientRect();
		const at = r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 };
		// Only an add that added something is "the click": a refused one must not swallow a retry.
		void addAt({ sock: null, at, ...(anchor ? { anchor } : { flow: o.canvas.toFlow(at.x, at.y) }) }, entry.choice).then((keys) => {
			if (keys.length) lastAdd = { id: entry.id, at: now };
		});
	}

	/**
	 * Adds a choice at a target, then shows what it added (and gives its keys). With nothing to connect to, an operation or a test takes the sample
	 * just added as its input (the same step as dropping it on that sample's output), so a click is enough to build a chain.
	 */
	async function addAt(t: MenuTarget, choice: MenuChoice): Promise<DraftKey[]> {
		// A card selected that is not in the draft (one of the history) means the person is somewhere else: nothing is wired (K11).
		const elsewhere = !edit.selectedKey.value && !!o.map.selectedId.value;
		const from = !t.sock && !t.insert && !elsewhere ? autoWireSource(edit.body.value, edit.selectedKey.value, choice) : null;
		const target: MenuTarget = from ? { at: t.at, sock: { kind: 'sample', id: draftId(from), side: 'out' }, anchor: `s:${draftId(from)}` } : t;
		const keys = await menu.applyAt(target, choice);
		showNew(keys);
		return keys;
	}
	/** The search's choice: the same as a click on the palette. */
	async function chooseFromSearch(choice: MenuChoice): Promise<void> {
		const t = menu.target.value;
		if (!t) return;
		menu.close();
		await addAt(t, choice);
	}
	/** The card a draft key is drawn as (a stack of passes is one card). */
	const nodeOfKey = (key: DraftKey): MapNode | undefined => o.map.graph.value?.nodes.find((n) => draftKeysOfNode(edit.body.value, n).includes(key));
	/**
	 * What a person adding something sees: the new card is selected (no centring: the canvas pans only when it is not wholly in view), and the
	 * first thing to fill in has the keyboard, so they can type at once.
	 */
	function showNew(keys: DraftKey[]): void {
		// An insert or a drop on a wire can add a sample with the operation: the operation is the card with something to choose.
		const lead = keys.find((k) => edit.body.value.items.find((i) => i.key === k)?.kind !== 'sample') ?? keys[0];
		const node = lead ? nodeOfKey(lead) : undefined;
		if (!node) return;
		o.map.select(node.id);
		// The layout makes room round the new card first: the canvas is asked to show it once that has settled.
		void o.canvas.whenSettled().then(() => o.canvas.reveal(node.id));
		void focusNewCard(node.id);
	}
	/** Puts the keyboard on the new card's kind choice, else its first empty field; nothing when the card has neither (yet). */
	async function focusNewCard(id: string): Promise<void> {
		await nextTick();
		const card = [...(canvasEl.value?.querySelectorAll<HTMLElement>('.vue-flow__node') ?? [])].find((el) => el.dataset.id === id);
		const field = card?.querySelector<HTMLElement>('[data-kind-select]') ?? [...(card?.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field] input, [data-field] select') ?? [])].find((el) => !el.value);
		field?.focus({ preventScroll: true });
	}

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
		const node = nodeOfKey(key);
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

	/** The card a person on the keyboard has focus on (a Tab stop of the canvas), else null: the add search opens there, not at a pointer that has not moved. */
	function focusedCard(): { el: HTMLElement; id: string | undefined } | null {
		const el = document.activeElement as HTMLElement | null;
		const card = el?.closest?.('.vue-flow__node') as HTMLElement | null;
		return el && card && canvasEl.value?.contains(card) && isKeyboardFocus(el) ? { el: card, id: card.dataset.id } : null;
	}
	/** Shift+A, Ctrl/⌘+K, the lid's Add and a right click on empty canvas: the add search with nothing to connect to. */
	const addUnconnected = (at?: { x: number; y: number }, anchor?: string) => {
		const focus = at ? null : focusedCard();
		if (focus) {
			const r = focus.el.getBoundingClientRect();
			return menu.open({ sock: null, at: { x: r.right + 24, y: r.top }, anchor: focus.id });
		}
		menu.open({ sock: null, at: at ?? pointerOnCanvas(), ...(anchor ? { anchor } : {}) });
	};
	const blocked = computed(() => !!menu.target.value || !!attaching.target.value || !!connecting.value || !!duplicating.value || pickerOpen.value || !!templateUi.saving.value || !!o.blockedBy?.());
	useEditKeys({
		editing: () => edit.editing.value,
		blocked: () => blocked.value,
		pointer: pointerOnCanvas,
		// A person on the keyboard (focus on a card) gets the search there; the pointer has not moved to say anything.
		add: (at) => addUnconnected(focusedCard() ? undefined : at),
		insert: (where) => insert.openFor(where),
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
		mapEdit: { ...build.mapEdit, selectedWire: removal.selectedWire, selectWire: removal.selectWire, lockOf: removal.lockOf, wireLock: removal.wireLock, dropWire: dragging.dropWire, work: (node) => workChipOf(edit, node) } as MapEdit,
		menu: { ...menu, choose: chooseFromSearch },
		attaching,
		attachHeading,
		palette,
		templateUi,
		templates: o.templates,
		paletteProps,
		paletteEvents,
		dragging,
		paletteAdd,
		insertSelected: insert.openFor,
		canInsertSelected: () => insert.canInsert(insert.selected()),
		selectedInsertBeforeRefusal: () => insert.beforeRefusal(insert.selected()),
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
