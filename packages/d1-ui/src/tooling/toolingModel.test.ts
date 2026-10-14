import { describe, expect, it } from 'vitest';
import {
	buildToolingModel, edgeUsageMismatch, focusParent, focusRoute, insertState, nextFreshEdge,
	type EdgeRow, type InsertRow, type ToolingModel,
} from './toolingModel';

const box = { tool_box_id: 'b1', tool_box_code: 'BOX-H13A-001' };
const cnmg = { iso_designation: 'CNMG 12 04 08-MF' };

const ins = (n: number | null, extra: Partial<InsertRow> = {}): InsertRow => ({
	insert_id: `i${n ?? 'x'}`, insert_code: `H13A-#${n ?? 'x'}`, tool_box_id: 'b1', insert_number: n, is_depleted: false, ...extra,
});
const edge = (insert: string, letter: string, used = false, extra: Partial<EdgeRow> = {}): EdgeRow => ({
	edge_id: `${insert}-${letter}`, edge_code: `${insert}-f${letter}`, insert_id: insert, edge_identifier: letter, is_used: used, ...extra,
});
const fourEdges = (insert: string, used: string[] = []): EdgeRow[] => ['A', 'B', 'C', 'D'].map((l) => edge(insert, l, used.includes(l)));

describe('insertState', () => {
	it('is fresh with no used edge, used with all, partly-used between', () => {
		expect(insertState({ is_depleted: false }, [{ is_used: false }, { is_used: false }])).toBe('fresh');
		expect(insertState({ is_depleted: false }, [{ is_used: true }, { is_used: false }])).toBe('partly-used');
		expect(insertState({ is_depleted: false }, [{ is_used: true }, { is_used: true }])).toBe('used');
	});
	it('is depleted whatever the edges say', () => {
		expect(insertState({ is_depleted: true }, [{ is_used: false }])).toBe('depleted');
		expect(insertState({ is_depleted: true }, [{ is_used: true }])).toBe('depleted');
	});
	it('treats no edges and null flags as fresh', () => {
		expect(insertState({ is_depleted: null }, [])).toBe('fresh');
		expect(insertState({ is_depleted: null }, [{ is_used: null }])).toBe('fresh');
	});
});

describe('buildToolingModel', () => {
	const model = buildToolingModel(
		box, cnmg,
		[ins(2), ins(1), ins(3, { is_depleted: true })],
		[...fourEdges('i1', ['A']), ...fourEdges('i2'), ...fourEdges('i3', ['A', 'B', 'C', 'D'])],
	);

	it('carries the box, the geometry and its outline', () => {
		expect(model.boxId).toBe('b1');
		expect(model.boxCode).toBe('BOX-H13A-001');
		expect(model.geometry.shape).toBe('C');
		expect(model.outline.corners).toHaveLength(4);
	});

	it('sorts inserts by number and gives each its slot', () => {
		expect(model.inserts.map((i) => i.number)).toEqual([1, 2, 3]);
		expect(model.grid.columns * model.grid.rows).toBeGreaterThanOrEqual(3);
		expect(model.inserts.map((i) => i.cell?.number)).toEqual([1, 2, 3]);
		expect(model.inserts[0]).toMatchObject({ id: 'i1', code: 'H13A-#1', depleted: false, state: 'partly-used' });
		expect(model.inserts[1].state).toBe('fresh');
		expect(model.inserts[2].state).toBe('depleted');
	});

	it('sorts edges by letter and places them', () => {
		const first = model.inserts[0];
		expect(first.edges.map((e) => e.letter)).toEqual(['A', 'B', 'C', 'D']);
		expect(first.edges[0]).toMatchObject({ id: 'i1-A', code: 'i1-fA', identifier: 'A', used: true, placement: { face: 'top', corner: 0 } });
		expect(first.edges[3].placement).toEqual({ face: 'bottom', corner: 2 });
	});

	it('normalises legacy letters, keeps unreadable ones last and unplaced, and keeps notes', () => {
		const m = buildToolingModel(
			box, cnmg, [ins(1)],
			[
				edge('i1', '??', false), edge('i1', 'fC', true, { notes: 'chipped' }), edge('i1', 'E'), edge('i1', 'fA'), edge('i1', 'b'),
			],
		);
		const edges = m.inserts[0].edges;
		expect(edges.map((e) => e.letter)).toEqual(['A', 'B', 'C', 'E', null]);
		expect(edges[2]).toMatchObject({ identifier: 'fC', used: true, notes: 'chipped' });
		expect(edges[3].placement).toBeNull(); // E does not exist on a CNMG
		expect(edges[4].placement).toBeNull();
	});

	it('ignores edges of inserts that are not in the list', () => {
		const m = buildToolingModel(box, cnmg, [ins(1)], [...fourEdges('i1'), ...fourEdges('elsewhere')]);
		expect(m.inserts[0].edges).toHaveLength(4);
	});

	it('puts inserts without a number last, with no cell', () => {
		const m = buildToolingModel(box, cnmg, [ins(null), ins(1)], []);
		expect(m.inserts.map((i) => i.number)).toEqual([1, null]);
		expect(m.inserts[1].cell).toBeNull();
	});

	it('leaves a repeated or non-positive number without a cell', () => {
		const m = buildToolingModel(
			box, cnmg,
			[ins(1), ins(1, { insert_id: 'dup', insert_code: 'H13A-#1b' }), ins(0, { insert_id: 'zero' })],
			[],
		);
		const cells = Object.fromEntries(m.inserts.map((i) => [i.id, i.cell?.number ?? null]));
		expect(cells).toEqual({ zero: null, i1: 1, dup: null });
	});

	it('sizes the grid to the highest slot number, so a gap stays a gap', () => {
		const m = buildToolingModel(box, cnmg, [ins(1), ins(10)], []);
		expect(m.grid.cells).toHaveLength(10);
		expect(m.inserts[1].cell).toEqual({ number: 10, column: 1, row: 4 });
	});

	it('gives an empty box an empty tray and a fallback geometry without a type', () => {
		const m = buildToolingModel(box, null, [], []);
		expect(m.inserts).toEqual([]);
		expect(m.grid.cells).toEqual([]);
		expect(m.geometry.recognised).toBe(false);
	});
});

