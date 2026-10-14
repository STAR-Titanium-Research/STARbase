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
//   A missing provide falls back to RIGHT / nothing open / nothing selected / nothing hidden.

import { computed, inject, ref, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import type { Dir } from '../model/elkInput';
import type { Ref as RecordRef } from '../model/types';

export interface MapActions {
	select(id: string, opts?: { centre?: boolean }): void;
	expand(id: string): void;
	hover(id: string | null, el?: HTMLElement): void;
	toggleRows(id: string): void;
	toggleMore(id: string): void;
}

export interface MapView {
	direction: Ref<Dir>;
	moreOpen: Ref<ReadonlySet<string>>;
	selectedRef: Ref<string | null>;
	hiddenSides?: Ref<ReadonlyMap<string, ReadonlySet<'in' | 'out'>>>;
	/** What a socket connects, for its aria-label (spec D23): "Input: S-0412-A · Sample". The page builds it from the wires. */
	socketLabel?: (socket: string, side: 'in' | 'out') => string;
}

export const MAP_ACTIONS: InjectionKey<MapActions> = Symbol('mapActions');
export const MAP_VIEW: InjectionKey<MapView> = Symbol('mapView');

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

/** A card (node): body click selects it, hover reports it, the ＋ button expands it. */
export const cardHandlers = (a: MapActions, id: () => string) => ({
	select: () => a.select(id()),
	enter: (e: Pick<Ev, 'currentTarget'>) => a.hover(id(), e.currentTarget as HTMLElement),
	leave: () => a.hover(null),
	expand: stopping(() => a.expand(id())),
});

/** A record shown inside a card (an Inside slot value): hover and click act on that record. */
export const recordHandlers = (a: MapActions, r: () => Key) => ({
	enter: (e: Pick<Ev, 'currentTarget'>) => a.hover(refKey(r()), e.currentTarget as HTMLElement),
	leave: () => a.hover(null),
	select: stopping(() => a.select(refKey(r()))),
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

/** A socket (Handle): hover or focus reports it, so the page can list the wires on it. */
export const socketHandlers = (a: MapActions, socket: () => string) => {
	const enter = (e: Pick<Ev, 'currentTarget'>) => a.hover(socket(), e.currentTarget as HTMLElement);
	const leave = () => a.hover(null);
	return { enter, leave, focus: enter, blur: leave };
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
