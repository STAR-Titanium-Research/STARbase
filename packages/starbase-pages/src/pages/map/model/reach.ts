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
 * container or junction starts with the samples it touches; a source card starts with what it feeds. Stock lot, powder batch and material
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
  const focus = byId.get(focusNodeId)!;
  if (isProcess(focus)) for (const side of cardsAround(focusNodeId)) show(side, frontier);
  else if (isSource(focus)) {
    // A source card starts like a process: what it feeds is at distance 0, with that container's cards.
    for (const fed of around(focusNodeId)) {
      show(fed, frontier);
      if (isProcess(byId.get(fed)!)) for (const side of cardsAround(fed)) show(side, frontier);
    }
  }

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

/** Soft cap on the cards the map draws (spec D22). */
export const CARD_CAP = 300;

export type Reach = 1 | 2 | 3 | 'all';

/** The nodes shown at `reach`, stepped down 3, 2, 1 while more than CARD_CAP would show (spec D22). */
export function fitReach(graph: ProcessGraph, focusNodeId: string, reach: Reach): { ids: Set<string>; effective: Reach; clamped: boolean } {
  let ids = shownNodes(graph, focusNodeId, reach);
  let effective = reach;
  if (ids.size <= CARD_CAP) return { ids, effective, clamped: false };
  for (const step of [3, 2, 1] as const) {
    if (reach !== 'all' && step >= reach) continue;
    effective = step;
    ids = shownNodes(graph, focusNodeId, step);
    if (ids.size <= CARD_CAP) break;
  }
  return { ids, effective, clamped: true };
}
