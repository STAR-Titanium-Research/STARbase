import { describe, expect, it } from 'vitest';
import { buildToolingModel, type EdgeRow, type InsertRow, type ToolingFocus, type ToolingModel } from '@d1/ui';
import { buildInsertView, edgeChips, edgeName, faceToShow, insertFacts, UNDERSIDE_CAPTION } from './insertView2d';
import { outline2d } from './outline2d';

const box = { tool_box_id: 'b1', tool_box_code: 'B' };
const ins = (n: number): InsertRow => ({ insert_id: `i${n}`, insert_code: `X-${n}`, insert_number: n, is_depleted: false });
const edge = (i: string, l: string, used = false, extra: Partial<EdgeRow> = {}): EdgeRow => ({
	edge_id: `${i}${l}`, edge_code: `${i}-${l}`, insert_id: i, edge_identifier: l, is_used: used, ...extra,
});
const four = (i: string, used: string[] = []): EdgeRow[] => ['A', 'B', 'C', 'D'].map((l) => edge(i, l, used.includes(l)));
const CNMG = { iso_designation: 'CNMG 12 04 08-MF', type_code: 'CNMG 12 04 08-MF' };
const model = (type: Record<string, unknown> | null, edges: EdgeRow[]): ToolingModel => buildToolingModel(box, type, [ins(1)], edges);
const INSERT: ToolingFocus = { kind: 'insert', insertId: 'i1' };
const edgeFocus = (id: string): ToolingFocus => ({ kind: 'edge', insertId: 'i1', edgeId: id });

describe('faceToShow', () => {
	const m = model(CNMG, four('i1'));
	const i = m.inserts[0];

	it('shows the face the viewer chose, the top at first', () => {
		expect(faceToShow(i, m.geometry, INSERT, 'top')).toBe('top');
		expect(faceToShow(i, m.geometry, INSERT, 'bottom')).toBe('bottom');
	});

	it('shows the face holding the selected edge, whatever was chosen', () => {
		expect(faceToShow(i, m.geometry, edgeFocus('i1C'), 'top')).toBe('bottom');
		expect(faceToShow(i, m.geometry, edgeFocus('i1A'), 'bottom')).toBe('top');
	});

	it('only ever shows the top of a single-sided insert', () => {
		const one = model({ iso_designation: 'CCMT 09 T3 04' }, [edge('i1', 'A'), edge('i1', 'B')]);
		expect(one.geometry.doubleSided).toBe(false);
		expect(faceToShow(one.inserts[0], one.geometry, INSERT, 'bottom')).toBe('top');
		expect(buildInsertView(one, one.inserts[0], INSERT, null, 'bottom').doubleSided).toBe(false);
	});
});

