// Does an entry of the catalog fit a socket it is dropped on (redesign R2)? The same rules as the add search opened at that socket (menuModel.ts
// decides what it lists) and as dropping a wire on a socket (wireDrop.ts): a refusal is in the words of the lab, the draft's own reason when
// it is the reducer that says no. Pure, no DOM.

import type { DraftBody } from '@d1/ui';
import type { ProcessGraph } from '../model/types';
import { apply, newKeys, wireProblem, type DraftAction } from './draft';
import { actionsFor, menuFor, type MenuChoice, type MenuFor } from './menuModel';
import { DONE_WIRE, SAVED_WIRE } from './removal';
import { grown, resolveEnd, type SocketRef } from './socketRefs';

/**
 * Why an action did not do what it says, or null when it did. An action with nothing changed was refused; a new card that was to be wired
 * to an end (`from`) and was not (the reducer adds the card and drops a wire that does not fit) is refused with the wire's reason.
 */
export function refusal(before: DraftBody, after: DraftBody, action: DraftAction): string | null {
	if (after === before) return action.type === 'wire' ? (wireProblem(before, action.from, action.to) ?? NO_FIT) : NO_FIT;
	if ((action.type === 'addSample' || action.type === 'addContainer') && action.from && after.wires.length <= before.wires.length) {
		const made = newKeys(before, after)[0];
		return (made && wireProblem(after, action.from, { key: made, row: 0 })) || NO_FIT;
	}
	return null;
}
const NO_FIT = 'That does not fit there.';

export interface AddVerdict {
	ok: boolean;
	/** In the words of the lab, when it is refused. */
	reason?: string;
}

/** Why `choice` cannot be dropped on a socket of this kind (its card and side). */
export function misfit(f: MenuFor, choice: MenuChoice): string | null {
	const { side, card } = f;
	switch (choice.kind) {
		case 'operation':
			if (card === 'sample') return null;
			return side === 'out' ? 'An operation\'s output takes a sample, not another operation. Drop a New sample on it.' : 'An input takes a sample, not an operation. Drop a New sample on it.';
		case 'test':
			if (side === 'out' && card === 'sample') return null;
			if (side === 'out' && card === 'test') return 'A test has no output.';
			if (side === 'in' && card === 'sample') return 'A sample\'s input takes the operation that makes it. A test does not make a sample.';
			return 'An input takes a sample, not a test. Drop a New sample on it.';
		case 'newSample':
			if (card === 'sample') return side === 'out' ? 'A sample\'s output takes an operation or a test. Samples are joined through an operation.' : 'A sample is made by an operation. Drop an operation on its input.';
			if (card === 'test' && side === 'out') return 'A test has no output.';
			return null;
		case 'fromDatabase':
		case 'attachOperation':
			// A recorded operation with no input takes a sample in: it hangs off a sample's output.
			return side === 'out' && card === 'sample' ? null : 'A recorded operation is attached to a sample\'s output. Drop From database… on one, or on the empty canvas.';
		default:
			return 'That cannot be dropped on a socket.';
	}
}

/** A card that is neither a sample of the loaded history nor part of the draft, and nothing else is known about it. */
export const NOT_IN_DRAFT = 'That card is not part of the draft.';

/**
 * Why a socket of a recorded operation or test (not in the draft) takes nothing: a done record's wires are locked, a planned one's belong to
 * records that are already saved. The page asks it of the drawn graph.
 */
export function recordedSocketReason(graph: ProcessGraph | null | undefined, sock: SocketRef): string {
	const node = graph?.nodes.find((n) => n.type === 'container' && n.group.rowIds.includes(sock.id));
	return node?.type === 'container' ? (node.planned ? SAVED_WIRE : DONE_WIRE) : NOT_IN_DRAFT;
}

/**
 * The verdict for dropping `choice` on `sock` of the draft. A sample of the loaded history that the draft does not hold yet is judged by what
 * kind of card it is (the page adds it, with its version, when the drop is made); a socket of the draft is also tried on a copy of the body, so
 * a wire the draft would refuse (an input that already has a sample) is refused here with its reason.
 */
export function socketVerdict(body: DraftBody, sock: SocketRef, choice: MenuChoice, why: (sock: SocketRef) => string = () => NOT_IN_DRAFT): AddVerdict {
	const f = menuFor(body, sock);
	const bad = misfit(f, choice);
	if (bad) return { ok: false, reason: bad };
	// The picker decides which operation: the drop only has to be on a sample's output.
	if (choice.kind === 'fromDatabase') return { ok: true };
	const g = grown(body, sock);
	if (!g) return { ok: false, reason: 'Only a new operation can take another row.' };
	// A sample of the loaded history: it joins the draft first when something is built from its output; nothing can make it.
	if (!f.end) {
		if (sock.kind !== 'sample') return { ok: false, reason: why(sock) };
		return sock.side === 'in' ? { ok: false, reason: 'That sample already exists with its own history: it cannot be made by this operation.' } : { ok: true };
	}
	const actions = actionsFor({ body: g.body, end: resolveEnd(g.body, sock), side: f.side, card: f.card }, choice);
	if (!actions.length) return { ok: false, reason: 'That does not fit there.' };
	let cur = g.body;
	for (const a of actions) {
		const next = apply(cur, a);
		const why = refusal(cur, next, a);
		if (why) return { ok: false, reason: why };
		cur = next;
	}
	return { ok: true };
}
