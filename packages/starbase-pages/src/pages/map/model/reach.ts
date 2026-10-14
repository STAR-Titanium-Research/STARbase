// Which nodes the Process map shows for a reach setting (spec D19). Pure: no Vue, no I/O.
// Reach only limits what is shown; the whole family stays loaded.

import { nodeOfSocket } from './buildGraph';
import type { MapNode, ProcessGraph } from './types';

/** Cards that are only ever drawn beside the node they feed. */
function isSource(node: MapNode): boolean {
  return (
    node.type === 'record' &&
    (node.kind === 'stock_lot' || node.kind === 'powder_batch' || node.kind === 'material')
  );
}

/**
 * Node ids shown when `reach` steps are taken from the focus node, over wires in both directions. A
 * container is one node, so crossing it is one step however many rows it has. Stock lot, powder
 * batch, material and junction nodes next to a shown node are always shown; source cards are never
 * walked through (a lot does not pull in the other samples it fed).
 */
export function shownNodes(graph: ProcessGraph, focusNodeId: string, reach: number | 'all'): Set<string> {
  if (reach === 'all') return new Set(graph.nodes.map((n) => n.id));

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  if (!byId.has(focusNodeId)) return new Set();

  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a)!.add(b);
  };
  for (const w of graph.wires) {
    const from = nodeOfSocket(w.from);
    const to = nodeOfSocket(w.to);
    if (!byId.has(from) || !byId.has(to)) continue;
    link(from, to);
    link(to, from);
  }

  const shown = new Set([focusNodeId]);
  let frontier = [focusNodeId];
  for (let step = 0; step < reach && frontier.length; step++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of neighbours.get(id) ?? []) {
        if (shown.has(other) || isSource(byId.get(other)!)) continue;
        shown.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }

  for (const id of [...shown]) {
    for (const other of neighbours.get(id) ?? []) {
      const node = byId.get(other)!;
      if (isSource(node) || node.type === 'junction') shown.add(other);
    }
  }
  return shown;
}
