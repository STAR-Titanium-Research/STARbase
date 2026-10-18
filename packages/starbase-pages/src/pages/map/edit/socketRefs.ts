// How the map's cards and sockets are tied to the draft (edit mode): which draft item a drawn card is, and which end of a wire
// a socket stands for. Pure, no Vue, no DOM: the node components write a socket's reference into the page (`data-sock`), the
// page reads it back when a click or a drag lands on it, and this resolves it against the draft.
//
// A drawn card is a draft item when its record id says so: a new item is `draft:<key>` (an operation's rows are `draft:<row key>`,
// see toGraph), an existing record the draft holds carries its own id. A sample card of the loaded history that the draft does not
// hold yet resolves to nothing: the page adds it to the draft (with its version) when the person first builds from it.

import type { DraftBody, DraftItem, DraftKey, DraftOperation } from '@d1/ui';
import type { WireEnd } from './draft';
import type { MapNode } from '../model/types';
import { draftKeyOf } from './toGraph';

export type EndSide = 'in' | 'out';

/** A socket the person can act on: a sample card's, or one row of a container's (a stack of passes: its first row's input, its last row's output). */
export interface SocketRef {
	kind: 'sample' | 'row';
	/** The record id the card or row is drawn with (`draft:n3`, or an existing record's id). */
	id: string;
	side: EndSide;
}

const SEP = '|';

/** The value of a socket's `data-sock` attribute. */
export const encodeSocket = (s: SocketRef): string => [s.kind, s.id, s.side].join(SEP);

export function decodeSocket(text: string | null | undefined): SocketRef | null {
	const [kind, id, side, ...rest] = (text ?? '').split(SEP);
	if (rest.length || !id || (kind !== 'sample' && kind !== 'row') || (side !== 'in' && side !== 'out')) return null;
	return { kind, id, side };
}

/** The draft item a sample card's record id is, or undefined (a sample of the loaded history that is not in the draft). */
export function sampleItemOf(body: DraftBody, recordId: string): DraftItem | undefined {
	const key = draftKeyOf(recordId);
	if (key) return body.items.find((i) => i.kind === 'sample' && i.key === key);
	return body.items.find((i) => i.kind === 'sample' && i.existing?.id === recordId);
}

/** The operation or test and the row a container row's record id is, or undefined. */
export function rowItemOf(body: DraftBody, recordId: string): { item: DraftItem; row: number } | undefined {
	const key = draftKeyOf(recordId);
	for (const item of body.items) {
		if (item.kind === 'sample') continue;
		if (item.kind === 'test') {
			if (key ? item.key === key : item.existing?.id === recordId) return { item, row: 0 };
			continue;
		}
		const at = key ? item.rows.findIndex((r) => r.key === key) : item.existing?.id === recordId ? 0 : -1;
		if (at >= 0) return { item, row: at };
	}
	return undefined;
}

/** The end of a wire a socket stands for, or null when the card is not in the draft. */
export function resolveEnd(body: DraftBody, s: SocketRef): WireEnd | null {
	if (s.kind === 'sample') {
		const item = sampleItemOf(body, s.id);
		return item ? { key: item.key } : null;
	}
	const hit = rowItemOf(body, s.id);
	if (!hit) return null;
	return hit.item.kind === 'operation' ? { key: hit.item.key, row: hit.row } : { key: hit.item.key };
}

/** The draft key of a drawn card (a sample, or the first row's item of a container), null when it is not in the draft. */
export function draftKeyOfNode(body: DraftBody, node: MapNode | undefined): DraftKey | null {
	if (!node) return null;
	if (node.type === 'record') return node.kind === 'sample' ? (sampleItemOf(body, node.ref.id)?.key ?? null) : null;
	if (node.type !== 'container') return null;
	for (const id of node.group.rowIds) {
		const hit = rowItemOf(body, id);
		if (hit) return hit.item.key;
	}
	return null;
}

/** The draft keys of every item a drawn card is made of (a stack of passes is several operations), none when it is not in the draft. */
export function draftKeysOfNode(body: DraftBody, node: MapNode | undefined): DraftKey[] {
	if (!node) return [];
	if (node.type === 'record') return draftKeyOfNode(body, node) ? [draftKeyOfNode(body, node)!] : [];
	if (node.type !== 'container') return [];
	const keys: DraftKey[] = [];
	for (const id of node.group.rowIds) {
		const hit = rowItemOf(body, id);
		if (hit && !keys.includes(hit.item.key)) keys.push(hit.item.key);
	}
	return keys;
}

/** True when the card is made of items of the draft: it is always drawn, and it can be edited and removed. */
export const isDraftNode = (body: DraftBody, node: MapNode): boolean => draftKeyOfNode(body, node) !== null;

/** The draft operation of a container's key, when it is one (a "＋ output" row can be added to a new operation only). */
export function newOperationOf(body: DraftBody, key: DraftKey | null): DraftOperation | null {
	const item = key ? body.items.find((i) => i.key === key) : undefined;
	return item?.kind === 'operation' && !item.existing ? item : null;
}

/** The record id of the row a socket of a container belongs to: a stack is one deck, its input is its first pass's and its output its last's. */
export function rowRecordId(node: { group: { rowIds: string[] }; stacked?: boolean }, recordId: string, side: EndSide): string {
	if (!node.stacked || node.group.rowIds.length < 2) return recordId;
	const ids = node.group.rowIds;
	return side === 'in' ? ids[0] : ids[ids.length - 1];
}

// ---- finding the socket under the pointer --------------------------------------------------------

export interface SocketSpot {
	sock: SocketRef;
	/** Centre of the socket on screen. */
	x: number;
	y: number;
}

/** The socket nearest to a point, within `radius` px of its centre (sockets are 12 px dots: a drop does not have to be exact). */
export function nearestSocket(spots: readonly SocketSpot[], x: number, y: number, radius = 18): SocketSpot | null {
	let best: SocketSpot | null = null;
	let bestD = radius * radius;
	for (const s of spots) {
		const d = (s.x - x) ** 2 + (s.y - y) ** 2;
		if (d <= bestD) {
			best = s;
			bestD = d;
		}
	}
	return best;
}
