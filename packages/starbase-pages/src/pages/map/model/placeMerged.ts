// Where the nodes go after an expand or a merge (spec §6.7): cards already on the map keep their places
// (a dragged card stays where it was dropped), and only the new cards are laid out, so that they do not
// overlap anything. Pure: ELK's positions for the whole graph come in, final positions of the cards that
// move go out. A full Re-layout does not come through here.
//
// New cards keep ELK's arrangement among themselves. A group of new cards wired to a card that is already
// placed is shifted so that it lines up with that card; a group wired to nothing placed (the used-in fan of
// a record in an Inside tray) is put beside the card the person expanded. A card that grew (a collapsed
// container that was opened) keeps its place and pushes the placed cards it now overlaps along the cross
// axis, instead of lying on top of them.

import type { Dir } from './elkInput';

export interface Point {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
export type Box = Point & Size;

export interface PlaceInput {
  /** ELK's top-left for every drawn node. */
  elk: Record<string, Point>;
  /** Measured size of every drawn node now. */
  sizes: Record<string, Size>;
  /** Cards already on the map: where they are now (a drag included) and their size when they were placed. */
  placed: Record<string, Box>;
  /** Wires between drawn nodes, as node ids. */
  edges: { from: string; to: string }[];
  dir: Dir;
  /** The cards the person expanded (on the map before and after); usually one, more when two expands share a layout. */
  anchors?: string[];
  /** Cards the person dragged: a card that grew never pushes these aside (they stay where they were dropped). */
  pinned?: ReadonlySet<string>;
}

/** Room kept between cards the layout moves. */
const GAP = 28;
/** A card whose size changed by less than this did not grow. */
const GROWN = 2;

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width + GAP && b.x < a.x + a.width + GAP && a.y < b.y + b.height + GAP && b.y < a.y + a.height + GAP;

/** The cross axis is the one nodes of a layer stack along: y when the flow runs right, x when it runs down. */
const cross = (dir: Dir) =>
  dir === 'RIGHT'
    ? { start: (b: Box) => b.y, end: (b: Box) => b.y + b.height, set: (b: Box, v: number): void => void (b.y = v) }
    : { start: (b: Box) => b.x, end: (b: Box) => b.x + b.width, set: (b: Box, v: number): void => void (b.x = v) };

export function placeMerged(input: PlaceInput): Record<string, Point> {
  const { elk, sizes, placed, edges, dir } = input;
  const axis = cross(dir);
  const out: Record<string, Point> = {};

  // The boxes now: placed cards at their current place and their current size, new cards come below.
  const fixed = new Map<string, Box>();
  for (const [id, b] of Object.entries(placed)) {
    const size = sizes[id];
    if (size) fixed.set(id, { x: b.x, y: b.y, width: size.width, height: size.height });
  }

  // 1. A card that grew pushes the placed cards it now overlaps, and those push the next ones.
  const queue: string[] = [];
  for (const [id, box] of fixed) {
    const was = placed[id];
    if (Math.abs(box.width - was.width) > GROWN || Math.abs(box.height - was.height) > GROWN) queue.push(id);
  }
  const moved = new Set<string>();
  for (let guard = 0; queue.length && guard < fixed.size * fixed.size + 8; guard++) {
    const id = queue.shift()!;
    const box = fixed.get(id)!;
    for (const [otherId, other] of fixed) {
      if (otherId === id || input.pinned?.has(otherId) || !overlaps(box, other) || axis.start(other) < axis.start(box)) continue;
      axis.set(other, axis.end(box) + GAP);
      moved.add(otherId);
      queue.push(otherId);
    }
  }
  for (const id of moved) out[id] = { x: fixed.get(id)!.x, y: fixed.get(id)!.y };

  // 2. The new cards in ELK's arrangement, grouped by the wires among them.
  const fresh = Object.keys(elk).filter((id) => !fixed.has(id) && sizes[id]);
  const freshSet = new Set(fresh);
  const parent = new Map(fresh.map((id) => [id, id]));
  const find = (id: string): string => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)!)!);
      id = parent.get(id)!;
    }
    return id;
  };
  for (const e of edges) if (freshSet.has(e.from) && freshSet.has(e.to)) parent.set(find(e.from), find(e.to));
  const groups = new Map<string, string[]>();
  for (const id of fresh) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);

  /** How far ELK is from where the placed cards are, over all placed cards ELK also laid out. */
  const global: Point = {
    x: median([...fixed].filter(([id]) => elk[id]).map(([id, b]) => b.x - elk[id].x)),
    y: median([...fixed].filter(([id]) => elk[id]).map(([id, b]) => b.y - elk[id].y)),
  };
  const anchorIds = (input.anchors ?? []).filter((id) => fixed.has(id));

  const target = new Map<string, Box>();
  for (const members of groups.values()) {
    const set = new Set(members);
    // Placed cards wired to this group: the group lines up with them.
    const neighbours = new Set<string>();
    for (const e of edges) {
      if (set.has(e.from) && fixed.has(e.to) && elk[e.to]) neighbours.add(e.to);
      if (set.has(e.to) && fixed.has(e.from) && elk[e.from]) neighbours.add(e.from);
    }
    let shift: Point = global;
    if (neighbours.size) {
      const ns = [...neighbours];
      shift = { x: median(ns.map((n) => fixed.get(n)!.x - elk[n].x)), y: median(ns.map((n) => fixed.get(n)!.y - elk[n].y)) };
    } else if (anchorIds.length) {
      // Nothing placed to line up with: beside the expanded card, keeping the group's own arrangement.
      const x0 = Math.min(...members.map((m) => elk[m].x));
      const y0 = Math.min(...members.map((m) => elk[m].y));
      // With several expanded cards, the one ELK has nearest to the group.
      const near = anchorIds.filter((id) => elk[id]).sort((p, q) => Math.hypot(elk[p].x - x0, elk[p].y - y0) - Math.hypot(elk[q].x - x0, elk[q].y - y0))[0] ?? anchorIds[0];
      const anchorBox = fixed.get(near)!;
      const at = dir === 'RIGHT' ? { x: anchorBox.x + anchorBox.width + GAP * 3, y: anchorBox.y } : { x: anchorBox.x, y: anchorBox.y + anchorBox.height + GAP * 3 };
      shift = { x: at.x - x0, y: at.y - y0 };
    }
    for (const m of members) target.set(m, { x: elk[m].x + shift.x, y: elk[m].y + shift.y, ...sizes[m] });
  }

  // 3. Nothing new on top of anything: step along the cross axis past what it lies on.
  const obstacles: Box[] = [...fixed.values()];
  const order = [...target].sort(([, a], [, b]) => (dir === 'RIGHT' ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x));
  for (const [id, box] of order) {
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
