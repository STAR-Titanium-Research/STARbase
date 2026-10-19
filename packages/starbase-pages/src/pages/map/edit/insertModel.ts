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
//   an earlier step    a DONE sample is never given a parent: a new planned sample -> operation -> new sample chain starts upstream of it,
//                      unwired to it. The done record's lineage is untouched (R3).
//
// A wire of records that are done (or saved) is never touched: the answer is the lock reason of removal.ts (R4).

import type { DraftBody, DraftKey } from '@d1/ui';
import { nodeOfSocket } from '../model/sockets';
import type { MapNode, ProcessGraph } from '../model/types';
import { refusal } from './addDrop';
import { apply, backEdge, newKeys, type DraftAction, type Pos, type WireEnd } from './draft';
import { actionsFor, type MenuChoice } from './menuModel';
import { DONE_WIRE, SAVED_WIRE, unwireVerdict } from './removal';
import { draftKeyOfNode, sampleItemOf } from './socketRefs';

export type InsertVerdict = { ok: true; actions: DraftAction[] } | { ok: false; reason: string; locked: boolean };

const fail = (reason: string, locked = false): InsertVerdict => ({ ok: false, reason, locked });

export const NO_FIT = 'That does not fit there.';
export const TEST_BETWEEN = 'A test has nothing coming out of it, so it cannot go between two cards.';
export const SAMPLE_BETWEEN = 'A sample goes between operations. Drop an operation here, or drop the sample on empty canvas.';
export const SEVERAL_WIRES = 'Several wires meet here. Drop it on the wire you mean.';
export const TEST_AFTER = 'A test has nothing coming out of it, so nothing can come after it.';

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
 */
export function insertOnDraftWires(body: DraftBody, wires: Wire[], choice: MenuChoice, at?: Pos): InsertVerdict {
	const real = wires.filter((w) => !backEdge(body, w));
	if (real.length !== 1) return fail(real.length ? SEVERAL_WIRES : NO_FIT);
	const wire = real[0];
	const from = body.items.find((i) => i.key === wire.from.key);
	const to = body.items.find((i) => i.key === wire.to.key);
	if (!from || !to) return fail(NO_FIT);
	if (choice.kind === 'test') return fail(TEST_BETWEEN);
	if (choice.kind === 'newSample') {
		if (from.kind !== 'operation' || to.kind === 'sample') return fail(SAMPLE_BETWEEN);
		return plan(body, [...unwires(wires), () => ({ type: 'addSample', from: wire.from, at }), ({ made }) => ({ type: 'wire', from: { key: made[0] }, to: wire.to })]);
	}
	if (choice.kind !== 'operation') return fail(NO_FIT);
	const x = containerOf(body, choice, at);
	if (!x) return fail(NO_FIT);
	if (from.kind === 'sample' && to.kind !== 'sample') {
		return plan(body, [
			...unwires(wires),
			() => ({ ...x, from: wire.from }),
			({ made }) => ({ type: 'addSample', from: { key: made[0], row: 0 } }),
			({ made }) => ({ type: 'wire', from: { key: made[1] }, to: wire.to }),
		]);
	}
	if (from.kind === 'operation' && to.kind === 'sample') {
		return plan(body, [
			...unwires(wires),
			() => ({ type: 'addSample', from: wire.from }),
			({ made }) => ({ ...x, from: { key: made[0] } }),
			({ made }) => ({ type: 'wire', from: { key: made[1], row: 0 }, to: wire.to }),
		]);
	}
	if (from.kind === 'operation') {
		return plan(body, [...unwires(wires), () => ({ ...x, from: wire.from }), ({ made }) => ({ type: 'wire', from: { key: made[0], row: 0 }, to: wire.to })]);
	}
	return fail(NO_FIT);
}

/** The drawn wire `wireId`, as the draft's wires between those two cards: or why the draft cannot change it (done wiring, saved records). */
export function insertOnWire(body: DraftBody, graph: ProcessGraph, wireId: string, choice: MenuChoice, at?: Pos): InsertVerdict {
	const v = unwireVerdict(body, graph, wireId);
	return v.ok ? insertOnDraftWires(body, v.wires, choice, at) : fail(v.reason, v.locked);
}

/** What R3 adds to a done sample: a chain that starts upstream (a new planned sample, an operation of no method yet, the sample it makes), joined to nothing. */
export function earlierStep(body: DraftBody, at?: Pos): InsertVerdict {
	return plan(body, [
		() => ({ type: 'addSample', at }),
		({ made }) => ({ type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: made[0] } }),
		({ made }) => ({ type: 'addSample', from: { key: made[1], row: 0 } }),
	]);
}

/** The drawn wires on one side of a card. */
const wiresOn = (graph: ProcessGraph, node: MapNode, side: 'in' | 'out') => graph.wires.filter((w) => nodeOfSocket(side === 'in' ? w.to : w.from) === node.id);

/**
 * Insert before or after a drawn card, without dragging. A sample of the loaded history must already be an item of the draft (the page adds
 * it first). `choice` is an operation (or a new sample for a container's side), or `earlierStep` for a done sample.
 */
export function insertAround(o: { body: DraftBody; graph: ProcessGraph; node: MapNode; where: 'before' | 'after'; choice: MenuChoice; at?: Pos }): InsertVerdict {
	const { body, graph, node, where, choice, at } = o;
	if (node.type === 'record' && node.kind === 'sample') {
		// The earlier step does not touch the done sample, so it does not even need to be part of the draft.
		if (choice.kind === 'earlierStep') return where === 'before' && !node.draft && !node.planned ? earlierStep(body, at) : fail(NO_FIT);
		const item = sampleItemOf(body, node.ref.id);
		if (!item) return fail('That sample is not part of the draft yet.');
		// A done sample is never given a parent, whatever is chosen: the earlier step is the only way before it.
		if (where === 'before' && !node.draft && !node.planned) return fail(DONE_WIRE, true);
		const wires = wiresOn(graph, node, where === 'before' ? 'in' : 'out');
		if (wires.length > 1 && where === 'before') return fail(SEVERAL_WIRES);
		if (wires.length === 1) return insertOnWire(body, graph, wires[0].id, choice, at);
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
	const key = draftKeyOfNode(body, node);
	const own = key ? body.items.find((i) => i.key === key) : undefined;
	if (!own || own.kind === 'sample') return fail(node.planned ? SAVED_WIRE : DONE_WIRE, !node.planned);
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
	// Nothing leaves it: a new sample comes out of it, and the operation works on that.
	return plan(body, [() => ({ type: 'addSample', from: { key: own.key, row: 0 }, at }), ({ made }) => ({ ...x, from: { key: made[0] } })]);
}
