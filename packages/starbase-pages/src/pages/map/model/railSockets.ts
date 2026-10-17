// The sockets on a container's rail, as a model the card draws from (spec D4, D8; edit mode E8, E9): which socket ids each side has, in
// the order they are stacked, and which row of the container each one belongs to. The rail itself says no such thing (the wires and
// the sample cards say which sample is which), but edit mode needs it: a click or a drop on a socket must reach the draft row it is.
//
// A socket id is drawn once (a cut's shared input once); the folded rows' bundle sockets come last, fat. A row with nothing wired on a
// side has no socket id, so in edit mode it gets a "free" one: a button on the rail that stands for the row. A test takes samples in
// but nothing comes out of it.

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
}

/** Whether this container's `side` can take a wire in edit mode at all (a test has no output). */
const wirable = (node: ContainerNode, side: RailSide): boolean => !(node.kind === 'test' && side === 'out');

/** One side's sockets, in row order, each id once; the bundle socket (if any) after them, then the free ones (edit mode only). */
export function railSockets(node: ContainerNode, side: RailSide, o: { editable?: boolean } = {}): RailSocketModel[] {
	const seen = new Set<string>();
	const out: RailSocketModel[] = [];
	const shown = node.bundled ? node.rows.slice(0, SHOWN_WHEN_FOLDED) : node.rows;
	const hidden = node.bundled ? node.rows.slice(SHOWN_WHEN_FOLDED) : [];
	shown.forEach((r, row) => {
		const id = r[side];
		if (!id || isBundleSocket(id) || seen.has(id)) return;
		seen.add(id);
		out.push({ id, fat: false, recordId: r.recordId, row, free: false });
	});
	const bundle = hidden.find((r) => r[side] && isBundleSocket(r[side]!))?.[side];
	if (bundle) out.push({ id: bundle, fat: true, recordId: null, row: -1, free: false });
	if (o.editable && wirable(node, side)) {
		shown.forEach((r, row) => {
			if (!r[side]) out.push({ id: `free:${side}:${r.recordId}`, fat: false, recordId: r.recordId, row, free: true });
		});
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
