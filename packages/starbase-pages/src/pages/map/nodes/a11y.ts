// The words a screen reader gets for the map's cards and sockets (spec D23). Pure.

import type { MapNode, Wire } from '../model/types';
import { KINDS, LINEAGE_LABEL } from './kinds';
import { socketTooltip } from './wireTooltip';

/** A card's name: `"S-0412-A, Sample"`, `"Sintering OP-17, Operation"`, `"Lineage: split, junction"`. Null for the "+N more" stub (it labels itself). */
export function cardLabel(node: MapNode): string | null {
	if (node.type === 'record') return `${node.ref.code}, ${KINDS[node.kind].label}`;
	if (node.type === 'container') {
		const named = node.code && !node.title.includes(node.code) && !node.probable ? `${node.title} ${node.code}` : node.title;
		return `${named}, ${KINDS[node.kind].label}`;
	}
	if (node.type === 'junction') return `${LINEAGE_LABEL[node.lineageType]}, ${KINDS.junction.label}`;
	return null;
}

/**
 * `(socket, side) => "Input: S-0412-A · Sample"`: what a socket connects, from the same lines its hover
 * tooltip lists (socketTooltip). Groups the wires by socket once, so a map of hundreds of sockets does
 * not scan the wires for each.
 */
export function socketLabeller(wires: readonly Wire[], nodesById: ReadonlyMap<string, MapNode>): (socket: string, side: 'in' | 'out') => string {
	const bySocket = new Map<string, Wire[]>();
	for (const w of wires) {
		for (const s of [w.from, w.to]) {
			const list = bySocket.get(s);
			if (list) list.push(w);
			else bySocket.set(s, [w]);
		}
	}
	return (socket, side) => `${side === 'in' ? 'Input' : 'Output'}: ${socketTooltip(socket, bySocket.get(socket) ?? [], nodesById).join(', ')}`;
}
