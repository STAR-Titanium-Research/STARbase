// Builds the ELK graph for the Process map's layout (spec §6.7). Pure; no Vue, no elkjs runtime import.

import type { ElkNode, ElkPort } from 'elkjs/lib/elk-api';
import { fanRootId } from './buildGraph';
import { isBundleSocket } from './sockets';
import type { MapNode, ProcessGraph } from './types';

export type Dir = 'RIGHT' | 'DOWN';
export type Sizes = Record<string, { width: number; height: number }>;

const PORT_SIZE = 12;
/** Used until Vue Flow has measured a node (it reports 0x0 before that, so non-positive means unmeasured). */
const FALLBACK_SIZE = { width: 160, height: 60 };
const measured = (s: { width: number; height: number } | undefined) => !!s && s.width > 0 && s.height > 0;

/** Row order, a socket shared by rows once, the bundle socket last. */
function ordered(sockets: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const s of sockets) if (s) seen.add(s);
  const all = [...seen];
  return [...all.filter((s) => !isBundleSocket(s)), ...all.filter(isBundleSocket)];
}

function socketsOf(node: MapNode): { ins: string[]; outs: string[] } {
  switch (node.type) {
    case 'record':
      return { ins: ordered(node.ins), outs: ordered(node.outs) };
    case 'container':
      return { ins: ordered(node.rows.map((r) => r.in)), outs: ordered(node.rows.map((r) => r.out)) };
    case 'junction':
      return { ins: [node.in], outs: node.outs.map((o) => o.socket) };
    case 'more':
      // Only for the layout (nothing is drawn): the stub hangs from its record so it ends its column.
      return { ins: [`${node.id}:in:0`], outs: [] };
  }
}

export function elkInput(graph: ProcessGraph, shown: Set<string>, sizes: Sizes, dir: Dir): ElkNode {
  const sides = dir === 'RIGHT' ? { in: 'WEST', out: 'EAST' } : { in: 'NORTH', out: 'SOUTH' };
  const port = (id: string, side: string): ElkPort => ({
    id,
    width: PORT_SIZE,
    height: PORT_SIZE,
    layoutOptions: { 'elk.port.side': side },
  });

  const portIds = new Set<string>();
  const children: ElkNode[] = [];
  for (const node of graph.nodes) {
    if (!shown.has(node.id)) continue;
    const { ins, outs } = socketsOf(node);
    ins.forEach((s) => portIds.add(s));
    outs.forEach((s) => portIds.add(s));
    const size = measured(sizes[node.id]) ? sizes[node.id] : FALLBACK_SIZE;
    children.push({
      id: node.id,
      width: size.width,
      height: size.height,
      ports: [...ins.map((s) => port(s, sides.in)), ...outs.map((s) => port(s, sides.out))],
      // A container's sockets are its rows, in order. A record's or junction's only have a side: their order is socketOrder's job (from where the wires go).
      ...(node.type === 'container'
        ? { layoutOptions: { 'elk.portConstraints': 'FIXED_ORDER' } }
        : node.type === 'more'
          ? {}
          : { layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE' } }),
    });
  }

  const edges = graph.wires
    .filter((w) => portIds.has(w.from) && portIds.has(w.to))
    .map((w) => ({ id: w.id, sources: [w.from], targets: [w.to] }));
  for (const node of graph.nodes) {
    if (node.type !== 'more' || !shown.has(node.id)) continue;
    const at = node.of.indexOf(':');
    const from = `${fanRootId({ collection: node.of.slice(0, at), id: node.of.slice(at + 1) })}:out:0`;
    if (portIds.has(from)) edges.push({ id: `${node.id}:layout`, sources: [from], targets: [`${node.id}:in:0`] });
  }
  // A used-in fan is a list in a given order (newest first): ELK keeps the order of the nodes it is given.
  const isFan = graph.nodes.some((n) => n.type === 'more' || (n.type === 'container' && n.collapsed));

  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': dir,
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
      'elk.spacing.nodeNode': '36',
      'elk.edgeRouting': 'SPLINES',
      ...(isFan ? { 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES' } : {}),
    },
    children,
    edges,
  };
}
