import { describe, expect, it } from 'vitest';
import {
	edgeLabel, findEdge, focusFromRoute, focusKindOf, freshWithHistory, insertLabel, mergeHistory, mismatchText, stateCounts, toolingTitle,
} from './toolingView';
import { buildToolingModel, type EdgeRow, type InsertRow } from './toolingModel';

const box = { tool_box_id: 'b1', tool_box_code: 'BOX-H13A-001' };
const ins = (n: number | null, extra: Partial<InsertRow> = {}): InsertRow => ({
	insert_id: `i${n}`, insert_code: `H13A-#${n}`, tool_box_id: 'b1', insert_number: n, is_depleted: false, ...extra,
});
const edge = (insert: string, letter: string, used = false): EdgeRow => ({
	edge_id: `${insert}-${letter}`, edge_code: `${insert}-f${letter}`, insert_id: insert, edge_identifier: letter, is_used: used,
});
const model = buildToolingModel(
	box, { iso_designation: 'CNMG 12 04 08-MF' },
	[ins(1), ins(2), ins(3, { is_depleted: true }), ins(null)],
	[edge('i1', 'A', true), edge('i1', 'B'), edge('i2', 'A'), edge('i2', 'B'), edge('i3', 'A'), edge('i3', 'B')],
);

describe('focusKindOf', () => {
	it('maps the three route segments and nothing else', () => {
		expect(focusKindOf('tool-boxes')).toBe('box');
		expect(focusKindOf('inserts')).toBe('insert');
		expect(focusKindOf('edges')).toBe('edge');
		expect(focusKindOf('samples')).toBeNull();
		expect(focusKindOf('constructor')).toBeNull();
		expect(focusKindOf(undefined)).toBeNull();
	});
});

describe('focusFromRoute', () => {
	it('is the box, or the insert named by the id', () => {
		expect(focusFromRoute('tool-boxes', 'b1', null, null)).toEqual({ kind: 'box' });
		expect(focusFromRoute('inserts', 'i2', model, null)).toEqual({ kind: 'insert', insertId: 'i2' });
	});
	it("finds an edge's insert in the model first, else from the record", () => {
		expect(focusFromRoute('edges', 'i2-B', model, 'wrong')).toEqual({ kind: 'edge', insertId: 'i2', edgeId: 'i2-B' });
		expect(focusFromRoute('edges', 'zz', null, 'i9')).toEqual({ kind: 'edge', insertId: 'i9', edgeId: 'zz' });
	});
	it("is null while an edge's insert is unknown, for other kinds and for an empty id", () => {
		expect(focusFromRoute('edges', 'zz', model, null)).toBeNull();
		expect(focusFromRoute('samples', 'x', model, null)).toBeNull();
		expect(focusFromRoute('inserts', '', model, null)).toBeNull();
	});
});

describe('stateCounts, labels and titles', () => {
	it('counts each state', () => {
		expect(stateCounts(model)).toEqual({ fresh: 2, 'partly-used': 1, used: 0, depleted: 1 });
	});
	it('names inserts and edges by slot number and letter, falling back to the code', () => {
		const first = model.inserts[0];
		expect(insertLabel(first)).toBe('Insert 1');
		expect(edgeLabel(first, first.edges[1])).toBe('1B');
		const unnumbered = model.inserts[3];
		expect(insertLabel(unnumbered)).toBe(unnumbered.code);
		expect(findEdge(model, 'i1-A')?.insert.id).toBe('i1');
		expect(findEdge(model, 'nope')).toBeNull();
	});
	it('titles the page by kind and code', () => {
		expect(toolingTitle({ kind: 'box' }, model)).toBe('Tool box BOX-H13A-001');
		expect(toolingTitle({ kind: 'insert', insertId: 'i2' }, model)).toBe('Insert H13A-#2');
		expect(toolingTitle({ kind: 'edge', insertId: 'i1', edgeId: 'i1-B' }, model)).toBe('Edge i1-fB');
		expect(toolingTitle({ kind: 'box' }, null)).toBe('Tooling');
		expect(toolingTitle({ kind: 'insert', insertId: 'gone' }, model)).toBe('Insert');
	});
});

describe('mismatch', () => {
	it('words the warning with the count', () => {
		expect(mismatchText(1)).toBe('Marked fresh, but 1 test or operation used this edge.');
		expect(mismatchText(3)).toBe('Marked fresh, but 3 tests or operations used this edge.');
	});
	it('lists only fresh edges that have history', () => {
		const counts = new Map([['i1-A', 4], ['i2-B', 2], ['i3-A', 0]]);
		const list = freshWithHistory(model, counts);
		expect(list.map((x) => [x.edge.id, x.count])).toEqual([['i2-B', 2]]);
	});
});

describe('mergeHistory', () => {
	const tests = [
		{ session_id: 't1', test_type: 'Fatigue', session_date: '2026-03-01T00:00:00Z', status: 'analysed', sample_id: { sample_code: 'S-1' } },
		{ session_id: 't2', test_type: null, session_date: null, status: 'registered', sample_id: null },
	];
	const ops = [
		{ operation_id: 'o1', pass_code: '9-F1', operation_date: '2026-05-02T00:00:00Z', process_category: 'machining', sample_id: { sample_code: 'S-2' } },
		{ operation_id: 'o2', pass_code: null, operation_sequence: 3, operation_date: '2026-01-02T00:00:00Z', process_category: 'sample_prep', sample_id: { sample_code: 'S-3' } },
	];
	it('merges tests and operations, newest first, undated last', () => {
		expect(mergeHistory(tests, ops).map((e) => e.id)).toEqual(['o1', 't1', 'o2', 't2']);
	});
	it('labels each entry', () => {
		const list = mergeHistory(tests, ops);
		expect(list[0]).toMatchObject({ kind: 'operation', collection: 'manufacturing_operations', label: '9-F1', sampleCode: 'S-2', category: 'machining' });
		expect(list[1]).toMatchObject({ kind: 'test', collection: 'test_sessions', label: 'Fatigue', sampleCode: 'S-1', status: 'analysed' });
		expect(list[2].label).toBe('S-3 · step 3');
		expect(list[3]).toMatchObject({ label: 'Test', sampleCode: null });
	});
	it('is empty with nothing', () => {
		expect(mergeHistory([], [])).toEqual([]);
	});
});
