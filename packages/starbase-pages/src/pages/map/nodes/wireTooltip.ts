// The text of a wire's hover tooltip (spec D17): the sample it carries, where it comes from, where it
// goes. Plain lines; WireEdge's page-level tooltip joins them. Pure.

import { LINEAGE_LABEL, KINDS } from './kinds';
import { nodeOfSocket } from '../model/sockets';
import type { MapNode, Wire } from '../model/types';

/** What a node is called in a tooltip: its code, else its title (an unnamed batch), or for a junction the lineage type. */
export function nodeLabel(node: MapNode | undefined): string | null {
	if (!node) return null;
	if (node.type === 'junction') return LINEAGE_LABEL[node.lineageType];
	if (node.type === 'more') return null;
	return node.type === 'record' ? node.ref.code : node.code || node.title;
}

/**
 * `["S-0412-A · Sample", "from OP-17", "into OP-18"]`. The first line only when the wire carries a
 * sample that is drawn; a line is left out when its node is not in `nodesById` (hidden by the reach):
 * a raw id is never shown.
 */
export function wireTooltip(wire: Wire, nodesById: ReadonlyMap<string, MapNode>): string[] {
	const lines: string[] = [];
	if (wire.carries) {
		const sample = nodesById.get(`s:${wire.carries}`);
		if (sample?.type === 'record') lines.push(`${sample.ref.code} · ${KINDS.sample.label}`);
	}
	const from = nodeLabel(nodesById.get(wire.origin));
	if (from) lines.push(`from ${from}`);
	const into = nodeLabel(nodesById.get(nodeOfSocket(wire.to)));
	if (into) lines.push(`into ${into}`);
	return lines;
}

/**
 * What hovering a socket lists (spec D17): one `"<code> · <kind>"` line per wire on it, the sample the
 * wire carries or, for a stock wire, the lot, powder batch or material it comes from. A wire whose
 * subject is not drawn adds no line; a socket with nothing to name says why.
 */
export function socketTooltip(socket: string, wires: readonly Wire[], nodesById: ReadonlyMap<string, MapNode>): string[] {
	const lines: string[] = [];
	let any = false;
	for (const w of wires) {
		if (w.from !== socket && w.to !== socket) continue;
		any = true;
		const subject = w.carries ? nodesById.get(`s:${w.carries}`) : nodesById.get(w.origin);
		if (subject?.type !== 'record') continue;
		const line = `${subject.ref.code} · ${KINDS[subject.kind].label}`;
		if (!lines.includes(line)) lines.push(line);
	}
	return lines.length ? lines : [any ? 'Connected records are not shown' : 'Not connected'];
}
