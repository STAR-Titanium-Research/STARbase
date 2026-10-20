import { describe, expect, it } from 'vitest';
import { GEAR_READS, gearIn, gearKey, gearProblem, gearToRead } from './gearStatus';

describe('gear state', () => {
	it('says a retired machine or tool and a used-up edge, and nothing for the rest', () => {
		expect(gearProblem('equipment_id', { equipment_name: 'Lathe 1', is_active: false })).toBe('The machine Lathe 1 is retired.');
		expect(gearProblem('equipment_id', { equipment_code: 'NLX', is_active: false })).toBe('The machine NLX is retired.');
		expect(gearProblem('equipment_id', { equipment_name: 'Lathe 1', is_active: true })).toBeNull();
		expect(gearProblem('tool_id', { tool_name: 'Holder 3', is_active: false })).toBe('The tool Holder 3 is retired.');
		expect(gearProblem('tool_id', { tool_name: 'Holder 3' })).toBeNull();
		expect(gearProblem('insert_edge_id', { edge_code: 'H13A-#2-fC', is_used: true })).toBe('The cutting edge H13A-#2-fC is used up.');
		expect(gearProblem('insert_edge_id', { is_used: true })).toBe('The cutting edge is used up.');
		expect(gearProblem('insert_edge_id', { edge_code: 'x', is_used: false })).toBeNull();
	});

	it('reads the machine, tool and edge from the tables that hold them', () => {
		expect(GEAR_READS.equipment_id).toMatchObject({ collection: 'equipment', key: 'equipment_id' });
		expect(GEAR_READS.tool_id).toMatchObject({ collection: 'tools', key: 'tool_id' });
		expect(GEAR_READS.insert_edge_id).toMatchObject({ collection: 'insert_edges', key: 'edge_id' });
	});

	it('finds the gear a set of values names, and the ids still to read', () => {
		expect(gearIn({ equipment_id: 'e1', tool_id: '', insert_edge_id: 'g1', other: 'x' })).toEqual([{ field: 'equipment_id', id: 'e1' }, { field: 'insert_edge_id', id: 'g1' }]);
		const todo = gearToRead([{ field: 'equipment_id', id: 'e1' }, { field: 'equipment_id', id: 'e1' }, { field: 'equipment_id', id: 'e2' }, { field: 'tool_id', id: 't1' }], (k) => k === gearKey('equipment_id', 'e2'));
		expect(todo).toEqual({ equipment_id: ['e1'], tool_id: ['t1'], insert_edge_id: [] });
	});
});
