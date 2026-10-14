import { describe, expect, it } from 'vitest';
import { buildToolingModel, type EdgeRow, type InsertRow, type ToolingFocus } from '@d1/ui';
import { escapeFocus, focusAnnouncement, hoverLabel, stepFocus, unplacedEdges } from './stageNav';

const ins = (n: number | null, depleted = false): InsertRow => ({
	insert_id: `i${n ?? 'x'}`, insert_code: `X-${n ?? 'x'}`, insert_number: n, is_depleted: depleted,
});
const edge = (i: string, l: string, used = false): EdgeRow => ({
	edge_id: `${i}${l}`, edge_code: `${i}-${l}`, insert_id: i, edge_identifier: l, is_used: used,
});
const model = buildToolingModel(
	{ tool_box_id: 'b', tool_box_code: 'B' }, { iso_designation: 'CNMG 12 04 08' },
	[ins(1), ins(2), ins(3, true), ins(null)],
	[
		...['A', 'B', 'C', 'D'].map((l) => edge('i1', l, l < 'C')),
		...['A', 'B', 'C', 'D', 'E'].map((l) => edge('i2', l)), // E has no place on a CNMG
		...['A', 'B'].map((l) => edge('i3', l, true)),
	],
);
const BOX: ToolingFocus = { kind: 'box' };
const I = (id: string): ToolingFocus => ({ kind: 'insert', insertId: id });
const E = (i: string, e: string): ToolingFocus => ({ kind: 'edge', insertId: i, edgeId: e });

describe('hoverLabel', () => {
	it('counts the fresh edges of an insert', () => {
		expect(hoverLabel(model, { kind: 'insert', insertId: 'i1' })).toBe('Insert 1 · 2/4 fresh');
		expect(hoverLabel(model, { kind: 'insert', insertId: 'i2' })).toBe('Insert 2 · 5/5 fresh');
	});
	it('says depleted for a depleted insert, and names an unnumbered insert by its code', () => {
		expect(hoverLabel(model, { kind: 'insert', insertId: 'i3' })).toBe('Insert 3 · depleted');
		expect(hoverLabel(model, { kind: 'insert', insertId: 'ix' })).toBe('Insert X-x · no edges');
	});
	it('names an edge by its insert number and letter, with its state', () => {
		expect(hoverLabel(model, { kind: 'edge', insertId: 'i1', edgeId: 'i1B' })).toBe('Edge 1B · used');
		expect(hoverLabel(model, { kind: 'edge', insertId: 'i1', edgeId: 'i1C' })).toBe('Edge 1C · fresh');
	});
	it('is empty for an id the model does not have', () => {
		expect(hoverLabel(model, { kind: 'insert', insertId: 'nope' })).toBe('');
		expect(hoverLabel(model, { kind: 'edge', insertId: 'i1', edgeId: 'nope' })).toBe('');
	});
});

describe('unplacedEdges', () => {
	it('lists the focused insert\'s edges with no place on the shape', () => {
		expect(unplacedEdges(model, I('i2')).map((e) => e.id)).toEqual(['i2E']);
		expect(unplacedEdges(model, E('i2', 'i2A')).map((e) => e.id)).toEqual(['i2E']);
	});
	it('is empty at box level or when everything is placed', () => {
		expect(unplacedEdges(model, BOX)).toEqual([]);
		expect(unplacedEdges(model, I('i1'))).toEqual([]);
	});
});

describe('stepFocus', () => {
	it('selects the first insert going forward from the box, the last going back', () => {
		expect(stepFocus(model, BOX, 'ArrowRight')).toEqual(I('i1'));
		expect(stepFocus(model, BOX, 'ArrowDown')).toEqual(I('i1'));
		expect(stepFocus(model, BOX, 'ArrowLeft')).toEqual(I('ix'));
	});

	it('steps through the edges of the focused insert', () => {
		expect(stepFocus(model, I('i1'), 'ArrowRight')).toEqual(E('i1', 'i1A'));
		expect(stepFocus(model, I('i1'), 'ArrowLeft')).toEqual(E('i1', 'i1D'));
		expect(stepFocus(model, E('i1', 'i1A'), 'ArrowRight')).toEqual(E('i1', 'i1B'));
		expect(stepFocus(model, E('i1', 'i1B'), 'ArrowUp')).toEqual(E('i1', 'i1A'));
	});

	it('stops at the ends of the edge list', () => {
		expect(stepFocus(model, E('i1', 'i1D'), 'ArrowRight')).toBeNull();
		expect(stepFocus(model, E('i1', 'i1A'), 'ArrowLeft')).toBeNull();
	});

	it('moves between inserts with Page Up and Page Down, or Shift with an arrow', () => {
		expect(stepFocus(model, I('i1'), 'PageDown')).toEqual(I('i2'));
		expect(stepFocus(model, E('i2', 'i2B'), 'PageUp')).toEqual(I('i1'));
		expect(stepFocus(model, E('i1', 'i1B'), 'ArrowRight', true)).toEqual(I('i2'));
		expect(stepFocus(model, I('i1'), 'PageUp')).toBeNull();
		expect(stepFocus(model, I('ix'), 'PageDown')).toBeNull();
	});

	it('does nothing for an empty box, an unknown insert or an insert with no edges', () => {
		const empty = buildToolingModel({ tool_box_id: 'b', tool_box_code: 'B' }, null, [], []);
		expect(stepFocus(empty, BOX, 'ArrowRight')).toBeNull();
		expect(stepFocus(model, I('nope'), 'ArrowRight')).toBeNull();
		expect(stepFocus(model, I('ix'), 'ArrowRight')).toBeNull();
	});
});

describe('escapeFocus', () => {
	it('goes up one level and stops at the box', () => {
		expect(escapeFocus(E('i1', 'i1A'))).toEqual(I('i1'));
		expect(escapeFocus(I('i1'))).toEqual(BOX);
		expect(escapeFocus(BOX)).toBeNull();
	});
});

describe('focusAnnouncement', () => {
	it('announces the box with its insert count', () => {
		expect(focusAnnouncement(model, BOX)).toBe('Tool box B, 4 inserts');
	});
	it('announces an insert with its fresh edges, or why it has none', () => {
		expect(focusAnnouncement(model, I('i1'))).toBe('Insert 1, 2 of 4 edges fresh');
		expect(focusAnnouncement(model, I('i3'))).toBe('Insert 3, depleted');
		expect(focusAnnouncement(model, I('ix'))).toBe('Insert X-x, no edges');
	});
	it('announces an edge with its state and face', () => {
		expect(focusAnnouncement(model, E('i1', 'i1B'))).toBe('Edge 1B, used, top face');
		expect(focusAnnouncement(model, E('i1', 'i1C'))).toBe('Edge 1C, fresh, underside');
		expect(focusAnnouncement(model, E('i2', 'i2E'))).toBe('Edge 2E, fresh, position unknown');
	});
	it('is empty for an id the model does not have', () => {
		expect(focusAnnouncement(model, I('nope'))).toBe('');
		expect(focusAnnouncement(model, E('i1', 'nope'))).toBe('');
	});
});
