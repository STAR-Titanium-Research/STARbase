import { describe, expect, it } from 'vitest';
import { buildToolingModel, type EdgeRow, type InsertRow, type ToolingModel } from '@d1/ui';
import { buildTrayPlan, DOTS_UP_TO, insertDots, planDetail } from './plan2d';

const box = { tool_box_id: 'b1', tool_box_code: 'CNMG12-3' };
const ins = (n: number | null, extra: Partial<InsertRow> = {}): InsertRow => ({
	insert_id: `i${n ?? 'x'}`, insert_code: `X-${n ?? 'x'}`, insert_number: n, is_depleted: false, ...extra,
});
const edge = (i: string, l: string, used = false, extra: Partial<EdgeRow> = {}): EdgeRow => ({
	edge_id: `${i}${l}`, edge_code: `${i}-${l}`, insert_id: i, edge_identifier: l, is_used: used, ...extra,
});
const fourEdges = (i: string, used: string[] = []): EdgeRow[] => ['A', 'B', 'C', 'D'].map((l) => edge(i, l, used.includes(l)));
const numbered = (n: number): InsertRow[] => Array.from({ length: n }, (_, k) => ins(k + 1));
const model = (type: Record<string, unknown> | null, inserts: InsertRow[], edges: EdgeRow[] = [], code = box): ToolingModel =>
	buildToolingModel(code, type, inserts, edges);
const CNMG = { iso_designation: 'CNMG 12 04 08-MF', type_code: 'CNMG120408-MF' };
const R390 = { iso_designation: null, type_code: 'R390-11 T3 08M-MM S30T', nose_radius_mm: 0.8, fixing_hole_diameter_mm: 2.8 };

const bbox = (path: string): { x0: number; x1: number; y0: number; y1: number } => {
	const n = [...path.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => [Number(m[1]), Number(m[2])]);
	return { x0: Math.min(...n.map((p) => p[0])), x1: Math.max(...n.map((p) => p[0])), y0: Math.min(...n.map((p) => p[1])), y1: Math.max(...n.map((p) => p[1])) };
};

describe('buildTrayPlan: the layout mirrors the 3D tray', () => {
	const m = model(CNMG, numbered(10), numbered(10).flatMap((i) => fourEdges(i.insert_id)));
	const plan = buildTrayPlan(m, null);

	it('has a pocket per slot in the same columns and rows as the 3D layout, with the tray around them', () => {
		expect(plan.pockets).toHaveLength(10);
		const l = plan.layout;
		expect([l.columns, l.rows]).toEqual([2, 5]);
		const p0 = plan.pockets[0];
		const p1 = plan.pockets[1];
		const p2 = plan.pockets[2];
		expect(p1.x - p0.x).toBeCloseTo(l.pitch, 1);
		expect(p2.y - p0.y).toBeCloseTo(l.pitch, 1);
		expect(p0.w).toBeCloseTo(l.pocketW, 1);
		expect(plan.tray.w).toBeCloseTo(l.width, 1);
		expect(plan.tray.h).toBeCloseTo(l.depth, 1);
		for (const p of plan.pockets) {
			expect(p.x - p.w / 2).toBeGreaterThan(plan.tray.x);
			expect(p.x + p.w / 2).toBeLessThan(plan.tray.x + plan.tray.w);
			expect(p.y - p.h / 2).toBeGreaterThan(plan.tray.y);
			expect(p.y + p.h / 2).toBeLessThan(plan.tray.y + plan.tray.h);
		}
	});

	it('has a view box that holds the whole tray', () => {
		const [x, y, w, h] = plan.viewBox.split(' ').map(Number);
		expect(x).toBeLessThan(plan.tray.x);
		expect(y).toBeLessThan(plan.tray.y);
		expect(x + w).toBeGreaterThan(plan.tray.x + plan.tray.w);
		expect(y + h).toBeGreaterThan(plan.tray.y + plan.tray.h);
	});

	it('draws the insert\'s real outline, inside its pocket with room to spare, with corner 0 pointing up the page', () => {
		const b = bbox(plan.outline);
		expect(b.x0).toBeGreaterThan(-plan.layout.pocketW / 2 + 1);
		expect(b.x1).toBeLessThan(plan.layout.pocketW / 2 - 1);
		expect(b.y0).toBeGreaterThan(-plan.layout.pocketD / 2 + 1);
		expect(b.y1).toBeLessThan(plan.layout.pocketD / 2 - 1);
		expect(b.y0).toBeLessThan(-9); // a CNMG's nose, toward the top of the page like the 3D view's -z
		expect(plan.outline.endsWith('Z')).toBe(true);
		expect(plan.hole).toBeCloseTo(2.58, 1);
	});

	it('fits the outline of every common type inside its pocket', () => {
		for (const type of [CNMG, R390, { iso_designation: 'SNMG 12 04 08' }, { iso_designation: 'DNMG 15 06 08' }, { iso_designation: 'TNMG 16 04 08' }, { iso_designation: 'VBMT 16 04 08' }, { iso_designation: 'RCMT 10 T3 M0' }, { iso_designation: '???', edge_count: 5 }]) {
			const p = buildTrayPlan(model(type, numbered(4)), null);
			const b = bbox(p.outline);
			expect(b.x1 - b.x0).toBeLessThan(p.layout.pocketW);
			expect(b.y1 - b.y0).toBeLessThan(p.layout.pocketD);
			expect(Math.abs(b.x0)).toBeLessThan(p.layout.pocketW / 2);
			expect(Math.abs(b.y0)).toBeLessThan(p.layout.pocketD / 2);
		}
	});

	it('draws every pocket\'s insert as one shape, however many faces it has', () => {
		for (const p of plan.pockets) expect(p.insert).not.toBeNull();
		expect(plan.outline.match(/M/g)).toHaveLength(1); // one outline, shared by the pockets
	});
});

