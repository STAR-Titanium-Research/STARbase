// What Delete, X and Dissolve do on the canvas (redesign spec R4), decided without the DOM: given the draft, the drawn graph and the selected
// card or wire, say what goes, or why nothing does. Pure, no Vue: the page asks, shows the reason, and applies the actions as ONE history step.
//
//   remove   a new item (a draft card) vanishes with its wires. A planned record that exists is kept on the canvas, struck through, and
//            deleted at Create (`remove` with `deleteRecord`: it needs adding to the draft first, which is the page's job: `existing`).
//            A done record, or a planned one something done hangs off, is locked: nothing goes, and the reason is said.
//   unwire   a wire of the draft goes. A wire between records that are saved (not the draft's) cannot be changed from the map.
//   dissolve a new operation with exactly one input sample and one output sample goes, and the output sample with it: what hung off the
//            output now hangs off the input (the two are "the same sample" again). Anything else is explained.

import type { DraftBody, DraftKey, DraftOperation } from '@d1/ui';
import type { ContainerNode, MapNode, ProcessGraph, RecordNode } from '../model/types';
import { nodeOfSocket } from '../model/sockets';
import { apply, inputSampleOf, isInPlace, itemOf, outputSampleOf, wireInto, wiresOutOf, type DraftAction, type WireEnd } from './draft';
import { rowItemOf, sampleItemOf } from './socketRefs';

/** The reason shown with the lock on a done record. */
export const DONE_LOCK = "Done records can't be removed from the map";
/** A planned record that something done hangs off. */
export const DONE_HANGS = "Something done hangs off it, so it can't be removed from the map";
/** A wire between done records. */
export const DONE_WIRE = "Done records' wires can't be removed from the map";
/** A wire of planned records that are saved: removing the wire alone is not something Create can do. */
export const SAVED_WIRE = 'That wire belongs to records that are already saved. Remove the planned record instead.';
export const ALREADY_GOING = 'It is already going to be deleted. Undo to keep it.';
export const NOT_REMOVABLE = 'Only samples, operations and tests can be removed from the map.';

export interface ExistingTarget {
	kind: 'sample' | 'operation' | 'test';
	id: string;
}

export type RemoveVerdict =
	| {
			ok: true;
			/** Items of the draft that vanish (new ones, and records the draft only picked up). */
			keys: DraftKey[];
			/** Planned records that exist: the draft marks them for deletion at Create. */
			existing: ExistingTarget[];
	  }
	| { ok: false; reason: string; /** A done record: the card wears a lock. */ locked: boolean };

export interface RemovalCtx {
	/** True when the record is part of what the map loaded (not only picked into the draft from the index). */
	inHistory: (recordId: string) => boolean;
}

const refuse = (reason: string, locked = false): RemoveVerdict => ({ ok: false, reason, locked });

/** The drawn nodes by id. */
const byId = (graph: ProcessGraph): Map<string, MapNode> => new Map(graph.nodes.map((n) => [n.id, n]));

/** A record the draft makes, or a planned one it deletes: nothing about it is done work. */
const settled = (n: MapNode): boolean => (n.type === 'record' ? !!(n.draft || n.planned) : n.type === 'container' ? !!(n.draft || n.planned || n.removing) : true);

/**
 * Is there done work downstream of `node` (through the samples it makes, to a container that is neither planned nor the draft's)? A
 * planned record cannot be deleted while something done hangs off it.
 */
export function doneHangsOff(graph: ProcessGraph, node: MapNode): boolean {
	const nodes = byId(graph);
	const seen = new Set<string>([node.id]);
	const queue = [node.id];
	while (queue.length) {
		const id = queue.shift()!;
		for (const w of graph.wires) {
			if (nodeOfSocket(w.from) !== id) continue;
			const to = nodes.get(nodeOfSocket(w.to));
			if (!to || seen.has(to.id)) continue;
			seen.add(to.id);
			if (to.type === 'container' && !settled(to)) return true;
			if (to.type === 'record' && to.kind === 'sample' && !settled(to) && !to.removing) continue;
			queue.push(to.id);
		}
	}
	return false;
}