describe('buildInsertView: one insert, the edges of the face shown', () => {
	const m = model(CNMG, four('i1', ['B']));
	const i = m.inserts[0];

	it('draws ONE outline, with the letters of the top face on its corners, A and B', () => {
		const v = buildInsertView(m, i, INSERT, 'i1C', 'top');
		expect(v.face).toBe('top');
		expect(v.doubleSided).toBe(true);
		expect(v.pills.map((p) => p.letter)).toEqual(['A', 'B']);
		expect(v.drawing.path.match(/M/g)).toHaveLength(1);
		expect(v.drawing.mark).not.toBe(''); // the reference mark is on the top face
		expect(v.caption).toBeNull();
	});

	it('shows the underside mirrored left to right, with its letters C and D on the same corners, and says so', () => {
		const top = buildInsertView(m, i, INSERT, null, 'top');
		const under = buildInsertView(m, i, INSERT, null, 'bottom');
		expect(under.face).toBe('bottom');
		expect(under.pills.map((p) => p.letter)).toEqual(['C', 'D']);
		expect(under.caption).toBe(UNDERSIDE_CAPTION);
		expect(under.caption).toContain('mirrored');
		expect(under.drawing.mark).toBe('');
		// C is under A: the same place on the page.
		const a = top.pills.find((p) => p.letter === 'A')!;
		const c = under.pills.find((p) => p.letter === 'C')!;
		expect(c.x).toBeCloseTo(a.x, 6);
		expect(c.y).toBeCloseTo(a.y, 6);
	});

	it('mirrors the outline itself: the underside path is the top view with x negated, and a corner keeps its height', () => {
		const top = outline2d(m.geometry, m.outline, 'top');
		const bottom = outline2d(m.geometry, m.outline, 'bottom');
		const pts = (p: string) => [...p.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((x) => [Number(x[1]), Number(x[2])]);
		const t = pts(top.path);
		const b = pts(bottom.path);
		expect(b).toHaveLength(t.length);
		t.forEach((p, k) => {
			expect(b[k][0]).toBeCloseTo(-p[0], 1);
			expect(b[k][1]).toBeCloseTo(p[1], 1);
		});
		expect(bottom.nose(1).x).toBeCloseTo(-top.nose(1).x, 6);
		expect(bottom.nose(1).y).toBeCloseTo(top.nose(1).y, 6);
	});

	it('flags the selected pill, the used ones and the next fresh one, and names each', () => {
		const v = buildInsertView(m, i, edgeFocus('i1A'), 'i1A', 'top');
		const a = v.pills.find((p) => p.letter === 'A')!;
		const b = v.pills.find((p) => p.letter === 'B')!;
		expect(a.selected).toBe(true);
		expect(a.next).toBe(true);
		expect(b.selected).toBe(false);
		expect(b.used).toBe(true);
		expect(a.name).toBe('Edge A, fresh, next fresh edge');
		expect(b.name).toBe('Edge B, used');
	});

	it('shows the underside automatically for a selected underside edge, with that pill selected', () => {
		const v = buildInsertView(m, i, edgeFocus('i1D'), null, 'top');
		expect(v.face).toBe('bottom');
		expect(v.pills.find((p) => p.selected)!.letter).toBe('D');
		expect(v.pills.find((p) => p.letter === 'D')!.name).toBe('Edge D, fresh, underside');
	});

	it('leaves an edge with no place on the drawing out of the pills, but keeps its chip', () => {
		const odd = model(CNMG, [...four('i1').slice(0, 2), edge('i1', 'zz', false, { edge_id: 'u', edge_code: 'u' })]);
		const v = buildInsertView(odd, odd.inserts[0], INSERT, null, 'top');
		expect(v.pills.map((p) => p.letter)).toEqual(['A', 'B']);
		expect(v.chips.map((c) => c.edge.id)).toContain('u');
	});
});

describe('edgeChips: every letter is reachable from one row', () => {
	const m = model(CNMG, four('i1', ['C']));

	it('has a chip per edge, in letter order, with the underside ones marked', () => {
		const chips = edgeChips(m.inserts[0], INSERT, null);
		expect(chips.map((c) => c.text)).toEqual(['A', 'B', 'C (under)', 'D (under)']);
		expect(chips.map((c) => c.used)).toEqual([false, false, true, false]);
		expect(chips.map((c) => c.face)).toEqual(['top', 'top', 'bottom', 'bottom']);
	});

	it("flags the selected chip and the next fresh one, with the pill's accessible names", () => {
		const chips = edgeChips(m.inserts[0], edgeFocus('i1B'), 'i1D');
		expect(chips.map((c) => c.selected)).toEqual([false, true, false, false]);
		expect(chips.map((c) => c.next)).toEqual([false, false, false, true]);
		expect(chips[2].name).toBe('Edge C, used, underside');
		expect(edgeName(m.inserts[0].edges[3], 'i1D')).toBe('Edge D, fresh, underside, next fresh edge');
	});

	it('lists none for an insert with no edges', () => {
		expect(edgeChips(model(CNMG, []).inserts[0], INSERT, null)).toEqual([]);
	});
});

describe('insertFacts: the shape and size, from the geometry', () => {
	const facts = (type: Record<string, unknown>) => insertFacts(model(type, []));

	it('reads the type, the shape and the cutting corners per face', () => {
		expect(facts(CNMG)).toBe('CNMG 12 04 08-MF, 80° rhombus, IC 12.7 mm, 2 cutting corners per face');
		expect(facts({ iso_designation: 'SNMG 12 04 08', type_code: 'SNMG120408' })).toBe('SNMG120408, square, IC 12.7 mm, 4 cutting corners per face');
		expect(facts({ iso_designation: 'DNMG 15 06 08' })).toContain('55° rhombus');
		expect(facts({ iso_designation: 'TNMG 16 04 08' })).toContain('triangle');
		expect(facts({ iso_designation: 'RCMT 10 T3 M0' })).toContain('round');
		expect(facts({ iso_designation: 'CCGW 09T3 04', edge_count: 1, substrate: 'PCD' })).toContain('1 cutting corner per face');
	});

	it('reads a milling insert as a rectangle, and an unknown type as a polygon', () => {
		const r390 = facts({ iso_designation: null, type_code: 'R390-11 T3 08M-MM S30T', nose_radius_mm: 0.8 });
		expect(r390).toContain('R390-11 T3 08M-MM S30T, 11.45 x 6.8 mm rectangle');
		expect(r390).toContain('2 cutting corners per face');
		expect(facts({ iso_designation: '???', edge_count: 5 })).toContain('5-sided polygon (shape not recognised)');
	});

	it('copes with no type at all', () => {
		expect(insertFacts(buildToolingModel(box, null, [ins(1)], []))).toMatch(/cutting corners? per face$/);
	});
});