describe('buildTrayPlan: the etched text, as in the 3D view', () => {
	const m = model(CNMG, numbered(10), []);
	const plan = buildTrayPlan(m, null);
	const num = (label: string) => plan.texts.find((t) => t.kind === 'number' && t.text === label)!;
	const pocket = (label: string) => plan.pockets.find((p) => p.label === label)!;

	it('puts the left column\'s numbers in the left margin and the right column\'s in the right margin, level with the pockets', () => {
		for (const label of ['1', '3', '5', '7', '9']) {
			expect(num(label).x).toBeLessThan(pocket(label).x - pocket(label).w / 2);
			expect(num(label).y).toBeCloseTo(pocket(label).y, 1);
			expect(num(label).x).toBeGreaterThan(plan.tray.x);
		}
		for (const label of ['2', '4', '6', '8', '10']) {
			expect(num(label).x).toBeGreaterThan(pocket(label).x + pocket(label).w / 2);
			expect(num(label).x).toBeLessThan(plan.tray.x + plan.tray.w);
			expect(num(label).y).toBeCloseTo(pocket(label).y, 1);
		}
	});

	it('puts an inner column\'s numbers in front of the pocket (below it), in a tray of three or more columns', () => {
		const wide = buildTrayPlan(model({ iso_designation: 'CCMT 09 T3 04' }, numbered(12)), null);
		expect(wide.layout.columns).toBeGreaterThan(2);
		const inner = wide.pockets.filter((p) => { const s = wide.layout.slots[p.slot]; return s.column > 0 && s.column < wide.layout.columns - 1; });
		expect(inner.length).toBeGreaterThan(0);
		for (const p of inner) {
			const t = wide.texts.find((x) => x.kind === 'number' && x.text === p.label)!;
			expect(t.x).toBeCloseTo(p.x, 1);
			expect(t.y).toBeGreaterThan(p.y + p.h / 2);
		}
	});

	it('engraves the box code along the top end and the insert type along the bottom end', () => {
		const titles = plan.texts.filter((t) => t.kind === 'title');
		expect(titles.map((t) => t.text)).toEqual(['CNMG12-3', 'CNMG120408-MF']);
		const [top, bottom] = titles;
		expect(top.y).toBeLessThan(plan.pockets[0].y - plan.pockets[0].h / 2);
		expect(bottom.y).toBeGreaterThan(plan.pockets[9].y + plan.pockets[9].h / 2);
		expect(top.length).not.toBeNull();
		expect(top.length!).toBeLessThanOrEqual(plan.tray.w);
		expect(bottom.length!).toBeLessThanOrEqual(plan.tray.w);
	});

	it('leaves the bottom end bare for an unknown type', () => {
		const p = buildTrayPlan(model(null, numbered(4)), null);
		expect(p.texts.filter((t) => t.kind === 'title').map((t) => t.text)).toEqual(['CNMG12-3']);
	});

	it('numbers every slot, empty ones too', () => {
		const sparse = buildTrayPlan(model(CNMG, [ins(1), ins(4)]), null);
		expect(sparse.texts.filter((t) => t.kind === 'number').map((t) => t.text)).toEqual(['1', '2', '3', '4']);
		const empty = sparse.pockets.filter((p) => !p.insert);
		expect(empty.map((p) => p.label)).toEqual(['2', '3']);
		for (const p of empty) {
			expect(p.dots).toEqual([]);
			expect(p.state).toBeNull();
			expect(p.name).toBe(`Slot ${p.label}, empty`);
		}
	});

	it('fits a single case too, with the number on its front wall', () => {
		const one = buildTrayPlan(model({ iso_designation: 'CCGW 09T3 04', edge_count: 1, substrate: 'PCD' }, [ins(1)]), null);
		expect(one.pockets).toHaveLength(1);
		const t = one.texts.find((x) => x.kind === 'number')!;
		expect(t.y).toBeGreaterThan(one.pockets[0].y + one.pockets[0].h / 2);
	});
});