/** What removing the card `node` does: see the file's header. */
export function removeVerdict(body: DraftBody, graph: ProcessGraph, node: MapNode | undefined, ctx: RemovalCtx): RemoveVerdict {
	if (!node || (node.type !== 'record' && node.type !== 'container')) return refuse(NOT_REMOVABLE);
	if (node.removing) return refuse(ALREADY_GOING);
	if (node.type === 'record') return removeRecordVerdict(body, graph, node, ctx);
	return removeContainerVerdict(body, graph, node);
}

function removeRecordVerdict(body: DraftBody, graph: ProcessGraph, node: RecordNode, ctx: RemovalCtx): RemoveVerdict {
	if (node.kind !== 'sample') return refuse(NOT_REMOVABLE);
	const item = sampleItemOf(body, node.ref.id);
	if (item && !item.existing) return { ok: true, keys: [item.key], existing: [] };
	// A sample the draft picked from the index is only on the canvas because of the draft: taking it off forgets it, the record is untouched.
	if (item && !ctx.inHistory(node.ref.id)) return { ok: true, keys: [item.key], existing: [] };
	if (!node.planned) return refuse(DONE_LOCK, true);
	if (doneHangsOff(graph, node)) return refuse(DONE_HANGS, true);
	return { ok: true, keys: [], existing: [{ kind: 'sample', id: node.ref.id }] };
}

function removeContainerVerdict(body: DraftBody, graph: ProcessGraph, node: ContainerNode): RemoveVerdict {
	const keys: DraftKey[] = [];
	const recorded: string[] = [];
	for (const rowId of node.group.rowIds) {
		const hit = rowItemOf(body, rowId);
		if (rowId.startsWith('draft:')) {
			if (hit && !keys.includes(hit.item.key)) keys.push(hit.item.key);
			continue;
		}
		// An existing operation given an input by this draft (attach): removing it takes the draft's wiring off, the record stays.
		if (hit?.item.kind === 'operation' && hit.item.attach) {
			if (!keys.includes(hit.item.key)) keys.push(hit.item.key);
			continue;
		}
		recorded.push(rowId);
	}
	// A card that holds passes of the draft among recorded ones (a stack, a batch): the first Delete takes only the draft's own; the recorded
	// ones are deleted by a second Delete on the card that is left (a person who meant to delete a saved record says so by pressing it again).
	if (keys.length) return { ok: true, keys, existing: [] };
	if (!recorded.length) return refuse(NOT_REMOVABLE);
	if (!node.planned) return refuse(DONE_LOCK, true);
	if (doneHangsOff(graph, node)) return refuse(DONE_HANGS, true);
	return { ok: true, keys: [], existing: recorded.map((id) => ({ kind: node.kind, id })) };
}

/**
 * The actions that carry a verdict out, once every record it deletes is an item of the body (the page adds them first). Taking a new sample
 * away also takes the pieces of a cut that only it came out of (a socket nothing leaves is not kept: see `spareRows`).
 */
export function removeActions(body: DraftBody, v: Extract<RemoveVerdict, { ok: true }>): DraftAction[] {
	const out: DraftAction[] = v.keys.filter((k) => !!itemOf(body, k)).map((key) => ({ type: 'remove' as const, key }));
	for (const t of v.existing) {
		const item = body.items.find((i) => i.kind === t.kind && i.existing?.id === t.id);
		if (item && !item.remove) out.push({ type: 'remove', key: item.key, deleteRecord: true });
	}
	const gone = new Set(out.flatMap((a) => (a.type === 'remove' ? [a.key] : [])));
	const wires = body.wires.filter((w) => gone.has(w.from.key) || gone.has(w.to.key));
	return [...out, ...spareRows(body, wires, gone).map((r) => ({ type: 'removeRow' as const, key: r.key, row: r.row }))];
}

// ---- wires ---------------------------------------------------------------------------------------

/** The drawn node an end of a draft wire is on. */
function nodeOfEnd(body: DraftBody, graph: ProcessGraph, end: WireEnd): string | undefined {
	const item = itemOf(body, end.key);
	if (!item) return undefined;
	let recordId: string;
	if (item.kind === 'operation') {
		const row = item.rows[end.row ?? 0];
		if (!row) return undefined;
		recordId = item.existing ? item.existing.id : `draft:${row.key}`;
	} else recordId = item.existing ? item.existing.id : `draft:${item.key}`;
	for (const n of graph.nodes) {
		if (n.type === 'record' && item.kind === 'sample' && n.kind === 'sample' && n.ref.id === recordId) return n.id;
		if (n.type === 'container' && item.kind !== 'sample' && n.group.rowIds.includes(recordId)) return n.id;
	}
	return undefined;
}