describe('nextFreshEdge (spec Q10)', () => {
	const next = (inserts: InsertRow[], edges: EdgeRow[]) => nextFreshEdge(buildToolingModel(box, cnmg, inserts, edges));

	it('takes the lowest-numbered part-used insert, its first fresh letter', () => {
		expect(next([ins(1), ins(2), ins(3)], [...fourEdges('i1'), ...fourEdges('i2', ['A', 'B']), ...fourEdges('i3', ['A'])])).toEqual({
			insertId: 'i2', edgeId: 'i2-C',
		});
	});

	it('goes A, B, C, D through the letters, skipping used ones in the middle', () => {
		const edges = [edge('i1', 'A', true), edge('i1', 'B', false), edge('i1', 'C', true), edge('i1', 'D', false)];
		expect(next([ins(1)], edges)).toEqual({ insertId: 'i1', edgeId: 'i1-B' });
	});

	it('prefers a part-used insert over a lower-numbered fresh one', () => {
		expect(next([ins(1), ins(2)], [...fourEdges('i1'), ...fourEdges('i2', ['A'])])).toEqual({ insertId: 'i2', edgeId: 'i2-B' });
	});

	it('falls back to the lowest-numbered insert with a fresh edge when none is part-used', () => {
		expect(next([ins(2), ins(1), ins(3)], [...fourEdges('i1', ['A', 'B', 'C', 'D']), ...fourEdges('i2'), ...fourEdges('i3')])).toEqual({
			insertId: 'i2', edgeId: 'i2-A',
		});
	});

	it('skips depleted inserts, even part-used ones', () => {
		expect(
			next([ins(1, { is_depleted: true }), ins(2)], [...fourEdges('i1', ['A']), ...fourEdges('i2')]),
		).toEqual({ insertId: 'i2', edgeId: 'i2-A' });
	});

	it('skips fully used inserts', () => {
		expect(next([ins(1), ins(2)], [...fourEdges('i1', ['A', 'B', 'C', 'D']), ...fourEdges('i2', ['A'])])).toEqual({ insertId: 'i2', edgeId: 'i2-B' });
	});

	it('is null when nothing is left', () => {
		expect(next([ins(1), ins(2, { is_depleted: true })], [...fourEdges('i1', ['A', 'B', 'C', 'D']), ...fourEdges('i2')])).toBeNull();
		expect(next([], [])).toBeNull();
		expect(next([ins(1)], [])).toBeNull(); // an insert with no edge rows has no fresh edge to point at
	});
});

describe('edgeUsageMismatch', () => {
	it('warns when an edge is marked unused but tests or operations used it', () => {
		expect(edgeUsageMismatch(false, 2)).toBe('unused-with-history');
	});
	it('is quiet otherwise', () => {
		expect(edgeUsageMismatch(false, 0)).toBeNull();
		expect(edgeUsageMismatch(true, 0)).toBeNull();
		expect(edgeUsageMismatch(true, 3)).toBeNull();
	});
});

describe('focusParent', () => {
	it('goes edge, insert, box, then nothing', () => {
		expect(focusParent({ kind: 'edge', insertId: 'i1', edgeId: 'e1' })).toEqual({ kind: 'insert', insertId: 'i1' });
		expect(focusParent({ kind: 'insert', insertId: 'i1' })).toEqual({ kind: 'box' });
		expect(focusParent({ kind: 'box' })).toBeNull();
	});
});

describe('focusRoute', () => {
	it('goes through recordRoute for each kind', () => {
		expect(focusRoute({ kind: 'box' }, 'b1')).toBe('/home/tool-boxes/b1');
		expect(focusRoute({ kind: 'insert', insertId: 'i1' }, 'b1')).toBe('/home/inserts/i1');
		expect(focusRoute({ kind: 'edge', insertId: 'i1', edgeId: 'e 1' }, 'b1')).toBe('/home/edges/e%201');
	});
});

describe('types', () => {
	it('exposes the model shape the stage draws', () => {
		const m: ToolingModel = buildToolingModel(box, cnmg, [ins(1)], fourEdges('i1'));
		expect(Object.keys(m).sort()).toEqual(['boxCode', 'boxId', 'geometry', 'grid', 'inserts', 'outline']);
	});
});
