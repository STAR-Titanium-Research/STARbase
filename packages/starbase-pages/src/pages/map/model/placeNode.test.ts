import { describe, expect, it } from 'vitest';
import { GAP, SLOT_GAP, hitsAny, placeNode, settleNodes, tidyPositions, tooClose, type Box } from './placeNode';

const box = (x: number, y: number, width = 264, height = 120): Box => ({ x, y, width, height });
const SIZE = { width: 264, height: 120 };
const at = (p: { x: number; y: number }): Box => ({ ...p, ...SIZE });

/** A small deterministic generator, so the crowded cases are the same on every run. */
function rng(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 1664525 + 1013904223) % 4294967296;
		return s / 4294967296;
	};
}

describe('tooClose and hitsAny', () => {
	it('two boxes are too close when they overlap or are nearer than the gap', () => {
		expect(tooClose(box(0, 0), box(100, 10))).toBe(true);
		expect(tooClose(box(0, 0), box(264 + GAP - 1, 0))).toBe(true);
		expect(tooClose(box(0, 0), box(264 + GAP, 0))).toBe(false);
		expect(tooClose(box(0, 0), box(0, 120 + GAP))).toBe(false);
		expect(hitsAny(box(0, 0), [])).toBe(false);
		expect(hitsAny(box(0, 0), [box(1000, 1000), box(10, 10)])).toBe(true);
	});
});

describe('placeNode', () => {
	it('puts a node beside its anchor, along the flow, level with it, when nothing is in the way', () => {
		const anchor = box(100, 200);
		expect(placeNode(anchor, [anchor], SIZE)).toEqual({ x: 100 + 264 + SLOT_GAP, y: 200 });
		expect(placeNode(anchor, [anchor], SIZE, { dir: 'DOWN' })).toEqual({ x: 100, y: 200 + 120 + SLOT_GAP });
	});

	it('goes below the first slot, then above, when the one beside the anchor is taken', () => {
		const anchor = box(0, 0);
		const first = placeNode(anchor, [anchor], SIZE);
		const second = placeNode(anchor, [anchor, at(first)], SIZE);
		expect(second).toEqual({ x: first.x, y: first.y + 120 + GAP });
		const third = placeNode(anchor, [anchor, at(first), at(second)], SIZE);
		expect(third).toEqual({ x: first.x, y: first.y - 120 - GAP });
	});

	it('stacks the nodes of one anchor in the column beside it, nearest first, then starts the next column', () => {
		const anchor = box(0, 0);
		const existing: Box[] = [anchor];
		const placed: { x: number; y: number }[] = [];
		for (let i = 0; i < 5; i++) {
			const p = placeNode(anchor, existing, SIZE);
			placed.push(p);
			existing.push(at(p));
		}
		const first = anchor.x + 264 + SLOT_GAP;
		expect(placed.slice(0, 3).map((p) => p.x)).toEqual([first, first, first]);
		expect(placed.slice(0, 3).map((p) => p.y).sort((a, b) => a - b)).toEqual([-1, 0, 1].map((k) => k * (120 + GAP)));
		// Next, the level slot of the next column is nearer than the fourth step up or down.
		expect(placed[3]).toEqual({ x: first + 264 + GAP, y: 0 });
		for (const p of placed) expect(hitsAny(at(p), [anchor, ...placed.filter((q) => q !== p).map(at)])).toBe(false);
	});

	it('uses the next column when a whole column beside the anchor is a wall', () => {
		const anchor = box(0, 0);
		// A wall of nodes right of the anchor, taller than the search steps.
		const wall = Array.from({ length: 41 }, (_, i) => box(264 + SLOT_GAP, (i - 20) * (120 + GAP)));
		const p = placeNode(anchor, [anchor, ...wall], SIZE);
		expect(hitsAny(at(p), [anchor, ...wall])).toBe(false);
		expect(p.x).toBeGreaterThan(264 + SLOT_GAP);
	});

	it('is beside the anchor on the other side when the way on is closed off and that is nearer', () => {
		const anchor = box(1000, 0);
		// A wall of columns right of the anchor, taller than the search reaches: the way on is closed for a long way.
		const block = Array.from({ length: 14 }, (_, i) => box(1000 + 264 + SLOT_GAP + i * 292, -2000, 264, 4000));
		const p = placeNode(anchor, [anchor, ...block], SIZE);
		expect(hitsAny(at(p), [anchor, ...block])).toBe(false);
		expect(p.x).toBeLessThan(anchor.x); // before it: nearer than going all the way round
	});

	it('never overlaps anything on a crowded canvas, however it got that way', () => {
		for (const seed of [1, 7, 42, 99, 12345]) {
			const rand = rng(seed);
			const existing: Box[] = Array.from({ length: 60 }, () => box(Math.floor(rand() * 2400), Math.floor(rand() * 1600), 150 + Math.floor(rand() * 200), 80 + Math.floor(rand() * 120)));
			for (let i = 0; i < 25; i++) {
				const anchor = existing[Math.floor(rand() * existing.length)];
				const size = { width: 150 + Math.floor(rand() * 200), height: 80 + Math.floor(rand() * 120) };
				const dir = i % 2 ? 'DOWN' : 'RIGHT';
				const p = placeNode(anchor, existing, size, { dir });
				expect(hitsAny({ ...p, ...size }, existing)).toBe(false);
				existing.push({ ...p, ...size });
			}
		}
	});

	it('finds a place on a canvas that is one solid block, past the grid', () => {
		const solid = Array.from({ length: 40 }, (_, r) => Array.from({ length: 40 }, (_, c) => box(c * (264 + GAP), r * (120 + GAP)))).flat();
		const p = placeNode(solid[0], solid, SIZE);
		expect(hitsAny(at(p), solid)).toBe(false);
		const down = placeNode(solid[0], solid, SIZE, { dir: 'DOWN' });
		expect(hitsAny(at(down), solid)).toBe(false);
	});

	it('handles nodes of different sizes: the new one clears a tall neighbour', () => {
		const anchor = box(0, 0, 100, 60);
		const tall = box(100 + SLOT_GAP, -50, 300, 600);
		const p = placeNode(anchor, [anchor, tall], { width: 200, height: 90 });
		expect(hitsAny({ ...p, width: 200, height: 90 }, [anchor, tall])).toBe(false);
	});

	it('with no anchor, goes at the point given, or beside it when that is taken, else at the origin', () => {
		expect(placeNode(null, [], SIZE)).toEqual({ x: 0, y: 0 });
		expect(placeNode(null, [], SIZE, { near: { x: 500, y: 300 } })).toEqual({ x: 500, y: 300 });
		const taken = box(500, 300);
		const p = placeNode(null, [taken], SIZE, { near: { x: 500, y: 300 } });
		expect(hitsAny(at(p), [taken])).toBe(false);
		expect(Math.hypot(p.x - 500, p.y - 300)).toBeLessThan(700);
	});

	it('gives the same place for the same boxes: asking again, or asking after an undo, changes nothing', () => {
		const anchor = box(0, 0);
		const a = at(placeNode(anchor, [anchor], SIZE));
		const b = placeNode(anchor, [anchor, a], SIZE);
		// A second node was added, then undone: the board is what it was, and so is the answer.
		expect(placeNode(anchor, [anchor, a], SIZE)).toEqual(b);
		// The first one undone: its slot is free again for whoever comes next.
		expect(placeNode(anchor, [anchor], SIZE)).toEqual({ x: a.x, y: a.y });
		// Redo puts both back where they were.
		expect(placeNode(anchor, [anchor, a], SIZE)).toEqual(b);
	});

	it('ignores nothing it is told about: an existing node on the very slot is avoided', () => {
		const anchor = box(0, 0);
		const slot = at(placeNode(anchor, [anchor], SIZE));
		const p = placeNode(anchor, [anchor, slot], SIZE);
		expect(tooClose(at(p), slot)).toBe(false);
	});
});