describe('buildTrayPlan: the pockets and their state', () => {
	it('marks a depleted insert, the part used and used states, and the next fresh insert', () => {
		const m = model(CNMG, [ins(1), ins(2, { is_depleted: true }), ins(3), ins(4)], [...fourEdges('i1', ['A']), ...fourEdges('i3', ['A', 'B', 'C', 'D']), ...fourEdges('i4')]);
		const plan = buildTrayPlan(m, { insertId: 'i1', edgeId: 'i1B' });
		expect(plan.pockets.map((p) => p.state)).toEqual(['partly-used', 'depleted', 'used', 'fresh']);
		expect(plan.pockets.map((p) => p.next)).toEqual([true, false, false, false]);
		expect(plan.pockets[0].dots.find((d) => d.edgeId === 'i1B')!.next).toBe(true);
		expect(plan.pockets[0].name).toBe('Insert 1, part used, 3/4 fresh');
		expect(plan.pockets[1].name).toBe('Insert 2, depleted, depleted');
	});
});

const pocketOf = (m: ToolingModel) => { const l = buildTrayPlan(m, null).layout; return { w: l.pocketW, h: l.pocketD }; };

describe('insertDots: one dot per edge, side by side across each corner', () => {
	const m = model(CNMG, [ins(1)], fourEdges('i1', ['B']));
	const pocket = pocketOf(m);
	const dots = insertDots(m, m.inserts[0], 'i1C', pocket);
	const byLetter = (l: string) => dots.find((d) => d.letter === l)!;

	it('has a dot for each of the four edges, none drawn with a letter', () => {
		expect(dots.map((d) => d.letter).sort()).toEqual(['A', 'B', 'C', 'D']);
		expect(byLetter('A').face).toBe('top');
		expect(byLetter('C').face).toBe('bottom');
		expect(dots.every((d) => !d.hollow)).toBe(true);
		expect(Object.keys(dots[0])).not.toContain('text'); // the letters are in the names, not on the dots
		expect(byLetter('C').name).toBe('Edge C, fresh, underside');
	});

	it('puts the top-face dot and the underside dot side by side across the corner, the underside one smaller', () => {
		const a = byLetter('A');
		const c = byLetter('C');
		expect(c.r).toBeLessThan(a.r);
		expect(c.r).toBeGreaterThan(a.r * 0.6);
		expect(Math.abs(c.y - a.y)).toBeLessThan(0.05); // level: spread across the corner, not along it
		expect(a.x).toBeLessThan(c.x); // the top-face one on the left
		// centred on the corner's axis (corner 0 points straight up the page): the pair's middle is on x = 0
		expect((a.x + c.x) / 2).toBeCloseTo(0, 1);
		const b = byLetter('B');
		const d = byLetter('D');
		expect(Math.abs(d.y - b.y)).toBeLessThan(0.05);
		expect((b.x + d.x) / 2).toBeCloseTo(0, 1);
		expect(Math.sign(a.y)).toBe(-1); // corner 0 is at the top, corner 2 at the foot
		expect(Math.sign(b.y)).toBe(1);
	});

	it('makes the dots about 1.6 times the first version\'s (which were 1.6 mm), without ever overlapping', () => {
		expect(byLetter('A').r).toBeGreaterThanOrEqual(2.3);
		expect(byLetter('A').r).toBeLessThanOrEqual(2.5);
		for (const d of dots) for (const o of dots) {
			if (d !== o) expect(Math.hypot(d.x - o.x, d.y - o.y)).toBeGreaterThanOrEqual(d.r + o.r);
		}
	});

	it('keeps every dot inside the pocket, so it stays clear of the next one', () => {
		for (const d of dots) {
			expect(Math.abs(d.x) + d.r).toBeLessThanOrEqual(pocket.w / 2);
			expect(Math.abs(d.y) + d.r).toBeLessThanOrEqual(pocket.h / 2);
		}
	});

	it('does this for every common type: no overlaps, all inside the pocket, a dot per placed edge', () => {
		for (const type of [CNMG, R390, { iso_designation: 'SNMG 12 04 08' }, { iso_designation: 'DNMG 15 06 08' }, { iso_designation: 'TNMG 16 04 08' }, { iso_designation: 'CCMT 09 T3 04' }, { iso_designation: 'RCMT 10 T3 M0' }, { iso_designation: 'VBMT 16 04 08' }, { iso_designation: 'CCGW 09T3 04', edge_count: 1, substrate: 'PCD' }]) {
			const mm = model(type, [ins(1)], fourEdges('i1'));
			const p = pocketOf(mm);
			const ds = insertDots(mm, mm.inserts[0], null, p);
			const placed = ds.filter((d) => !d.hollow);
			expect(placed.length).toBe(mm.inserts[0].edges.filter((e) => e.placement).length);
			for (const d of placed) {
				expect(Math.abs(d.x) + d.r).toBeLessThanOrEqual(p.w / 2 + 1e-6);
				expect(Math.abs(d.y) + d.r).toBeLessThanOrEqual(p.h / 2 + 1e-6);
				for (const o of placed) if (o !== d) expect(Math.hypot(d.x - o.x, d.y - o.y)).toBeGreaterThanOrEqual(d.r + o.r - 0.01);
			}
		}
	});

	it('draws ONE dot per corner for a single-sided insert, centred on the corner\'s axis', () => {
		const one = model({ iso_designation: 'CCMT 09 T3 04' }, [ins(1)], [edge('i1', 'A'), edge('i1', 'B')]);
		expect(one.geometry.doubleSided).toBe(false);
		const ds = insertDots(one, one.inserts[0], null, pocketOf(one));
		expect(ds).toHaveLength(2);
		expect(ds.every((d) => d.face === 'top')).toBe(true);
		const a = ds.find((d) => d.letter === 'A')!;
		expect(a.x).toBeCloseTo(0, 1); // corner 0, straight up
		expect(a.y).toBeLessThan(0);
	});

	it('draws an unreadable or unplaced edge as a hollow dot in a row at the pocket\'s foot', () => {
		const mm = model(CNMG, [ins(1)], [edge('i1', 'A'), edge('i1', '?', false, { edge_id: 'u1', edge_code: 'u1' }), edge('i1', 'zz', true, { edge_id: 'u2', edge_code: 'u2' })]);
		const ds = insertDots(mm, mm.inserts[0], null, pocketOf(mm));
		const hollow = ds.filter((d) => d.hollow);
		expect(hollow).toHaveLength(2);
		for (const d of hollow) {
			expect(d.face).toBeNull();
			expect(d.y).toBeGreaterThan(8);
			expect(d.name).toContain('position unknown');
		}
		expect(hollow[0].x).toBeLessThan(hollow[1].x);
		expect(Math.hypot(hollow[0].x - hollow[1].x, hollow[0].y - hollow[1].y)).toBeGreaterThan(hollow[0].r + hollow[1].r);
	});

	it('colours by state, flags the next fresh edge and names each edge', () => {
		expect(byLetter('B').used).toBe(true);
		expect(byLetter('A').used).toBe(false);
		expect(byLetter('C').next).toBe(true);
		expect(byLetter('B').name).toBe('Edge B, used');
	});

	it('does not draw a duplicate edge record, nor count it', () => {
		const mm = model(CNMG, [ins(1)], [...fourEdges('i1'), edge('i1', 'D', false, { edge_id: 'dup', edge_code: 'zz' })]);
		expect(insertDots(mm, mm.inserts[0], null, pocketOf(mm))).toHaveLength(4);
	});
});

