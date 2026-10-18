// Where a new node goes (redesign spec R6): the nearest free slot beside what it was attached to, never on top of another node. Pure: boxes in,
// a position out, so it is tested without a canvas, and the same boxes always give the same place (an undo that takes a node away gives its
// slot back to the next one asked for).
//
// A slot is a rectangle the size of the node, kept `GAP` clear of every other node. Candidates are the grid of slots beside the anchor: in
// the direction the flow runs first (to its right when the map runs left to right, below it when it runs top to bottom), then further on,
// then the other side. They are tried nearest first, so a node lands beside what it came from and only goes further when that is taken.

import type { Dir } from './elkInput';
import type { Box, Point, Size } from './placeMerged';

export type { Box, Point, Size };

/** Clear space kept between two nodes. */
export const GAP = 28;
/** The gap between an anchor and the slot beside it along the flow (room for the wire). */
export const SLOT_GAP = GAP * 3;

/** True when the two boxes are closer than `gap` (or overlap). */
export const tooClose = (a: Box, b: Box, gap = GAP): boolean => a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;

/** True when `box` is too close to any of `others`. */
export const hitsAny = (box: Box, others: readonly Box[], gap = GAP): boolean => others.some((o) => tooClose(box, o, gap));

/** How many steps out the grid of candidate slots goes before the place below everything is used. */
const MAX_STEPS = 14;

/** Offsets 0, 1, -1, 2, -2, ...: the cross-axis steps from the anchor, down (or right) first. */
const steps = (n: number): number[] => Array.from({ length: n * 2 + 1 }, (_, i) => (i === 0 ? 0 : i % 2 ? (i + 1) / 2 : -i / 2));

/**
 * The top-left of a free slot of `size`, nearest to the one beside `anchor` (null: beside `near`, else the origin). `existing` is every
 * box on the canvas the new node must keep clear of. Always finds one: past the grid it goes below everything.
 */
export function placeNode(anchor: Box | null, existing: readonly Box[], size: Size, opts: { dir?: Dir; near?: Point } = {}): Point {
	const right = (opts.dir ?? 'RIGHT') === 'RIGHT';
	const from: Box = anchor ?? { x: opts.near?.x ?? 0, y: opts.near?.y ?? 0, width: 0, height: 0 };
	/** Room between the anchor and a slot along the flow: none at all for a bare point, where the node goes at the point itself. */
	const gapAfter = anchor ? SLOT_GAP : 0;
	const gapBefore = anchor ? SLOT_GAP : GAP;
	// Two axes: `main` is the way the flow runs, `cross` the way nodes of one layer stack.
	const main = right ? { start: from.x, len: from.width, size: size.width } : { start: from.y, len: from.height, size: size.height };
	const cross = right ? { start: from.y, size: size.height } : { start: from.x, size: size.width };
	const at = (m: number, c: number): Point => (right ? { x: m, y: c } : { x: c, y: m });
	const pitch = { main: main.size + GAP, cross: cross.size + GAP };
	const n = Math.min(MAX_STEPS, existing.length + 1);
	const ideal = at(main.start + main.len + gapAfter, cross.start);

	interface Candidate {
		at: Point;
		cost: number;
		order: number;
	}
	const candidates: Candidate[] = [];
	for (const side of [1, -1] as const) {
		for (let col = 0; col <= n; col++) {
			// Forward: beside the anchor and then further on. Backward: before it (a node that comes earlier), dearer, so tried after.
			const m = side === 1 ? main.start + main.len + gapAfter + col * pitch.main : main.start - gapBefore - main.size - col * pitch.main;
			for (const k of steps(n)) {
				const p = at(m, cross.start + k * pitch.cross);
				candidates.push({ at: p, cost: Math.hypot(p.x - ideal.x, p.y - ideal.y) + (side === -1 ? pitch.main : 0), order: candidates.length });
			}
		}
	}
	candidates.sort((a, b) => a.cost - b.cost || a.order - b.order);
	for (const c of candidates) {
		if (!hitsAny({ x: c.at.x, y: c.at.y, width: size.width, height: size.height }, existing)) return c.at;
	}
	// Nothing in the grid: past everything there is, across the way nodes stack.
	const end = existing.reduce((m, b) => Math.max(m, right ? b.y + b.height : b.x + b.width), 0);
	return right ? { x: ideal.x, y: end + GAP } : { x: end + GAP, y: ideal.y };
}

