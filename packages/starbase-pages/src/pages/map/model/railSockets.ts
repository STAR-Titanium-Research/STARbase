// The sockets on a container's rail, as a model the card draws from (spec D4, D8; edit mode E8, E9): which socket ids each side has, in
// the order they are stacked, and which row of the container each one belongs to. The rail itself says no such thing (the wires and
// the sample cards say which sample is which), but edit mode needs it: a click or a drop on a socket must reach the draft row it is.
//
// A socket id is drawn once (a cut's shared input once); the folded rows' bundle sockets come last, fat. A row with nothing wired on a
// side has no socket id. Sockets are derived (R5, nothing about them is kept in the draft): in edit mode a side shows a socket for each
// wire and ONE free one, a button, while the card is selected or has nothing wired on that side. The free one stands for the first row
// with no wire there; when every row has one, for a row the connection adds (an output piece, or one more sample in a batch). A test
// takes samples in but nothing comes out of it.

import type { ContainerNode } from './types';
import { isBundleSocket } from './sockets';

/** Rows drawn on their own sockets when a container is folded. */
export const SHOWN_WHEN_FOLDED = 2;

export type RailSide = 'in' | 'out';

export interface RailSocketModel {
	/** The socket id of the wire, or `free:<side>:<recordId>` for a free socket. */
	id: string;
	/** A folded bundle's socket: drawn fat. */
	fat: boolean;
	/** The row (its record id) this socket is the `side` of; null for a folded bundle, which stands for several. */
	recordId: string | null;
	/** Index of that row in the container's rows; -1 for a bundle. */
	row: number;
	/** Nothing is wired here: edit mode draws a button instead of a Handle. */
	free: boolean;
	/** A free socket for a row that does not exist yet: connecting to it adds the row (`recordId` is the last row's). */
	add?: true;
}

/** Whether this container's `side` can take a wire in edit mode at all (a test has no output). */
const wirable = (node: ContainerNode, side: RailSide): boolean => !(node.kind === 'test' && side === 'out');

/** A container whose rows can grow by a connection: a new operation (a draft of its own), one row per record, not a deck of passes. */
const growable = (node: ContainerNode): boolean => node.kind === 'operation' && !!node.draft && !node.stacked && !node.collapsed;

/** The one free socket of a side, or null when there is nothing a connection there could mean. */
function freeSocket(node: ContainerNode, side: RailSide, shown: ContainerNode['rows'], lacks: (r: ContainerNode['rows'][number]) => boolean): RailSocketModel | null {
	const row = shown.findIndex(lacks);
	if (row >= 0) return { id: `free:${side}:${shown[row].recordId}`, fat: false, recordId: shown[row].recordId, row, free: true };
	const last = shown[shown.length - 1];
	if (!last) return null;
	// Every row has a wire here. A test takes any number of samples in; a new operation takes another row; nothing else grows.
	if (node.kind === 'test') return side === 'in' ? { id: `free:in:${shown[0].recordId}`, fat: false, recordId: shown[0].recordId, row: 0, free: true } : null;
	if (growable(node)) return { id: `free:${side}:+`, fat: false, recordId: last.recordId, row: shown.length, free: true, add: true };
	return null;
}

/**
 * One side's sockets, in row order, each id once; the bundle socket (if any) after them, then (edit mode only) the free one: shown
 * while the card is `selected`, or when nothing is wired on that side. `wired` is the sockets that have a wire (the graph's): the others
 * are spare, and edit mode does not draw them as sockets. Left out, every socket the model has counts as wired.
 */
export function railSockets(node: ContainerNode, side: RailSide, o: { editable?: boolean; selected?: boolean; wired?: ReadonlySet<string> } = {}): RailSocketModel[] {
	const seen = new Set<string>();
	const out: RailSocketModel[] = [];
	const shown = node.bundled ? node.rows.slice(0, SHOWN_WHEN_FOLDED) : node.rows;
	const hidden = node.bundled ? node.rows.slice(SHOWN_WHEN_FOLDED) : [];
	// In edit mode a socket nobody has wired is spare: it is not drawn as a socket of its own, the side's one free socket stands for it.
	const spare = (id: string): boolean => !!o.editable && !!o.wired && !isBundleSocket(id) && !o.wired.has(id);
	const lacks = (r: ContainerNode['rows'][number]): boolean => !r[side] || spare(r[side]!);
	shown.forEach((r, row) => {
		const id = r[side];
		if (!id || isBundleSocket(id) || seen.has(id) || spare(id)) return;
		seen.add(id);
		out.push({ id, fat: false, recordId: r.recordId, row, free: false });
	});
	const bundle = hidden.find((r) => r[side] && isBundleSocket(r[side]!))?.[side];
	if (bundle) out.push({ id: bundle, fat: true, recordId: null, row: -1, free: false });
	if (o.editable && wirable(node, side) && (o.selected || out.length === 0)) {
		const free = freeSocket(node, side, shown, lacks);
		if (free) out.push(free);
	}
	return out;
}

/**
 * The rail socket ids of a container and what each is: for the card to bind the edit controls to a Handle (null for the ones nobody can
 * build from: a folded bundle, and a test's output).
 */
export function socketOwners(node: ContainerNode): Map<string, { recordId: string; side: RailSide; row: number }> {
	const owners = new Map<string, { recordId: string; side: RailSide; row: number }>();
	for (const side of ['in', 'out'] as const) {
		if (!wirable(node, side)) continue;
		for (const s of railSockets(node, side)) if (s.recordId !== null) owners.set(s.id, { recordId: s.recordId, side, row: s.row });
	}
	return owners;
}
