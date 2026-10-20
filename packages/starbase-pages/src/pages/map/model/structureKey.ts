// What the canvas builds its Vue Flow nodes, handles and edges from, boiled down to one string: two node lists with the same key
// differ only in what the cards say (a typed value, a status), never in which cards, sockets and wires there are. The canvas uses it
// in edit mode to patch card data in place instead of rebuilding the nodes and running ELK again on every keystroke.

import type { MapNode, Wire } from './types';

const socketsOf = (n: MapNode): string => {
	switch (n.type) {
		case 'record':
			return `${n.kind}|${n.ins.join(',')}|${n.outs.join(',')}`;
		case 'container':
			return `${n.kind}|${n.collapsed ? 'c' : ''}|${n.rows.map((r) => `${r.recordId}:${r.in ?? ''}:${r.out ?? ''}`).join(',')}`;
		case 'junction':
			return `${n.in}|${n.outs.map((o) => o.socket).join(',')}`;
		default:
			return '';
	}
};

export function structureKey(nodes: readonly MapNode[], wires: readonly Wire[]): string {
	return `${nodes.map((n) => `${n.id}#${n.type}#${socketsOf(n)}`).join(';')}@${wires.map((w) => `${w.id}:${w.from}>${w.to}`).join(';')}`;
}