describe('planDetail: large boxes', () => {
	it('draws the dots up to 60 slots, and just outlines beyond', () => {
		expect(DOTS_UP_TO).toBe(60);
		expect(planDetail(10)).toBe('dots');
		expect(planDetail(60)).toBe('dots');
		expect(planDetail(61)).toBe('none');
	});

	it('still plans a box of 61 and of 120 slots: every pocket, every number, no dots', () => {
		for (const n of [61, 120]) {
			const plan = buildTrayPlan(model(CNMG, numbered(n), numbered(n).flatMap((i) => fourEdges(i.insert_id))), null);
			expect(plan.detail).toBe('none');
			expect(plan.pockets).toHaveLength(n);
			expect(plan.pockets.every((p) => p.dots.length === 0)).toBe(true);
			expect(plan.texts.filter((t) => t.kind === 'number')).toHaveLength(n);
			expect(plan.pockets.every((p) => p.insert !== null)).toBe(true);
		}
	});

	it('plans an empty box (no pockets) without error', () => {
		const plan = buildTrayPlan(model(CNMG, []), null);
		expect(plan.pockets).toEqual([]);
		expect(plan.viewBox.split(' ').every((v) => Number.isFinite(Number(v)))).toBe(true);
	});

	it('plans every pocket of a box with the dots inside its own pocket (so none reaches the next one)', () => {
		const plan = buildTrayPlan(model(CNMG, numbered(10), numbered(10).flatMap((i) => fourEdges(i.insert_id))), null);
		for (const p of plan.pockets) for (const d of p.dots) {
			expect(Math.abs(d.x) + d.r).toBeLessThanOrEqual(p.w / 2);
			expect(Math.abs(d.y) + d.r).toBeLessThanOrEqual(p.h / 2);
		}
	});
});