export interface SettleInput {
	/** Where every node is now (or is about to be): fixed ones as they stand, movable ones as the layout would put them. */
	boxes: Readonly<Record<string, Box>>;
	/** The nodes that may move, in the order they are looked at; any other is where it stays. */
	movable: readonly string[];
	/** The box of the node a movable one is attached to (the one it grew out of), when it has one; else it moves as little as it can. */
	anchors?: Readonly<Record<string, Box | undefined>>;
	dir?: Dir;
}

/**
 * Moves the nodes of `movable` that lie on another node to their nearest free slot, one after the other (each sees the ones before it at
 * their final places). Returns only the nodes that moved. A node that is clear stays exactly where it is.
 */
export function settleNodes(input: SettleInput): Record<string, Point> {
	const movable = new Set(input.movable);
	const placed: Box[] = Object.entries(input.boxes)
		.filter(([id]) => !movable.has(id))
		.map(([, b]) => b);
	const moved: Record<string, Point> = {};
	for (const id of input.movable) {
		const box = input.boxes[id];
		if (!box) continue;
		if (!hitsAny(box, placed)) {
			placed.push(box);
			continue;
		}
		const at = placeNode(input.anchors?.[id] ?? box, placed, { width: box.width, height: box.height }, { dir: input.dir });
		moved[id] = at;
		placed.push({ ...at, width: box.width, height: box.height });
	}
	return moved;
}

export interface TidyInput {
	/** ELK's top-left for every node of the graph (the layout the page already uses). */
	elk: Readonly<Record<string, Point>>;
	/** Measured size of every node. */
	sizes: Readonly<Record<string, Size>>;
	/** The nodes that are not the draft's: where they are now. They never move. */
	fixed: Readonly<Record<string, Box>>;
	/** The draft's own nodes, and where they are now. */
	owned: Readonly<Record<string, Point>>;
	dir?: Dir;
}

const median = (xs: number[]): number => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Tidy: where the draft's own nodes go when they are laid out again by ELK. The nodes that are not the draft's stay where they are; ELK's
 * arrangement of the draft's nodes is moved to line up with them (the median offset of ELK's places from the real ones), or, with nothing
 * else on the canvas, to the top-left corner the draft's nodes have now. No node ends on another. Returns a place for every owned node.
 */
export function tidyPositions(input: TidyInput): Record<string, Point> {
	const ownedIds = Object.keys(input.owned).filter((id) => input.elk[id] && input.sizes[id]);
	if (!ownedIds.length) return {};
	const fixedIds = Object.keys(input.fixed).filter((id) => input.elk[id]);
	let shift: Point;
	if (fixedIds.length) {
		shift = { x: median(fixedIds.map((id) => input.fixed[id].x - input.elk[id].x)), y: median(fixedIds.map((id) => input.fixed[id].y - input.elk[id].y)) };
	} else {
		shift = {
			x: Math.min(...ownedIds.map((id) => input.owned[id].x)) - Math.min(...ownedIds.map((id) => input.elk[id].x)),
			y: Math.min(...ownedIds.map((id) => input.owned[id].y)) - Math.min(...ownedIds.map((id) => input.elk[id].y)),
		};
	}
	const boxes: Record<string, Box> = { ...input.fixed };
	for (const id of ownedIds) boxes[id] = { x: input.elk[id].x + shift.x, y: input.elk[id].y + shift.y, ...input.sizes[id] };
	const order = [...ownedIds].sort((a, b) => boxes[a].x - boxes[b].x || boxes[a].y - boxes[b].y || (a < b ? -1 : 1));
	const moved = settleNodes({ boxes, movable: order, dir: input.dir });
	return Object.fromEntries(ownedIds.map((id) => [id, moved[id] ?? { x: boxes[id].x, y: boxes[id].y }]));
}
