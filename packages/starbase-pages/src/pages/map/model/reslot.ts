// What a fold or an unfold of a container does to the cards on its sockets (spec §6.7): its sockets are other sockets now, in row
// order, so the cards on them swap places until their order along the cross axis is the sockets' order and no wire crosses.
// Pure: boxes in, new places out.
//
// No ELK offsets are involved. The cards on one side of the container (the ones that are not dragged) keep the cross-axis places
// they already occupy, as a set, and are dealt them again in the order of the sockets; each card keeps its own flow-axis place,
// so it stays in its own area of the map. A dragged card keeps its place and its slot is left out of the dealing, and so does a
// card that is also on the sockets of another container with several (it would break that one's order). The cards are placed one
// after the other in socket order, each at its slot or just clear of the one before, and never on a card that stays.

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
  /** Every container drawn: a card that is also on another one's sockets is not dealt again here. */
  containers?: ContainerNode[];
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

  // A neighbour on a socket of another container whose order matters there (it has several sockets on that side) is left where
  // it is, like a dragged one: dealing it again here could cross that container's wires.
  const shared = new Set<string>();
  for (const other of input.containers ?? []) {
    if (other.id === container.id) continue;
    for (const side of ['in', 'out'] as const) {
      const sockets = socketsOf(other, side);
      if (sockets.length < 2) continue;
      for (const w of wires) {
        if (sockets.includes(side === 'in' ? w.to : w.from)) shared.add(nodeOfSocket(side === 'in' ? w.from : w.to));
      }
    }
  }

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
  const lists = sides.map((side) => side.filter((id) => !dragged.has(id) && !both.has(id) && !shared.has(id)));

  // Cards that are dealt again leave the obstacles; each is put back where it lands. Everything else stays an obstacle.
  const dealt = new Set(lists.flat());
  const obstacles: Box[] = Object.entries(boxes).filter(([id]) => !dealt.has(id)).map(([, b]) => ({ ...b }));
  const out: Record<string, Point> = {};
  for (const list of lists) {
    const slots = list.map((id) => axis.start(boxes[id])).sort((a, b) => a - b);
    // In socket order, one after the other: a card takes its slot unless the one before it reaches past that, and never lies on
    // what stays. So the order of the sockets is the order along the axis, whatever the sizes.
    let prevEnd = -Infinity;
    list.forEach((id, i) => {
      const box = { ...boxes[id] };
      axis.set(box, Math.max(slots[i], prevEnd + GAP));
      for (let guard = 0; guard < obstacles.length + 1; guard++) {
        const hit = obstacles.filter((o) => overlaps(box, o)).sort((x, y) => axis.end(y) - axis.end(x))[0];
        if (!hit) break;
        axis.set(box, axis.end(hit) + GAP);
      }
      prevEnd = axis.end(box);
      obstacles.push(box);
      if (box.x !== boxes[id].x || box.y !== boxes[id].y) out[id] = { x: box.x, y: box.y };
    });
  }
  return out;
}
