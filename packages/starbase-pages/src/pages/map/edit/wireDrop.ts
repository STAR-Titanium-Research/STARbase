// What dropping a dragged wire on a socket means (E8), decided without the DOM: orients the two sockets (a wire runs from an
// output to an input, whichever end the person dragged from), resolves them against the draft, and asks the reducer's own rules
// (`wireProblem`) whether it fits, so the refusal shown as a tooltip is the reducer's reason. A sample of the loaded history
// that the draft does not hold yet is tried as if it were in the draft (the page adds it, with its version, when the wire is made).

import type { DraftBody } from '@d1/ui';
import { apply, wireProblem, type DraftAction, type WireEnd } from './draft';
import { grown, resolveEnd, sampleItemOf, type SocketRef } from './socketRefs';

export interface DropVerdict {
	ok: boolean;
	/** In the words of the lab, when it is refused. */
	reason?: string;
	/** The two sockets as a wire runs: the output, then the input. */
	from?: SocketRef;
	to?: SocketRef;
}

/** The sockets of a verdict that add a row: the connection makes it first (`connectActions`). */
const adds = (v: DropVerdict): SocketRef[] => [v.from, v.to].filter((s): s is SocketRef => !!s?.add);

/** A sample the draft does not hold yet, tried as an existing sample of version 0 on a copy of the body. */
function withSample(body: DraftBody, s: SocketRef): DraftBody {
	return s.kind === 'sample' && !sampleItemOf(body, s.id) ? apply(body, { type: 'addExistingSamples', samples: [{ id: s.id, version: 0 }] }) : body;
}

/** The two sockets in wire order and whether the pair can be a wire; `reason` says why not. */
export function dropVerdict(body: DraftBody, dragged: SocketRef, target: SocketRef): DropVerdict {
	if (dragged.side === target.side) {
		return { ok: false, reason: dragged.side === 'out' ? 'Drop an output on an input socket.' : 'Drop an input on an output socket.' };
	}
	const from = dragged.side === 'out' ? dragged : target;
	const to = dragged.side === 'out' ? target : dragged;
	// A sample in the loaded history cannot be made by an operation, and a recorded operation cannot be fed: say so plainly.
	if (to.kind === 'sample' && !sampleItemOf(body, to.id)) return { ok: false, reason: 'That sample already exists with its own history: it cannot be made by this operation.', from, to };
	let trial = body;
	trial = withSample(trial, from);
	trial = withSample(trial, to);
	// A free socket that stands for a new row: the draft as it would be with the row.
	for (const s of [from, to]) {
		if (!s.add) continue;
		const g = grown(trial, s);
		if (!g) return { ok: false, reason: 'Only a new operation can take another row.', from, to };
		trial = g.body;
	}
	const a = resolveEnd(trial, from);
	const b = resolveEnd(trial, to);
	if (!a || !b) return { ok: false, reason: 'That card is recorded already, not part of the draft.', from, to };
	const reason = wireProblem(trial, a, b);
	return reason ? { ok: false, reason, from, to } : { ok: true, from, to };
}

/**
 * The wire a verdict stands for, resolved against the body the page has after adding any sample the wire needs (and, for a socket that
 * adds a row, after the row: see `connectActions`).
 */
export function wireOf(body: DraftBody, v: DropVerdict): { from: WireEnd; to: WireEnd } | null {
	if (!v.ok || !v.from || !v.to) return null;
	const from = resolveEnd(body, v.from);
	const to = resolveEnd(body, v.to);
	return from && to ? { from, to } : null;
}

/**
 * What connecting a verdict does to the draft, in order: the row a free socket stands for (when one does), then the wire. Null when it
 * cannot be made. The result is one undoable step.
 */
export function connectActions(body: DraftBody, v: DropVerdict): DraftAction[] | null {
	if (!v.ok) return null;
	let at = body;
	const out: DraftAction[] = [];
	for (const s of adds(v)) {
		const g = grown(at, s);
		if (!g?.action) return null;
		out.push(g.action);
		at = g.body;
	}
	const wire = wireOf(at, v);
	return wire ? [...out, { type: 'wire', ...wire }] : null;
}
