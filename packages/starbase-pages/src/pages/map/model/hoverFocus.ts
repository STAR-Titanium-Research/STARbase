// What the pointer's target lights up on the Process map (spec §6.3, D17). Hovering a card or a record in
// a card's Inside tray keeps that card, what it is wired to and those wires bright and dims the rest;
// hovering a wire or a socket only highlights the wires involved (its tooltip says the rest). Pure.

import type { ProcessGraph, Wire } from './types';
import { nodeOfSocket } from './sockets';
import { refKey } from '../nodes/actions';

export interface HoverFocus {
  /** True when everything outside `nodes` dims (a card or slot is hovered). */
  dim: boolean;
  /** Nodes that stay bright. */
  nodes: Set<string>;
  /** Wires drawn highlighted. */
  wires: Set<string>;
}

/** The wires that enter or leave a socket. */
export const wiresAtSocket = (graph: ProcessGraph, socket: string): Wire[] => graph.wires.filter((w) => w.from === socket || w.to === socket);

/** `id` is what the page's hover takes: a node id, a record in a slot, a wire id or a socket id; null for anything else. */
export function hoverFocus(graph: ProcessGraph, id: string | null): HoverFocus | null {
  if (!id) return null;
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  const wire = graph.wires.find((w) => w.id === id);
  if (wire) return { dim: false, nodes: new Set(), wires: new Set([wire.id]) };

  const atSocket = wiresAtSocket(graph, id);
  if (atSocket.length && !nodeIds.has(id)) return { dim: false, nodes: new Set(), wires: new Set(atSocket.map((w) => w.id)) };

  // A card, or the cards that hold a record shown inside them.
  const owners = nodeIds.has(id)
    ? [id]
    : graph.nodes.filter((n) => n.type === 'container' && n.slots.some((s) => [s.ref, ...(s.values ?? [])].some((r) => r && refKey(r) === id))).map((n) => n.id);
  if (!owners.length) return null;
  const mine = new Set(owners);
  const nodes = new Set(owners);
  const wires = new Set<string>();
  for (const w of graph.wires) {
    const from = nodeOfSocket(w.from);
    const to = nodeOfSocket(w.to);
    if (!mine.has(from) && !mine.has(to)) continue;
    wires.add(w.id);
    nodes.add(from);
    nodes.add(to);
  }
  return { dim: true, nodes, wires };
}

/**
 * The node ids a hovered socket's wires touch (their ends, where they come from, the sample they
 * carry): the rail highlights these in Connections (spec D17).
 */
export function socketSubjects(graph: ProcessGraph, socket: string): Set<string> {
  const out = new Set<string>();
  for (const w of wiresAtSocket(graph, socket)) {
    out.add(nodeOfSocket(w.from));
    out.add(nodeOfSocket(w.to));
    out.add(w.origin);
    if (w.carries) out.add(`s:${w.carries}`);
  }
  return out;
}