describe('settleNodes', () => {
	it('leaves a node that is clear exactly where it is', () => {
		const boxes = { a: box(0, 0), b: box(1000, 0), c: box(0, 500) };
		expect(settleNodes({ boxes, movable: ['b', 'c'] })).toEqual({});
	});

	it('moves a node that lies on another to a free slot, and only that one', () => {
		const boxes = { a: box(0, 0), b: box(20, 10), c: box(2000, 2000) };
		const moved = settleNodes({ boxes, movable: ['b', 'c'] });
		expect(Object.keys(moved)).toEqual(['b']);
		expect(tooClose({ ...moved.b, ...SIZE }, boxes.a)).toBe(false);
	});

	it('moves it beside the node it is attached to when it has one', () => {
		const boxes = { a: box(0, 0), anchor: box(0, 600), b: box(10, 10) };
		const moved = settleNodes({ boxes, movable: ['b'], anchors: { b: boxes.anchor } });
		expect(moved.b.x).toBe(264 + SLOT_GAP);
		expect(moved.b.y).toBe(600);
	});

	it('the movable nodes clear each other too: each sees the ones before it where they ended up', () => {
		const boxes = { a: box(0, 0), m1: box(10, 10), m2: box(20, 20), m3: box(30, 30) };
		const moved = settleNodes({ boxes, movable: ['m1', 'm2', 'm3'] });
		const final: Box[] = [boxes.a, ...['m1', 'm2', 'm3'].map((id) => ({ ...(moved[id] ?? boxes[id as 'm1']), ...SIZE }))];
		for (let i = 0; i < final.length; i++) for (let j = i + 1; j < final.length; j++) expect(tooClose(final[i], final[j])).toBe(false);
	});

	it('a crowded canvas of fixed nodes and new ones: nothing overlaps afterwards', () => {
		const rand = rng(5);
		const boxes: Record<string, Box> = {};
		for (let i = 0; i < 40; i++) boxes[`f${i}`] = box(Math.floor(rand() * 1800), Math.floor(rand() * 1200));
		const fixedIds = Object.keys(boxes).filter((id) => !Object.entries(boxes).some(([o, b]) => o < id && tooClose(boxes[id], b)));
		const movable: string[] = [];
		for (let i = 0; i < 15; i++) {
			boxes[`n${i}`] = box(Math.floor(rand() * 1800), Math.floor(rand() * 1200));
			movable.push(`n${i}`);
		}
		// Only the fixed nodes that clear each other count as fixed (the rest are moved, too): the point is the movable ones end up clear of the fixed.
		const fixed = Object.fromEntries(fixedIds.map((id) => [id, boxes[id]]));
		const input = { boxes: { ...fixed, ...Object.fromEntries(movable.map((id) => [id, boxes[id]])) }, movable };
		const moved = settleNodes(input);
		const finalMovable = movable.map((id) => ({ ...(moved[id] ?? boxes[id]), ...SIZE }));
		for (const m of finalMovable) expect(hitsAny(m, Object.values(fixed))).toBe(false);
		for (let i = 0; i < finalMovable.length; i++) for (let j = i + 1; j < finalMovable.length; j++) expect(tooClose(finalMovable[i], finalMovable[j])).toBe(false);
	});

	it('is the same on every run, and unchanged by running it on its own answer', () => {
		const boxes = { a: box(0, 0), b: box(20, 10), c: box(40, 20) };
		const once = settleNodes({ boxes, movable: ['b', 'c'] });
		expect(settleNodes({ boxes, movable: ['b', 'c'] })).toEqual(once);
		const after = { a: boxes.a, b: { ...boxes.b, ...once.b }, c: { ...boxes.c, ...once.c } };
		expect(settleNodes({ boxes: after, movable: ['b', 'c'] })).toEqual({});
	});

	it('skips ids it has no box for', () => {
		expect(settleNodes({ boxes: { a: box(0, 0) }, movable: ['ghost'] })).toEqual({});
	});
});

