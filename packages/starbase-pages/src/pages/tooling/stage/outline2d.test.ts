import { describe, expect, it } from 'vitest';
import { buildToolingModel, type EdgeRow, type InsertRow } from '@d1/ui';
import { faces, outline2d } from './outline2d';
import { freshCaption, gridSlots } from './slots2d';

const box = { tool_box_id: 'b', tool_box_code: 'B' };
const ins = (n: number | null, extra: Partial<InsertRow> = {}): InsertRow => ({
	insert_id: `i${n ?? 'x'}`, insert_code: `X-${n ?? 'x'}`, insert_number: n, is_depleted: false, ...extra,
});
const edge = (i: string, l: string, used = false): EdgeRow => ({
	edge_id: `${i}${l}`, edge_code: `${i}-${l}`, insert_id: i, edge_identifier: l, is_used: used,
});

describe('outline2d', () => {
	const m = buildToolingModel(box, { iso_designation: 'CNMG 12 04 08-MF' }, [ins(1)], []);
	const o = outline2d(m.geometry, m.outline);

	it('is a closed path with one point per outline point, y flipped for SVG', () => {
		expect(o.path.startsWith('M')).toBe(true);
		expect(o.path.endsWith('Z')).toBe(true);
		expect(o.path.split('L').length).toBe(m.outline.points.length);
		// corner 0 points up in the top view, so it has the most negative y in SVG
		const ys = [...o.path.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((x) => Number(x[2]));
		expect(Math.min(...ys)).toBeLessThan(-9);
	});

	it('has a square view box that holds the long diagonal and the letters', () => {
		const [x, y, w, h] = o.viewBox.split(' ').map(Number);
		expect(w).toBe(h);
		expect(w).toBeGreaterThan(2 * 9.4);
		expect(x).toBeCloseTo(-w / 2, 1);
		expect(y).toBeCloseTo(-h / 2, 1);
	});

	it('has the hole and the reference mark', () => {
		expect(o.hole!.r).toBeCloseTo(m.geometry.holeDiameterMm! / 2, 6);
		expect(o.mark.startsWith('M')).toBe(true);
	});

	it('puts a letter bubble outside each corner, above corner 0 and below corner 2', () => {
		expect(o.nose(0).y).toBeLessThan(-9.4);
		expect(o.nose(2).y).toBeGreaterThan(9.4);
		expect(o.nose(9)).toEqual({ x: 0, y: 0 });
	});

	it('shows the underside only for a double-sided insert', () => {
		expect(faces(m.geometry)).toEqual(['top', 'bottom']);
		const single = buildToolingModel(box, { iso_designation: 'CCMT 09 T3 04' }, [ins(1)], []);
		expect(faces(single.geometry)).toEqual(['top']);
	});

	it('draws a fallback polygon with no hole', () => {
		const odd = buildToolingModel(box, { iso_designation: '???', edge_count: 5 }, [ins(1)], []);
		const p = outline2d(odd.geometry, odd.outline);
		expect(p.hole).toBeNull();
		expect(p.path.split('L').length).toBeGreaterThan(5); // five corners, each with a filleted nose
	});
});

describe('gridSlots', () => {
	it('lists the grid cells in reading order with their inserts', () => {
		const m = buildToolingModel(box, null, [ins(1), ins(2), ins(4)], []);
		const g = gridSlots(m);
		expect(g.columns).toBe(m.grid.columns);
		expect(g.slots.map((s) => s.label)).toEqual(['1', '2', '3', '4']);
		expect(g.slots.map((s) => s.insert?.id ?? null)).toEqual(['i1', 'i2', null, 'i4']);
	});

	it('adds a ? cell for an insert with no slot number', () => {
		const m = buildToolingModel(box, null, [ins(1), ins(null)], []);
		const g = gridSlots(m);
		expect(g.slots.at(-1)).toMatchObject({ label: '?', insert: { id: 'ix' } });
	});

	it('is empty for an empty box', () => {
		expect(gridSlots(buildToolingModel(box, null, [], [])).slots).toEqual([]);
	});
});

describe('freshCaption', () => {
	it('counts fresh edges, and says depleted or no edges instead', () => {
		const m = buildToolingModel(box, { iso_designation: 'CNMG120408' }, [ins(1), ins(2, { is_depleted: true }), ins(3)],
			[edge('i1', 'A', true), edge('i1', 'B'), edge('i2', 'A')]);
		const [a, b, c] = m.inserts;
		expect(freshCaption(a)).toBe('1/2 fresh');
		expect(freshCaption(b)).toBe('depleted');
		expect(freshCaption(c)).toBe('no edges');
	});
});
