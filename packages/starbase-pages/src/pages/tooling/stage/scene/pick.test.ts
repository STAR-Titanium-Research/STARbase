import { describe, expect, it } from 'vitest';
import { buildToolingModel, type EdgeRow, type InsertRow, type ToolingFocus } from '@d1/ui';
import { ghostInserts, partitionInstances, pickFromInstance, pickFromUserData, sameTarget, targetToFocus } from './pick';

const BOX: ToolingFocus = { kind: 'box' };
const edgeData = { kind: 'edge', insertId: 'i1', edgeId: 'e1' };

describe('pickFromUserData', () => {
	it('picks an insert from an insert mesh', () => {
		expect(pickFromUserData({ kind: 'insert', insertId: 'i1' }, BOX)).toEqual({ kind: 'insert', insertId: 'i1' });
	});

	it('picks the insert, not the edge, from the box or from another insert', () => {
		expect(pickFromUserData(edgeData, BOX)).toEqual({ kind: 'insert', insertId: 'i1' });
		expect(pickFromUserData(edgeData, { kind: 'insert', insertId: 'i2' })).toEqual({ kind: 'insert', insertId: 'i1' });
		expect(pickFromUserData(edgeData, { kind: 'edge', insertId: 'i2', edgeId: 'x' })).toEqual({ kind: 'insert', insertId: 'i1' });
	});

	it('picks the edge once its insert is focused', () => {
		expect(pickFromUserData(edgeData, { kind: 'insert', insertId: 'i1' })).toEqual({ kind: 'edge', insertId: 'i1', edgeId: 'e1' });
		expect(pickFromUserData(edgeData, { kind: 'edge', insertId: 'i1', edgeId: 'e9' })).toEqual({ kind: 'edge', insertId: 'i1', edgeId: 'e1' });
	});

	it('ignores anything that is not a pick tag', () => {
		for (const u of [null, undefined, 3, 'x', {}, { kind: 'insert' }, { kind: 'tray', insertId: 'i1' }, { kind: 'insert', insertId: '' }]) {
			expect(pickFromUserData(u, BOX)).toBeNull();
		}
		expect(pickFromUserData({ kind: 'edge', insertId: 'i1' }, { kind: 'insert', insertId: 'i1' })).toEqual({ kind: 'insert', insertId: 'i1' });
	});
});

describe('pickFromInstance', () => {
	const ids = ['a', 'b', 'c'];
	it('maps an instance id to its insert', () => {
		expect(pickFromInstance(ids, 1)).toEqual({ kind: 'insert', insertId: 'b' });
	});
	it('rejects a missing or out-of-range instance', () => {
		for (const i of [undefined, -1, 3, 1.5, Number.NaN]) expect(pickFromInstance(ids, i)).toBeNull();
	});
});

describe('targets', () => {
	it('turn into focus values', () => {
		expect(targetToFocus({ kind: 'insert', insertId: 'i1' })).toEqual({ kind: 'insert', insertId: 'i1' });
		expect(targetToFocus({ kind: 'edge', insertId: 'i1', edgeId: 'e1' })).toEqual({ kind: 'edge', insertId: 'i1', edgeId: 'e1' });
	});
	it('compare by value', () => {
		expect(sameTarget(null, null)).toBe(true);
		expect(sameTarget(null, { kind: 'insert', insertId: 'a' })).toBe(false);
		expect(sameTarget({ kind: 'insert', insertId: 'a' }, { kind: 'insert', insertId: 'a' })).toBe(true);
		expect(sameTarget({ kind: 'insert', insertId: 'a' }, { kind: 'insert', insertId: 'b' })).toBe(false);
		expect(sameTarget({ kind: 'edge', insertId: 'a', edgeId: '1' }, { kind: 'edge', insertId: 'a', edgeId: '2' })).toBe(false);
		expect(sameTarget({ kind: 'edge', insertId: 'a', edgeId: '1' }, { kind: 'insert', insertId: 'a' })).toBe(false);
	});
});

describe('ghosting and instance partitions', () => {
	const inserts: InsertRow[] = [1, 2, 3].map((n) => ({
		insert_id: `i${n}`, insert_code: `X-${n}`, insert_number: n, is_depleted: n === 3,
	}));
	const edges: EdgeRow[] = [];
	const model = buildToolingModel({ tool_box_id: 'b', tool_box_code: 'B' }, { iso_designation: 'CNMG120408' }, inserts, edges);

	it('ghosts only the depleted inserts at box level', () => {
		expect([...ghostInserts(model, BOX)]).toEqual(['i3']);
	});

	it('ghosts every other insert while one is focused', () => {
		expect([...ghostInserts(model, { kind: 'insert', insertId: 'i1' })].sort()).toEqual(['i2', 'i3']);
		expect([...ghostInserts(model, { kind: 'edge', insertId: 'i2', edgeId: 'x' })].sort()).toEqual(['i1', 'i3']);
	});

	it('keeps a depleted insert see-through even when it is the focus', () => {
		expect([...ghostInserts(model, { kind: 'insert', insertId: 'i3' })].sort()).toEqual(['i1', 'i2', 'i3']);
	});

	it('splits the ids in model order', () => {
		const p = partitionInstances(['i1', 'i2', 'i3'], new Set(['i2']));
		expect(p).toEqual({ solid: ['i1', 'i3'], ghost: ['i2'] });
	});
});
