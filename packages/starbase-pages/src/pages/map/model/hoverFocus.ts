// What the pointer's target lights up on the Process map (spec §6.3, D17). Hovering a card or a record in
// a card's Inside tray keeps that card, what it is wired to and those wires bright and dims the rest;
// hovering a wire or a socket only highlights the wires involved (its tooltip says the rest). A selected
// card lights up its whole chain instead (`chainFocus`). Pure.

import type { MapNode, ProcessGraph, Wire } from './types';
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

/** Which way a selected card's chain is lit: what its samples came from, what they went on to, or both. */
export type ChainDir = 'up' | 'down' | 'both';

/**
 * The sockets on the far side of a node from `socket`: walking `up`, the inputs that feed this output;
 * walking `down`, the outputs this input feeds. A container answers row by row, so a cut's piece leads back
 * to the one input and not across to its sibling pieces; any other card passes everything through.
 */
function across(node: MapNode | undefined, socket: string, dir: 'up' | 'down'): string[] {
  if (!node) return [];
  switch (node.type) {
    case 'container':
      return node.rows.filter((r) => (dir === 'up' ? r.out : r.in) === socket).flatMap((r) => (dir === 'up' ? r.in : r.out) ?? []);
    case 'record':
      return dir === 'up' ? node.ins : node.outs;
    case 'junction':
      return dir === 'up' ? [node.in] : node.outs.map((o) => o.socket);
    default:
      return [];
  }
}

/** The sockets a walk starts from on the selected card itself. */
function ownSockets(node: MapNode, dir: 'up' | 'down'): string[] {
  switch (node.type) {
    case 'container':
      return node.rows.flatMap((r) => (dir === 'up' ? r.in : r.out) ?? []);
    case 'record':
      return dir === 'up' ? node.ins : node.outs;
    case 'junction':
      return dir === 'up' ? [node.in] : node.outs.map((o) => o.socket);
    default:
      return [];
  }
}

/**
 * A selected card's chain: walk the wires upstream from its inputs (what its samples came from) and/or
 * downstream from its outputs (what they went on to), through each card on the way. Unrelated branches
 * (a sibling piece of a cut and what was done to it) stay dim.
 */
export function chainFocus(graph: ProcessGraph, id: string | null, dir: ChainDir = 'both'): HoverFocus | null {
  const start = id ? graph.nodes.find((n) => n.id === id) : undefined;
  if (!start) return null;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const into = new Map<string, Wire[]>();
  const outOf = new Map<string, Wire[]>();
  for (const w of graph.wires) {
    into.set(w.to, [...(into.get(w.to) ?? []), w]);
    outOf.set(w.from, [...(outOf.get(w.from) ?? []), w]);
  }
  const nodes = new Set([start.id]);
  const wires = new Set<string>();

  const walk = (way: 'up' | 'down') => {
    const seen = new Set<string>();
    const queue = [...ownSockets(start, way)]; // a copy: a record's own ins/outs must not be emptied
    while (queue.length) {
      const socket = queue.pop()!;
      if (seen.has(socket)) continue;
      seen.add(socket);
      for (const w of (way === 'up' ? into : outOf).get(socket) ?? []) {
        wires.add(w.id);
        const far = way === 'up' ? w.from : w.to;
        const farNode = nodeOfSocket(far);
        nodes.add(farNode);
        queue.push(...across(byId.get(farNode), far, way));
      }
    }
  };
  if (dir !== 'down') walk('up');
  if (dir !== 'up') walk('down');
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
