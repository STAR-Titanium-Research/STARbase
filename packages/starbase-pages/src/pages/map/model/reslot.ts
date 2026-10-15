// What a fold or an unfold of a container does to the cards on its sockets (spec §6.7): its sockets are other sockets now, in row
// order, so the cards on them swap places until their order along the cross axis is the sockets' order and no wire crosses.
// Pure: boxes in, new places out.
//
// No ELK offsets are involved. The cards on one side of the container (the ones that are not dragged) keep the cross-axis places
// they already occupy, as a set, and are dealt them again in the order of the sockets; each card keeps its own flow-axis place,
// so it stays in its own area of the map. A dragged card keeps its place and its slot is left out of the dealing. Only if a
// card now lies on another (cards of different sizes in each other's slots) is it stepped along the cross axis past what it lies on.

import type { Dir } from './elkInput';
import { GAP, cross, overlaps, type Box, type Point } from './placeMerged';
import { isBundleSocket, nodeOfSocket } from './sockets';
import type { ContainerNode } from './types';

export interface ReslotInput {
  container: ContainerNode;
  /** Wires between drawn nodes, as socket ids. */
  wires: { from: string; to: string }[];
  /** Where every drawn card is now, and its size. */
  boxes: Record<string, Box>;
  /** Cards the person dragged: they stay where they are. */
  dragged: ReadonlySet<string>;
  dir: Dir;
}

/** The sockets of one side in row order, each once, the bundle socket last (the order the container draws and ELK is given). */
function socketsOf(container: ContainerNode, side: 'in' | 'out'): string[] {
  const seen = new Set<string>();
  for (const r of container.rows) {
    const s = side === 'in' ? r.in : r.out;
    if (s) seen.add(s);
  }
  const all = [...seen];
  return [...all.filter((s) => !isBundleSocket(s)), ...all.filter(isBundleSocket)];
}

/** The new places of the cards that move (only those). */
export function reslot(input: ReslotInput): Record<string, Point> {
  const { container, wires, boxes, dragged, dir } = input;
  const axis = cross(dir);
  const sides = (['in', 'out'] as const).map((side) => {
    const sockets = socketsOf(container, side);
    const rank = new Map(sockets.map((s, i) => [s, i]));
    const found = new Map<string, number>(); // neighbour -> the first socket (in row order) it is on
    for (const w of wires) {
      const mine = side === 'in' ? w.to : w.from;
      const other = nodeOfSocket(side === 'in' ? w.from : w.to);
      const r = rank.get(mine);
      if (r === undefined || other === container.id || !boxes[other]) continue;
      found.set(other, Math.min(found.get(other) ?? r, r));
    }
    // Cards on one socket (a bundle's) have no order of their own: they keep the order they have along the axis.
    return [...found].sort(([a, ra], [b, rb]) => ra - rb || axis.start(boxes[a]) - axis.start(boxes[b])).map(([id]) => id);
  });
  // A card on both sides (a loop) belongs to neither: it stays.
  const both = new Set(sides[0].filter((id) => sides[1].includes(id)));

  const out: Record<string, Point> = {};
  const now = new Map<string, Box>(Object.entries(boxes).map(([id, b]) => [id, { ...b }]));
  const moved: string[] = [];
  for (const side of sides) {
    const list = side.filter((id) => !dragged.has(id) && !both.has(id));
    const slots = list.map((id) => axis.start(boxes[id])).sort((a, b) => a - b);
    list.forEach((id, i) => {
      if (axis.start(boxes[id]) === slots[i]) return;
      axis.set(now.get(id)!, slots[i]);
      moved.push(id);
    });
  }

  // Nothing on top of anything: a card that now lies on another steps along the cross axis past it.
  const placed = new Set(moved);
  const obstacles: Box[] = [...now].filter(([id]) => !placed.has(id)).map(([, b]) => b);
  for (const id of [...moved].sort((a, b) => axis.start(now.get(a)!) - axis.start(now.get(b)!))) {
    const box = now.get(id)!;
    for (let guard = 0; guard < obstacles.length + 1; guard++) {
      const hit = obstacles.filter((o) => overlaps(box, o)).sort((a, b) => axis.end(b) - axis.end(a))[0];
      if (!hit) break;
      axis.set(box, axis.end(hit) + GAP);
    }
    obstacles.push(box);
    out[id] = { x: box.x, y: box.y };
  }
  return out;
}
