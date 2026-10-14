// Builds the ELK graph for the Process map's layout (spec §6.7). Pure; no Vue, no elkjs runtime import.

import type { ElkNode, ElkPort } from 'elkjs/lib/elk-api';
import { isBundleSocket } from './sockets';
import type { MapNode, ProcessGraph } from './types';

export type Dir = 'RIGHT' | 'DOWN';
export type Sizes = Record<string, { width: number; height: number }>;

const PORT_SIZE = 12;
/** Used until Vue Flow has measured a node. */
const FALLBACK_SIZE = { width: 160, height: 60 };

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
    const size = sizes[node.id] ?? FALLBACK_SIZE;
    children.push({
      id: node.id,
      width: size.width,
      height: size.height,
      ports: [...ins.map((s) => port(s, sides.in)), ...outs.map((s) => port(s, sides.out))],
      ...(node.type === 'container' ? { layoutOptions: { 'elk.portConstraints': 'FIXED_ORDER' } } : {}),
    });
  }

  const edges = graph.wires
    .filter((w) => portIds.has(w.from) && portIds.has(w.to))
    .map((w) => ({ id: w.id, sources: [w.from], targets: [w.to] }));

  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': dir,
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
      'elk.spacing.nodeNode': '36',
      'elk.edgeRouting': 'SPLINES',
    },
    children,
    edges,
  };
}
