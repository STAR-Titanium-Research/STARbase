// What the Process map's node and wire components call and read (spec D15-D17), supplied by the page
// through provide/inject so the components stay presentational and testable.
//
// - MAP_ACTIONS: the calls. Ids passed to select/expand/hover are node ids (`s:<id>`, a container's
//   group id, `j:...`), a slot's record key (refKey(slot.ref), `<collection>:<id>`), or a wire id
//   (`<from>><to>`, only from WireEdge's hover) or a socket id (`<nodeId>:in:<i>`, from a socket's
//   hover); the namespaces do not collide.
// - MAP_VIEW: the page's view state the components draw from. `direction` is how the page lays out
//   (handles go Left/Right for RIGHT, Top/Bottom for DOWN; in a container the dots stay inside their
//   row and only the Position, i.e. the way the wire leaves, changes). `moreOpen` holds the container
//   ids whose "+N more from the form" is open (the page flips it in toggleMore). `selectedRef` is the
//   refKey of the record selected in the rail, so an Inside slot can show it as focal.
//   `hiddenSides` is which side of a node has records the person may not read (spec D21), from the
//   graph's hidden markers; a node draws the "some records hidden" pill there.
//   `socketLabel` names what a socket connects, for screen readers.
//   `expanded` is which cards and tray records were opened with ＋: their button is − and calls `collapse`.
//   A missing provide falls back to RIGHT / nothing open / nothing selected / nothing hidden.

