// Putting something BETWEEN two cards, and before or after one (redesign R2, R3), without Vue or the DOM. Given the draft, the drawn graph and what
// is being added, say which reducer actions do it (all of them one undoable step), or why nothing does. Every plan is played on a copy of the
// body first, step by step, so a step the draft would refuse (a wire that does not fit) is a refusal with the draft's own reason, never a
// half-done insert.
//
//   onto a wire        sample S -> C  becomes  S -> X -> N -> C     (X an operation, N a new sample it makes)
//                      operation O -> N0  becomes  O -> N1 -> X -> N0
//                      operation O -> C   becomes  O -> X -> C
//                      (a new sample dropped on an operation -> operation wire goes between them: O -> N -> C)
//   before a sample    one that something makes: X goes on that wire; one nothing makes: X makes it (and gets a new input sample)
//   after a sample     its one outgoing wire when it has exactly one, else X is fed by it (a new branch)
//   before / after a container   on its one input / output wire; with none, a new sample and X are added next to it
//   before a RECORDED sample (done, or planned and saved)   refused up front (BEFORE_RECORDED): its history is recorded and a record's parentage is
//                      never changed from the map (R3). There is no "earlier step" action: it built a chain nothing connected to the sample.
//
// A wire of records that are done (or saved) is never touched: the answer is the lock reason of removal.ts (R4).

import type { DraftBody, DraftKey, DraftOperation } from '@d1/ui';
import { nodeOfSocket } from '../model/sockets';
import type { MapNode, ProcessGraph } from '../model/types';
import { refusal } from './addDrop';
import { apply, backEdge, newKeys, wiresOutOf, type DraftAction, type Pos, type WireEnd } from './draft';
import { actionsFor, type MenuChoice } from './menuModel';
import { ALREADY_GOING, DONE_WIRE, SAVED_WIRE, unwireVerdict } from './removal';
import { draftKeysOfNode, sampleItemOf } from './socketRefs';

export type InsertVerdict = { ok: true; actions: DraftAction[] } | { ok: false; reason: string; locked: boolean };

const fail = (reason: string, locked = false): InsertVerdict => ({ ok: false, reason, locked });

export const NO_FIT = 'That does not fit there.';
export const TEST_BETWEEN = 'A test has nothing coming out of it, so it cannot go between two cards.';
export const SAMPLE_BETWEEN = 'A sample goes between operations. Drop an operation here, or drop the sample on empty canvas.';
export const SEVERAL_WIRES = 'Several wires meet here. Drop it on the wire you mean.';
export const STACKED = 'This is a stack of passes on one sample. Unstack it first, then insert on the pass you mean.';
export const TEST_AFTER = 'A test has nothing coming out of it, so nothing can come after it.';
/** "Insert before" a sample that already exists as a record (done, or planned and saved): its lineage can't be changed from the map (R3). */
export const BEFORE_RECORDED = "Its history is recorded and can't change from the map. Start from a new sample instead.";

type Wire = { from: WireEnd; to: WireEnd };
type Step = (c: { body: DraftBody; made: DraftKey[] }) => DraftAction;

/** Plays the steps on a copy of the body, in order: the actions when each one changed it, else the refusal (with the draft's reason for a wire). */
function plan(body: DraftBody, steps: Step[]): InsertVerdict {
	let cur = body;
	const actions: DraftAction[] = [];
	const made: DraftKey[] = [];
	for (const step of steps) {
		const action = step({ body: cur, made });
		const next = apply(cur, action);
		const why = refusal(cur, next, action);
		if (why) return fail(why);
		made.push(...newKeys(cur, next));
		actions.push(action);
		cur = next;
	}
	return { ok: true, actions };
}

const unwires = (wires: Wire[]): Step[] => wires.map((w) => () => ({ type: 'unwire' as const, from: w.from, to: w.to }));

/** The container a choice adds, unwired and placed at `at`. */
function containerOf(body: DraftBody, choice: MenuChoice, at?: Pos): Extract<DraftAction, { type: 'addContainer' }> | null {
	const a = actionsFor({ body, end: null, side: null, card: null, at }, choice)[0];
	return a?.type === 'addContainer' ? a : null;
}

/**
 * `choice` put between the two ends of one draft wire (`wires`: that wire first, then any way back it has: they all go). The two ends say which
 * way: a sample to a container gets the operation and the sample it makes; an operation to a sample gets a sample and the operation after it;
 * an operation to a container gets the operation (or a sample) between.
 *
 * A cut is drawn as ONE wire but is several row wires of one operation sharing one input: they are one insert, and all of them move to what
 * is added, so the input stays shared. A stack of passes (several operations on one sample) is refused with its own reason.
 */
