// "Connect to…" (spec E21): the keyboard's way to a wire. From one socket, the sockets of the draft it can be wired to, named by code,
// so no gesture needs dragging. Pure: the candidates are every socket of the draft on the other side of a wire, kept when the
// draft's own rules (dropVerdict, the same as a drop) take the pair.

import type { DraftBody, DraftItem } from '@d1/ui';
import type { SocketRef } from './socketRefs';
import { dropVerdict } from './wireDrop';

export interface ConnectEntry {
	id: string;
	/** What the person types to find it: a sample's code, an operation's method, a test's type. */
	label: string;
	detail: string;
	sock: SocketRef;
}

/** What the draft's items are called in this list. */
export interface ConnectNames {
	sample(item: DraftItem): string;
	operation(item: DraftItem, row: number): string;
	test(item: DraftItem): string;
}

/** The record id a drawn card of an item has: `draft:<key>` for a new one, its own id for one that exists. */
const sampleId = (item: DraftItem) => item.existing?.id ?? `draft:${item.key}`;

/** Every socket on the other side of a wire from `from`, as it would be drawn. */
function candidates(body: DraftBody, side: 'in' | 'out', names: ConnectNames): ConnectEntry[] {
	const out: ConnectEntry[] = [];
	for (const item of body.items) {
		if (item.remove) continue;
		if (item.kind === 'sample') {
			out.push({ id: `s:${item.key}`, label: names.sample(item), detail: item.existing ? 'sample' : 'new sample', sock: { kind: 'sample', id: sampleId(item), side } });
		} else if (item.kind === 'test') {
			if (side === 'in') out.push({ id: `t:${item.key}`, label: names.test(item), detail: 'test', sock: { kind: 'row', id: item.existing?.id ?? `draft:${item.key}`, side } });
		} else {
			item.rows.forEach((r, i) => {
				const id = item.existing ? item.existing.id : `draft:${r.key}`;
				out.push({ id: `o:${r.key}`, label: names.operation(item, i), detail: item.rows.length > 1 ? `operation, piece ${i + 1}` : 'operation', sock: { kind: 'row', id, side } });
			});
		}
	}
	return out;
}

/** The sockets `from` can be wired to, in the order of the draft. */
export function connectTargets(body: DraftBody, from: SocketRef, names: ConnectNames): ConnectEntry[] {
	const side = from.side === 'out' ? 'in' : 'out';
	// The sockets of the card it is on (its other rows) are not offered; a socket that adds a row is asked about as it is: dropVerdict reads it.
	return candidates(body, side, names).filter((c) => !(c.sock.kind === from.kind && c.sock.id === from.id) && dropVerdict(body, from, c.sock).ok);
}

/** Entries that have every word of the query in their label or detail. */
export function filterConnect(entries: readonly ConnectEntry[], query: string): ConnectEntry[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [...entries];
	return entries.filter((e) => {
		const hay = `${e.label} ${e.detail}`.toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}