import { computed, inject, ref, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import { isKeyboardFocus } from '../keyboard';
import type { SocketRef } from '../edit/socketRefs';
import { encodeSocket } from '../edit/socketRefs';
import type { Dir } from '../model/elkInput';
import type { MapNode, Ref as RecordRef } from '../model/types';

export interface MapActions {
	select(id: string, opts?: { centre?: boolean }): void;
	expand(id: string): void;
	hover(id: string | null, el?: HTMLElement): void;
	toggleRows(id: string): void;
	toggleMore(id: string): void;
	/** − on a card or a record that ＋ opened: takes away what that ＋ added. */
	collapse?(id: string): void;
	/** "Unstack" on a stack of passes, or a double-click on it: draws each pass as its own card. */
	unstack?(id: string): void;
	/** A double-click on a pass of an unstacked stack: the whole stack stacks again. */
	restack?(id: string): void;
}

export interface MapView {
	direction: Ref<Dir>;
	moreOpen: Ref<ReadonlySet<string>>;
	selectedRef: Ref<string | null>;
	hiddenSides?: Ref<ReadonlyMap<string, ReadonlySet<'in' | 'out'>>>;
	/** What a socket connects, for its aria-label (spec D23): "Input: S-0412-A · Sample". The page builds it from the wires. */
	socketLabel?: (socket: string, side: 'in' | 'out') => string;
	/** Ids (node ids, and `<collection>:<id>` of records in a tray) whose ＋ is open: they draw − instead. */
	expanded?: Ref<ReadonlySet<string>>;
}

/**
 * What the cards need of edit mode (spec §7.2), provided by the page only while a draft can be changed: free sockets become
 * buttons (click, Enter or a drag from them), a dragged wire marks the socket it would land on, a card shows the number of
 * things its checks block Create on, and a new operation offers "＋ output".
 */
export interface MapEdit {
	/** The draft can be changed: the cards draw their edit controls. */
	editing: Ref<boolean>;
	/** The socket a dragged wire is over, and whether it would fit: the card draws it green or red. `sock` is `encodeSocket`. */
	drop: Ref<{ sock: string; ok: boolean } | null>;
	/** A pointer went down on a socket: a click opens the Add menu there, a drag draws a wire. */
	socketDown(sock: SocketRef, e: PointerEvent): void;
	/** A key on a focused socket: Enter opens its menu. */
	socketKey(sock: SocketRef, e: KeyboardEvent): void;
	/** The checks that block Create on this card (a red badge), null when none. */
	badge(node: MapNode): { count: number; text: string } | null;
	/** ＋ output on a new operation: one more output row (E9). Whether the card offers it: `canAddRow`. */
	addRow(nodeId: string): void;
	canAddRow(node: MapNode): boolean;
}

export const MAP_ACTIONS: InjectionKey<MapActions> = Symbol('mapActions');
export const MAP_VIEW: InjectionKey<MapView> = Symbol('mapView');
export const MAP_EDIT: InjectionKey<MapEdit> = Symbol('mapEdit');

/** The edit controls of the page above, or null where there are none (view mode, a card drawn on its own). */
export const useMapEdit = (): MapEdit | null => inject(MAP_EDIT, null);

/** The id of a record in the map's actions: `<collection>:<id>`. */
export const refKey = (r: Pick<RecordRef, 'collection' | 'id'>): string => `${r.collection}:${r.id}`;

const NOOP: MapActions = { select() {}, expand() {}, hover() {}, toggleRows() {}, toggleMore() {} };

export const useMapActions = (): MapActions => inject(MAP_ACTIONS, NOOP);

export function useMapView(): MapView {
	return inject(MAP_VIEW, () => ({ direction: ref<Dir>('RIGHT'), moreOpen: ref<ReadonlySet<string>>(new Set()), selectedRef: ref<string | null>(null) }), true);
}

/** The sides of node `id` that have records the person may not read. */
export function useHiddenSides(id: () => string): ComputedRef<('in' | 'out')[]> {
	const view = useMapView();
	return computed(() => [...(view.hiddenSides?.value.get(id()) ?? [])]);
}

// ---- event handlers ------------------------------------------------------------------------------
// What the components bind to their elements, kept as plain functions so the click / hover wiring is
// tested without a DOM. They take getters so a node component reused for new props stays correct.
// Anything that sits inside a card stops the click so it does not also select the card.

type Ev = { stopPropagation(): void; currentTarget: unknown; ctrlKey?: boolean; metaKey?: boolean };
type Key = Pick<RecordRef, 'collection' | 'id'>;

/** A handler that stops the event, then runs `fn`. */
export const stopping = (fn: () => void) => (e: Pick<Ev, 'stopPropagation'>) => {
	e.stopPropagation();
	fn();
};

type KeyEv = { key: string; preventDefault(): void; stopPropagation(): void };

/**
 * The keydown of an element that is a button by role (`role="button"` on a div or span): Enter and Space act, as a real
 * button's do, and Space must not also scroll the page. Stops the event like a click handler of the card does.
 */
export const activating = (fn: () => void) => (e: KeyEv) => {
	if (e.key !== 'Enter' && e.key !== ' ') return;
	e.preventDefault();
	e.stopPropagation();
	fn();
};

/** What a double-click on a card's body does to its stack: a stack unstacks, a pass of an unstacked stack stacks again, any other card nothing. */
export type StackDblclick = 'unstack' | 'restack' | null;
/** What inside a card a double-click leaves alone: buttons, sockets, and the form's slots (links, inputs). */
const DBLCLICK_IGNORES = 'button, [role="button"], .sock, .slots, a, input, select, textarea';

/**
 * A card (node): body click selects it, hover reports it, the ＋ button expands it (− collapses it once open). `stack` says what a double-click
 * on the body does (see StackDblclick); the click that began it has already selected the card, and the canvas does not zoom on it.
 */
export const cardHandlers = (a: MapActions, id: () => string, open: () => boolean = () => false, stack: () => StackDblclick = () => null) => ({
	select: () => a.select(id()),
	enter: (e: Pick<Ev, 'currentTarget'>) => a.hover(id(), e.currentTarget as HTMLElement),
	leave: () => a.hover(null),
	expand: stopping(() => (open() && a.collapse ? a.collapse(id()) : a.expand(id()))),
	dblclick: (e: { target: unknown }) => {
		const what = stack();
		if (!what || (e.target as Element | null)?.closest?.(DBLCLICK_IGNORES)) return;
		a[what]?.(id());
	},
});

/** Whether the ＋ of card or record `id` is open (it draws −). */
export function useExpanded(id: () => string): ComputedRef<boolean> {
	const view = useMapView();
	return computed(() => !!view.expanded?.value.has(id()));
}

/** A record shown inside a card (an Inside slot value): hover and click act on that record. */
export const recordHandlers = (a: MapActions, r: () => Key) => ({
	enter: (e: Pick<Ev, 'currentTarget'>) => a.hover(refKey(r()), e.currentTarget as HTMLElement),
	leave: () => a.hover(null),
	select: stopping(() => a.select(refKey(r()))),
	key: activating(() => a.select(refKey(r()))),
});

/** A wire's hit path: hover reports the wire; Ctrl/⌘+click selects and centres its origin. */
export const wireHandlers = (a: MapActions, wire: () => { id: string; origin: string }) => ({
	enter: (e: Pick<Ev, 'currentTarget'>) => a.hover(wire().id, e.currentTarget as HTMLElement),
	leave: () => a.hover(null),
	click: (e: Ev) => {
		if (!(e.ctrlKey || e.metaKey)) return;
		e.stopPropagation();
		a.select(wire().origin, { centre: true });
	},
});

/** Sockets whose keyboard focus is on the hover stack, so a blur pops exactly what its focus pushed. */
const focusHeld = new WeakSet<object>();

/**
 * A socket (Handle): hover or keyboard focus reports it, so the page can list the wires on it. A
 * pointer click also focuses the socket; that is not a second hover (mouseenter already pushed it and
 * mouseleave pops once), so only `:focus-visible` focus counts, and blur pops only what focus pushed.
 */
export const socketHandlers = (a: MapActions, socket: () => string) => {
	const enter = (e: Pick<Ev, 'currentTarget'>) => a.hover(socket(), e.currentTarget as HTMLElement);
	const leave = () => a.hover(null);
	const focus = (e: Pick<Ev, 'currentTarget'>) => {
		const el = e.currentTarget as object;
		if (!isKeyboardFocus(el) || focusHeld.has(el)) return;
		focusHeld.add(el);
		enter(e);
	};
	const blur = (e: Pick<Ev, 'currentTarget'>) => {
		if (focusHeld.delete(e.currentTarget as object)) leave();
	};
	return { enter, leave, focus, blur };
};

/**
 * What a socket's Handle binds (spec D23): a tab stop named for what it connects, whose hover and focus
 * both report it. `label` is the page's `socketLabel`; without one it only says which side it is.
 */
export const socketProps = (a: MapActions, socket: string, side: 'in' | 'out', label?: (socket: string, side: 'in' | 'out') => string) => {
	const h = socketHandlers(a, () => socket);
	return {
		tabindex: 0,
		role: 'group',
		'aria-label': label?.(socket, side) ?? (side === 'in' ? 'Input socket' : 'Output socket'),
		onMouseenter: h.enter,
		onMouseleave: h.leave,
		onFocus: h.focus,
		onBlur: h.blur,
	};
};

/** `socketProps` for the component in hand: `v-bind="sockProps(id, 'in')"` on a Handle. */
export function useSocketProps(): (socket: string, side: 'in' | 'out') => ReturnType<typeof socketProps> {
	const actions = useMapActions();
	const view = useMapView();
	return (socket, side) => socketProps(actions, socket, side, view.socketLabel);
}

// ---- edit mode: sockets that can be clicked and dragged ---------------------------------------------

/**
 * What a socket binds in edit mode: `data-sock` (the page finds sockets under the pointer by it), the pointer and key handlers, and
 * the classes that draw it as a button and mark it when a dragged wire is over it. Spread it next to `sockProps` on a Handle, or
 * on the button of a free socket (one with no wire, so no Handle).
 */
export const editSocketProps = (edit: MapEdit, sock: SocketRef) => {
	const key = encodeSocket(sock);
	const drop = edit.drop.value;
	return {
		'data-sock': key,
		class: { editable: true, 'drop-ok': drop?.sock === key && drop.ok, 'drop-bad': drop?.sock === key && !drop.ok },
		onPointerdown: (e: PointerEvent) => edit.socketDown(sock, e),
		onKeydown: (e: KeyboardEvent) => edit.socketKey(sock, e),
	};
};

/**
 * `bind(socket, side, ref)` for the component in hand: what a Handle binds. The map's own props, plus the edit controls when edit
 * mode is on and `ref` says which end of a wire the socket is (null for a socket nobody can build from: a stock lot's, a test's output).
 */
export function useSocketBinder(): (socket: string, side: 'in' | 'out', ref?: SocketRef | null) => Record<string, unknown> {
	const sockProps = useSocketProps();
	const edit = useMapEdit();
	return (socket, side, ref) => (edit?.editing.value && ref ? { ...sockProps(socket, side), ...editSocketProps(edit, ref) } : sockProps(socket, side));
}

/** The label of a free socket, for screen readers. */
export const freeSocketLabel = (side: 'in' | 'out', what: string): string => (side === 'in' ? `Free input of ${what}: click to choose what feeds it` : `Free output of ${what}: click to add what comes next`);