describe('tidyPositions', () => {
	const sizes = { h1: SIZE, h2: SIZE, d1: SIZE, d2: SIZE, d3: SIZE };
	// ELK would put the history in a column at x 0 and the draft's three nodes in the next columns.
	const elk = { h1: { x: 0, y: 0 }, h2: { x: 0, y: 200 }, d1: { x: 400, y: 0 }, d2: { x: 800, y: 0 }, d3: { x: 800, y: 200 } };

	it('never moves what is not the draft\'s, and lines the draft\'s nodes up with it', () => {
		// The history has been dragged 1000 right and 50 down since ELK saw it.
		const fixed = { h1: box(1000, 50), h2: box(1000, 250) };
		const owned = { d1: { x: 5, y: 5 }, d2: { x: 9, y: 9 }, d3: { x: 11, y: 11 } };
		const out = tidyPositions({ elk, sizes, fixed, owned });
		expect(Object.keys(out).sort()).toEqual(['d1', 'd2', 'd3']);
		// The same arrangement ELK made, moved by the offset of the history.
		expect(out.d1).toEqual({ x: 1400, y: 50 });
		expect(out.d2).toEqual({ x: 1800, y: 50 });
		expect(out.d3).toEqual({ x: 1800, y: 250 });
	});

	it('clears anything in the way: the draft does not land on what is not its own', () => {
		const fixed = { h1: box(0, 0), h2: box(0, 200), other: box(400, 0) };
		const out = tidyPositions({ elk: { ...elk, other: { x: 0, y: 400 } }, sizes: { ...sizes, other: SIZE }, fixed, owned: { d1: { x: 0, y: 0 }, d2: { x: 0, y: 0 }, d3: { x: 0, y: 0 } } });
		const all = [...Object.values(fixed), ...Object.values(out).map(at)];
		for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(tooClose(all[i], all[j])).toBe(false);
	});

	it('with nothing else on the canvas, keeps the top-left corner the draft has now', () => {
		const out = tidyPositions({ elk, sizes, fixed: {}, owned: { d1: { x: 300, y: 200 }, d2: { x: 700, y: 200 }, d3: { x: 900, y: 900 } } });
		expect(out.d1).toEqual({ x: 300, y: 200 });
		expect(out.d2).toEqual({ x: 700, y: 200 });
	});

	it('does nothing for a draft with no nodes, and skips nodes ELK or the sizes do not know', () => {
		expect(tidyPositions({ elk, sizes, fixed: {}, owned: {} })).toEqual({});
		expect(tidyPositions({ elk, sizes, fixed: {}, owned: { ghost: { x: 0, y: 0 } } })).toEqual({});
	});

	it('gives the same answer twice', () => {
		const input = { elk, sizes, fixed: { h1: box(10, 10), h2: box(10, 210) }, owned: { d1: { x: 0, y: 0 }, d2: { x: 0, y: 0 }, d3: { x: 0, y: 0 } } };
		expect(tidyPositions(input)).toEqual(tidyPositions(input));
	});
});
