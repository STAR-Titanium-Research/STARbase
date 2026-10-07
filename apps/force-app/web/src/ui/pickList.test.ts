import { describe, expect, it } from 'vitest';
import { pickRows } from './pickList';

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const idOf = (it: { id: string }) => it.id;

describe('pickRows', () => {
	it('passes everything through unmarked by default', () => {
		const rows = pickRows(items, idOf);
		expect(rows.map((r) => r.item.id)).toEqual(['a', 'b', 'c']);
		expect(rows.every((r) => !r.current && !r.picked)).toBe(true);
	});

	it('single-value: marks the current value but keeps it pickable', () => {
		const rows = pickRows(items, idOf, { currentId: 'b' });
		expect(rows.map((r) => r.current)).toEqual([false, true, false]);
		expect(rows.every((r) => !r.picked)).toBe(true);
	});

	it('multi-pick: hides already-picked items', () => {
		const rows = pickRows(items, idOf, { selectedIds: ['a', 'c'], hideSelected: true });
		expect(rows.map((r) => r.item.id)).toEqual(['b']);
	});

	it('picked items that are not hidden are shown disabled', () => {
		const rows = pickRows(items, idOf, { selectedIds: ['a'] });
		expect(rows[0]).toMatchObject({ picked: true });
		expect(rows[1]).toMatchObject({ picked: false });
	});

	it('an empty currentId marks nothing', () => {
		expect(pickRows([{ id: '' }], idOf, { currentId: '' })[0].current).toBe(false);
	});
});