/** Wires as they are taken off, with the way back to the sample of an operation that worked in place on it: without the way in it is not "on" it. */
function withBackEdges(body: DraftBody, hits: DraftBody['wires']): { from: WireEnd; to: WireEnd }[] {
	const out = hits.map((w) => ({ from: { ...w.from }, to: { ...w.to } }));
	for (const w of hits) {
		for (const back of body.wires) {
			if (back.from.key === w.to.key && (back.from.row ?? 0) === (w.to.row ?? 0) && back.to.key === w.from.key && !out.some((o) => o.from.key === back.from.key && o.to.key === back.to.key)) {
				out.push({ from: { ...back.from }, to: { ...back.to } });
			}
		}
	}
	return out;
}

export type UnwireVerdict =
	| {
			ok: true;
			wires: { from: WireEnd; to: WireEnd }[];
			/** Output rows of a new operation that nothing leaves any more: a socket nobody uses is not kept, so the row goes (never the last one). */
			rows: { key: DraftKey; row: number }[];
	  }
	| { ok: false; reason: string; locked: boolean };

/**
 * The output rows left with no wire once `gone` are off: more than one row, so a row is a piece that nothing comes out of any more. Only a
 * piece that shares its input sample with another row (a cut) goes; a row that has an input sample of its own (one more sample in a batch)
 * stays, as an operation on that sample that makes nothing new. `removed`: items that go altogether (their rows are not looked at).
 */
function spareRows(body: DraftBody, gone: { from: WireEnd; to: WireEnd }[], removed: ReadonlySet<DraftKey> = new Set()): { key: DraftKey; row: number }[] {
	const same = (a: WireEnd, b: WireEnd) => a.key === b.key && (a.row ?? 0) === (b.row ?? 0);
	const candidates: { key: DraftKey; row: number }[] = [];
	for (const w of gone) {
		const op = itemOf(body, w.from.key);
		if (op?.kind !== 'operation' || op.existing || op.rows.length < 2 || removed.has(op.key)) continue;
		const row = w.from.row ?? 0;
		if (itemOf(body, w.to.key)?.kind !== 'sample' || candidates.some((c) => c.key === op.key && c.row === row)) continue;
		const left = body.wires.some((x) => same(x.from, { key: op.key, row }) && !gone.some((g) => same(g.from, x.from) && same(g.to, x.to)));
		if (left) continue;
		// Its input: shared with another row (a cut piece, which has nothing else to be), or none at all.
		const input = wireInto(body, op.key, row)?.from.key;
		const shared = !input || op.rows.some((_, r) => r !== row && wireInto(body, op.key, r)?.from.key === input);
		if (shared) candidates.push({ key: op.key, row });
	}
	// One operation never loses every row: when they would all go, the first of them stays.
	const out: { key: DraftKey; row: number }[] = [];
	for (const key of new Set(candidates.map((c) => c.key))) {
		const mine = candidates.filter((c) => c.key === key);
		const rows = (itemOf(body, key) as DraftOperation).rows.length;
		out.push(...(mine.length >= rows ? mine.slice(1) : mine));
	}
	return out.sort((a, b) => b.row - a.row);
}

/**
 * What removing the drawn wire `wireId` does: the draft's wires between those two cards go (and the way back to the sample, when the
 * wire fed an operation that then works in place on it). A wire the draft did not make belongs to saved records and is refused: with the
 * lock when something in it is done.
 */
export function unwireVerdict(body: DraftBody, graph: ProcessGraph, wireId: string): UnwireVerdict {
	const wire = graph.wires.find((w) => w.id === wireId);
	if (!wire) return { ok: false, reason: 'That wire is not there any more.', locked: false };
	const from = nodeOfSocket(wire.from);
	const to = nodeOfSocket(wire.to);
	const hits = body.wires.filter((w) => nodeOfEnd(body, graph, w.from) === from && nodeOfEnd(body, graph, w.to) === to);
	if (hits.length) {
		const wires = withBackEdges(body, hits);
		return { ok: true, wires, rows: spareRows(body, wires) };
	}
	const nodes = byId(graph);
	const ends = [nodes.get(from), nodes.get(to)].filter((n): n is MapNode => !!n);
	// Done wiring is a wire between records that are done; a wire with a planned end is that planned record's (remove it instead).
	if (ends.length && ends.every((n) => !settled(n))) return { ok: false, reason: DONE_WIRE, locked: true };
	return { ok: false, reason: SAVED_WIRE, locked: false };
}

