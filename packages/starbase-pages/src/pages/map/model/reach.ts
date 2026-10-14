// Which nodes the Process map shows for a reach setting (spec D19). Pure: no Vue, no I/O.
// Reach only limits what is shown; the whole family stays loaded.

import { nodeOfSocket } from './sockets';
import type { MapNode, ProcessGraph } from './types';

/** Cards that are only ever drawn beside the node they feed. */
function isSource(node: MapNode): boolean {
  return (
    node.type === 'record' &&
    (node.kind === 'stock_lot' || node.kind === 'powder_batch' || node.kind === 'material')
  );
}

const isProcess = (node: MapNode) => node.type === 'container' || node.type === 'junction';

/**
 * Node ids shown when `reach` steps are taken from the focus node, over wires in both directions.
 * One step is one process step: from a card across a container (or junction) costs 1, and the
 * container is shown together with the samples on its other sides. Containers wired directly to each
 * other (in-place work and tests on one sample) cost 1 per container. A focus that is itself a
 * container or junction starts with the samples it touches. Stock lot, powder batch and material
 * cards next to any shown node are always shown, and are never walked through (a lot does not pull
 * in the other samples it fed).
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
  /** Sample cards next to a node (not source cards, not other processes). */
  const cardsAround = (id: string) => around(id).filter((other) => !isProcess(byId.get(other)!));
  /** Neighbours that are not source cards. */
  const around = (id: string) => [...(neighbours.get(id) ?? [])].filter((other) => !isSource(byId.get(other)!));

  const shown = new Set([focusNodeId]);
  const show = (id: string, added: string[]) => {
    if (shown.has(id)) return;
    shown.add(id);
    added.push(id);
  };

  let frontier = [focusNodeId];
  if (isProcess(byId.get(focusNodeId)!)) for (const side of cardsAround(focusNodeId)) show(side, frontier);

  for (let step = 0; step < reach && frontier.length; step++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of around(id)) {
        if (!isProcess(byId.get(other)!)) continue; // a card beside a process is shown with it
        show(other, next);
        for (const side of cardsAround(other)) show(side, next);
      }
    }
    frontier = next;
  }

  for (const id of [...shown]) {
    for (const other of neighbours.get(id) ?? []) {
      if (isSource(byId.get(other)!)) shown.add(other);
    }
  }
  return shown;
}