export function insertOnDraftWires(body: DraftBody, wires: Wire[], choice: MenuChoice, at?: Pos): InsertVerdict {
	const real = wires.filter((w) => !backEdge(body, w));
	if (!real.length) return fail(NO_FIT);
	const wire = real[0];
	// Row wires of one operation that share the input end: one wire to the eye, one insert.
	const sameInput = real.every((w) => w.from.key === wire.from.key && (w.from.row ?? 0) === (wire.from.row ?? 0));
	if (real.length > 1 && !(sameInput && real.every((w) => w.to.key === wire.to.key))) {
		const passes = sameInput && real.every((w) => isPassOn(body, w.to.key));
		return fail(passes ? STACKED : SEVERAL_WIRES);
	}
	const ends = real.map((w) => w.to);
	const from = body.items.find((i) => i.key === wire.from.key);
	const to = body.items.find((i) => i.key === wire.to.key);
	if (!from || !to) return fail(NO_FIT);
	if (choice.kind === 'test') return fail(TEST_BETWEEN);
	/** Wires the end made last (by key) to every end that was on the old wire. */
	const toAll = (key: (made: DraftKey[]) => WireEnd): Step[] => ends.map((end) => ({ made }) => ({ type: 'wire' as const, from: key(made), to: end }));
	if (choice.kind === 'newSample') {
		if (from.kind !== 'operation' || to.kind === 'sample') return fail(SAMPLE_BETWEEN);
		return plan(body, [...unwires(wires), () => ({ type: 'addSample', from: wire.from, at }), ...toAll((made) => ({ key: made[0] }))]);
	}
	if (choice.kind !== 'operation') return fail(NO_FIT);
	const x = containerOf(body, choice, at);
	if (!x) return fail(NO_FIT);
	if (from.kind === 'sample' && to.kind !== 'sample') {
		return plan(body, [
			...unwires(wires),
			() => ({ ...x, from: wire.from }),
			({ made }) => ({ type: 'addSample', from: { key: made[0], row: 0 } }),
			...toAll((made) => ({ key: made[1] })),
		]);
	}
	if (from.kind === 'operation' && to.kind === 'sample') {
		return plan(body, [
			...unwires(wires),
			() => ({ type: 'addSample', from: wire.from }),
			({ made }) => ({ ...x, from: { key: made[0] } }),
			...toAll((made) => ({ key: made[1], row: 0 })),
		]);
	}
	if (from.kind === 'operation') {
		return plan(body, [...unwires(wires), () => ({ ...x, from: wire.from }), ...toAll((made) => ({ key: made[0], row: 0 }))]);
	}
	return fail(NO_FIT);
}

/** A pass: an operation that works in place, taking its sample in and giving it back (it has the wire back to it; one that is open has none). */
const isPass = (body: DraftBody, item: DraftOperation): boolean => item.rows.length === 1 && wiresOutOf(body, item.key, 0).some((w) => backEdge(body, w));
const isPassOn =(body: DraftBody, key: DraftKey): boolean => {
	const item = body.items.find((i) => i.key === key);
	return item?.kind === 'operation' && isPass(body, item);
};

/** The drawn wire `wireId`, as the draft's wires between those two cards: or why the draft cannot change it (done wiring, saved records). */
export function insertOnWire(body: DraftBody, graph: ProcessGraph, wireId: string, choice: MenuChoice, at?: Pos): InsertVerdict {
	const v = unwireVerdict(body, graph, wireId);
	return v.ok ? insertOnDraftWires(body, v.wires, choice, at) : fail(v.reason, v.locked);
}

/** The drawn wires on one side of a card. */
const wiresOn = (graph: ProcessGraph, node: MapNode, side: 'in' | 'out') => graph.wires.filter((w) => nodeOfSocket(side === 'in' ? w.to : w.from) === node.id);

/**
 * Why nothing can be inserted around this card (either side), or null: it is struck through ("will be deleted"), or it is a container the draft
 * does not hold (done, or a saved planned one), or a recorded operation: d1-build refuses an operation -> sample wire on a saved operation
 * (it keeps the sample it made), and the draft would write one. A recorded operation that only took an input in (attach) can still be
 * inserted before. A junction or a "+N more" is not asked about.
 */
export function insertRefusal(body: DraftBody, node: MapNode): { reason: string; locked: boolean } | null {
	const going = { reason: ALREADY_GOING, locked: false };
	if (node.type === 'record' && node.kind === 'sample') return node.removing || sampleItemOf(body, node.ref.id)?.remove ? going : null;
	if (node.type !== 'container') return null;
	if (node.removing) return going;
	const items = draftKeysOfNode(body, node).flatMap((k) => body.items.filter((i) => i.key === k));
	if (!items.length) return node.planned ? { reason: SAVED_WIRE, locked: false } : { reason: DONE_WIRE, locked: true };
	if (items.some((i) => i.remove)) return going;
	if (items.some((i) => i.existing && !(i.kind === 'operation' && i.attach))) return { reason: SAVED_WIRE, locked: false };
	return null;
}