/** The actions that take those wires off, as one step. */
export const unwireActions = (v: Extract<UnwireVerdict, { ok: true }>): DraftAction[] => [
	...v.wires.map((w) => ({ type: 'unwire' as const, from: w.from, to: w.to })),
	// Highest row first, so the rows still to go keep their numbers.
	...v.rows.map((r) => ({ type: 'removeRow' as const, key: r.key, row: r.row })),
];

// ---- dissolve ------------------------------------------------------------------------------------

export type DissolveVerdict = { ok: true; actions: DraftAction[]; /** What it does, for the line that says so. */ summary: string } | { ok: false; reason: string; locked: boolean };

const no = (reason: string, locked = false): DissolveVerdict => ({ ok: false, reason, locked });

/**
 * Dissolve a container: it goes, and its input sample is wired straight to what its output sample fed (the output sample goes too: it
 * was "the same sample" with a step between). Only a new operation with exactly one input and one output; a pass in place (no output
 * sample) is just taken out; a stack of passes goes as a whole. Everything else says why not.
 */
export function dissolveVerdict(body: DraftBody, graph: ProcessGraph, node: MapNode | undefined): DissolveVerdict {
	if (node?.type !== 'container') return no('Only an operation can be dissolved.');
	if (node.removing) return no(ALREADY_GOING);
	if (node.kind === 'test') return no('A test has nothing coming out of it to join its input to. Remove it instead.');
	const rows = node.group.rowIds;
	if (rows.some((id) => !id.startsWith('draft:'))) {
		return node.planned ? no('A record that is already saved cannot be dissolved. Remove it, and it is deleted when you create.') : no(DONE_LOCK, true);
	}
	const items: DraftOperation[] = [];
	for (const id of rows) {
		const hit = rowItemOf(body, id);
		if (hit?.item.kind === 'operation' && !items.includes(hit.item)) items.push(hit.item);
	}
	if (!items.length) return no('That card is not in the draft.');
	if (items.length > 1) {
		// A stack of passes: each leaves the sample where it is, so taking them all out leaves the sample as it was.
		if (!items.every((op) => isInPlace(body, op) && inputSampleOf(body, { key: op.key, row: 0 }))) return no('Dissolve works on one operation at a time. Unstack it first.');
		return { ok: true, actions: items.map((op) => ({ type: 'remove' as const, key: op.key })), summary: `Took out ${items.length} passes` };
	}
	const op = items[0];
	if (op.rows.length !== 1) return no(`This operation has ${op.rows.length} outputs. Dissolve needs exactly one input and one output: remove it instead.`);
	const into = wireInto(body, op.key, 0);
	const input = into ? itemOf(body, into.from.key) : undefined;
	if (!into || input?.kind !== 'sample') return no('Dissolve needs a sample going in: wire one to it first, or remove it.');
	const outs = wiresOutOf(body, op.key, 0);
	const out = outputSampleOf(body, op.key, 0);
	if (out === null) {
		// In place: the sample comes out as it went in.
		return { ok: true, actions: [{ type: 'remove', key: op.key }], summary: 'Took the operation out' };
	}
	if (outs.length !== 1) return no('Dissolve needs exactly one output: this one feeds more than one thing. Remove it instead.');
	const made = itemOf(body, out);
	if (made?.kind !== 'sample' || made.existing) return no('Its output is a sample that already exists: it cannot be joined to the input. Remove the operation instead.');
	// What hung off the output now hangs off the input.
	const next = wiresOutOf(body, made.key);
	const actions: DraftAction[] = [
		{ type: 'remove', key: op.key },
		{ type: 'remove', key: made.key },
		...next.map((w) => ({ type: 'wire' as const, from: { key: input.key }, to: { ...w.to } })),
	];
	const after = actions.reduce((b, a) => apply(b, a), body);
	const joined = next.filter((w) => after.wires.some((x) => x.from.key === input.key && x.to.key === w.to.key && (x.to.row ?? 0) === (w.to.row ?? 0)));
	if (joined.length !== next.length) return no('The next step cannot take the input sample directly, so the operation is left where it is.');
	return { ok: true, actions, summary: 'Joined the input to the output' };
}
