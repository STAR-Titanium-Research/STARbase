// The text of a wire's hover tooltip (spec D17): the sample it carries, where it comes from, where it
// goes. Plain lines; WireEdge's page-level tooltip joins them. Pure.

import { LINEAGE_LABEL, KINDS } from './kinds';
import { nodeOfSocket } from '../model/sockets';
import type { MapNode, Wire } from '../model/types';

/** What a node is called in a tooltip: its code, or for a junction the lineage type. */
export function nodeLabel(node: MapNode | undefined): string | null {
	if (!node) return null;
	if (node.type === 'junction') return LINEAGE_LABEL[node.lineageType];
	return node.type === 'record' ? node.ref.code : node.code;
}

/**
 * `["S-0412-A · Sample", "from OP-17", "into OP-18"]`. The first line only when the wire carries a
 * sample; a line is left out when its node is not in `nodesById` (hidden by the reach).
 */
export function wireTooltip(wire: Wire, nodesById: ReadonlyMap<string, MapNode>): string[] {
	const lines: string[] = [];
	if (wire.carries) {
		const sample = nodesById.get(`s:${wire.carries}`);
		const code = sample?.type === 'record' ? sample.ref.code : wire.carries;
		lines.push(`${code} · ${KINDS.sample.label}`);
	}
	const from = nodeLabel(nodesById.get(wire.origin));
	if (from) lines.push(`from ${from}`);
	const into = nodeLabel(nodesById.get(nodeOfSocket(wire.to)));
	if (into) lines.push(`into ${into}`);
	return lines;
}
