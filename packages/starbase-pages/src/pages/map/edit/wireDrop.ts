// What dropping a dragged wire on a socket means (E8), decided without the DOM: orients the two sockets (a wire runs from an
// output to an input, whichever end the person dragged from), resolves them against the draft, and asks the reducer's own rules
// (`wireProblem`) whether it fits, so the refusal shown as a tooltip is the reducer's reason. A sample of the loaded history
// that the draft does not hold yet is tried as if it were in the draft (the page adds it, with its version, when the wire is made).

import type { DraftBody } from '@d1/ui';
import { apply, wireProblem, type WireEnd } from './draft';
import { resolveEnd, sampleItemOf, type SocketRef } from './socketRefs';

export interface DropVerdict {
	ok: boolean;
	/** In the words of the lab, when it is refused. */
	reason?: string;
	/** The two sockets as a wire runs: the output, then the input. */
	from?: SocketRef;
	to?: SocketRef;
}

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
	const a = resolveEnd(trial, from);
	const b = resolveEnd(trial, to);
	if (!a || !b) return { ok: false, reason: 'That card is recorded already, not part of the draft.', from, to };
	const reason = wireProblem(trial, a, b);
	return reason ? { ok: false, reason, from, to } : { ok: true, from, to };
}

/** The wire a verdict stands for, resolved against the body the page has after adding any sample the wire needs. */
export function wireOf(body: DraftBody, v: DropVerdict): { from: WireEnd; to: WireEnd } | null {
	if (!v.ok || !v.from || !v.to) return null;
	const from = resolveEnd(body, v.from);
	const to = resolveEnd(body, v.to);
	return from && to ? { from, to } : null;
}