/**
 * Why "Insert before" is refused for this card, or null: a sample that already exists as a record (done, or planned and saved) is never given a
 * maker from the map (R3). A new sample, a container, a junction are not asked about here.
 */
export function insertBeforeRefusal(node: MapNode | undefined): string | null {
	return node && node.type === 'record' && node.kind === 'sample' && !node.draft ? BEFORE_RECORDED : null;
}

/**
 * Insert before or after a drawn card, without dragging. A sample of the loaded history must already be an item of the draft (the page adds
 * it first), unless it is a recorded sample asked about "before", which is refused before anything is read. `choice` is an operation (or a
 * new sample for a container's side).
 */
export function insertAround(o: { body: DraftBody; graph: ProcessGraph; node: MapNode; where: 'before' | 'after'; choice: MenuChoice; at?: Pos }): InsertVerdict {
	const { body, graph, node, where, choice, at } = o;
	if (node.type === 'record' && node.kind === 'sample') {
		// A recorded sample is never given a parent, whatever is chosen, so "before" is refused before it matters whether it is in the draft.
		const no = insertRefusal(body, node);
		if (no) return fail(no.reason, no.locked);
		if (where === 'before' && insertBeforeRefusal(node)) return fail(BEFORE_RECORDED, true);
		const item = sampleItemOf(body, node.ref.id);
		if (!item) return fail('That sample is not part of the draft yet.');
		const wires = wiresOn(graph, node, where === 'before' ? 'in' : 'out');
		if (wires.length > 1 && where === 'before') return fail(SEVERAL_WIRES);
		// After it, its one outgoing wire is where the operation goes. When that wire is not the draft's to change (done, or saved) the operation
		// is fed by the sample instead, a new branch, as it is for a sample with none or several.
		if (wires.length === 1 && (where === 'before' || unwireVerdict(body, graph, wires[0].id).ok)) return insertOnWire(body, graph, wires[0].id, choice, at);
		if (where === 'after') {
			// Nothing leaves it (or several things do): the operation is fed by it, as a new branch.
			const x = actionsFor({ body, end: { key: item.key }, side: 'out', card: 'sample', at }, choice);
			return x.length ? plan(body, x.map((a) => () => a)) : fail(NO_FIT);
		}
		// Before a sample nothing makes: an operation makes it, and gets a new sample to work on.
		const x = containerOf(body, choice, at);
		if (!x) return fail(NO_FIT);
		return plan(body, [
			() => x,
			({ made }) => ({ type: 'wire', from: { key: made[0], row: 0 }, to: { key: item.key } }),
			() => ({ type: 'addSample' }),
			({ made }) => ({ type: 'wire', from: { key: made[1] }, to: { key: made[0], row: 0 } }),
		]);
	}
	if (node.type !== 'container') return fail(NO_FIT);
	const no = insertRefusal(body, node);
	if (no) return fail(no.reason, no.locked);
	// A stack of passes is one card of several operations: its input is the first pass's, its output the last's.
	const keys = draftKeysOfNode(body, node);
	const own = body.items.find((i) => i.key === (where === 'before' ? keys[0] : keys[keys.length - 1]));
	if (!own || own.kind === 'sample') return fail(node.planned ? SAVED_WIRE : DONE_WIRE, !node.planned);
	if (where === 'after' && own.existing) return fail(SAVED_WIRE);
	const wires = wiresOn(graph, node, where === 'before' ? 'in' : 'out');
	if (wires.length > 1) return fail(SEVERAL_WIRES);
	if (wires.length === 1) return insertOnWire(body, graph, wires[0].id, choice, at);
	if (where === 'after' && own.kind === 'test') return fail(TEST_AFTER);
	const x = containerOf(body, choice, at);
	if (!x) return fail(NO_FIT);
	if (where === 'before') {
		// Nothing feeds it: an operation makes a new sample, and that sample feeds it.
		return plan(body, [
			() => x,
			({ made }) => ({ type: 'addSample', from: { key: made[0], row: 0 } }),
			({ made }) => ({ type: 'wire', from: { key: made[1] }, to: { key: own.key, row: 0 } }),
		]);
	}
	// A pass works in place and has no sample of its own coming out (its way back to the sample it took in is not an output): the operation
	// is wired to the pass's row itself, as an operation after an operation.
	if (own.kind === 'operation' && isPass(body, own)) return plan(body, [() => ({ ...x, from: { key: own.key, row: 0 }, at })]);
	// Nothing leaves it: a new sample comes out of it, and the operation works on that.
	return plan(body, [() => ({ type: 'addSample', from: { key: own.key, row: 0 }, at }), ({ made }) => ({ ...x, from: { key: made[0] } })]);
}
