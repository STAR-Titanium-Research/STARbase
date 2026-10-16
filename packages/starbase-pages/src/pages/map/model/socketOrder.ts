// The cleanest order of the sockets on a card, so that wires do not cross where they leave or enter it (spec §6.7).
// Pure: a card, the wires, where every card is and how big it is go in; the same card with its sockets re-ordered comes out.
//
// A record card and a junction card draw their sockets in the order of `ins` / `outs` (a junction: its output rows), spread along the
// edge in that order. ELK is only told which side a port is on, so the model's order is not the order along the card the wires want.
// Each side is sorted by where the other end of its wires is on the cross axis (y when the flow runs right, x when it runs down):
//   - the other end's socket when that is a container row (spread along the container's edge the way edgeStyle does), else the
//     other card's centre;
//   - a socket with several wires takes the average of its other ends;
//   - ties keep their original order; a socket whose other end is not drawn (or has no place yet) keeps its own slot; the bundle
//     socket stays last.
// One pass, no iteration. A container is never re-ordered: its rows are its socket order (ELK keeps them FIXED_ORDER).

import type { Dir } from './elkInput';
import type { Point, Size } from './placeMerged';
import { isBundleSocket, nodeOfSocket } from './sockets';
import type { JunctionNode, MapNode, RecordNode } from './types';

/** The sockets of a container on one side in row order, each once, the bundle socket last (the order ContainerNode draws them). */
function containerSockets(node: MapNode, side: 'in' | 'out'): string[] {
  if (node.type !== 'container') return [];
  const seen = new Set<string>();
  for (const r of node.rows) {
    const s = side === 'in' ? r.in : r.out;
    if (s) seen.add(s);
  }
  const all = [...seen];
  return [...all.filter((s) => !isBundleSocket(s)), ...all.filter(isBundleSocket)];
}

/**
 * Re-orders `ids` (the sockets of one side of the card): the sockets that have a place to sort by are dealt, in the order of that
 * place, into the slots those sockets held; the others (and the bundle socket) stay where they are.
 */
function sortSide(all: string[], keyOf: (socket: string) => number | null): string[] {
  const ids = [...all.filter((s) => !isBundleSocket(s)), ...all.filter(isBundleSocket)]; // the bundle socket is last whatever order it came in
  const keyed = ids.map((id, i) => ({ id, i, key: isBundleSocket(id) ? null : keyOf(id) })).filter((s): s is { id: string; i: number; key: number } => s.key !== null);
  const sorted = [...keyed].sort((a, b) => a.key - b.key || a.i - b.i);
  const out = [...ids];
  keyed.forEach((slot, n) => (out[slot.i] = sorted[n].id));
  return out;
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function socketOrder(
  node: MapNode,
  wires: readonly { from: string; to: string }[],
  positions: Readonly<Record<string, Point>>,
  sizes: Readonly<Record<string, Size>>,
  dir: Dir,
  /** Every drawn node by id: needed only to find a container's row sockets (without it a container counts by its centre). */
  nodes: ReadonlyMap<string, MapNode> = new Map(),
): MapNode {
  if (node.type !== 'record' && node.type !== 'junction') return node;
  const x = dir === 'DOWN';

  /** Where along the cross axis the other end of `wire` is: its socket on a container, else its card's centre; null when not placed. */
  const otherEnd = (socket: string): number | null => {
    const id = nodeOfSocket(socket);
    const at = positions[id];
    const size = sizes[id];
    if (!at || !size) return null;
    const start = x ? at.x : at.y;
    const length = x ? size.width : size.height;
    const other = nodes.get(id);
    if (other?.type === 'container') {
      const side = socket.includes(':out:') ? 'out' : 'in';
      const list = containerSockets(other, side);
      const i = list.indexOf(socket);
      if (i >= 0) return start + ((i + 1) / (list.length + 1)) * length;
    }
    return start + length / 2;
  };

  /** The sort key of one of this card's sockets: the average over its wires' other ends. */
  const keyOf = (side: 'in' | 'out') => (socket: string): number | null => {
    const ends: number[] = [];
    for (const w of wires) {
      const far = side === 'in' ? (w.to === socket ? w.from : null) : w.from === socket ? w.to : null;
      if (far === null || nodeOfSocket(far) === node.id) continue;
      const k = otherEnd(far);
      if (k !== null) ends.push(k);
    }
    return ends.length ? ends.reduce((s, k) => s + k, 0) / ends.length : null;
  };

  if (node.type === 'record') {
    const ins = sortSide(node.ins, keyOf('in'));
    const outs = sortSide(node.outs, keyOf('out'));
    if (same(ins, node.ins) && same(outs, node.outs)) return node;
    return { ...node, ins, outs } satisfies RecordNode;
  }
  const order = sortSide(
    node.outs.map((o) => o.socket),
    keyOf('out'),
  );
  if (same(order, node.outs.map((o) => o.socket))) return node;
  const bySocket = new Map(node.outs.map((o) => [o.socket, o]));
  return { ...node, outs: order.map((s) => bySocket.get(s)!) } satisfies JunctionNode;
}
