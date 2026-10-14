import { describe, expect, it } from 'vitest';
import { MAP_ROW_COLLECTIONS, mapPath } from '../mapLink';

describe('mapPath', () => {
	it('encodes the id', () => {
		expect(mapPath('tools', 'a b/c')).toBe('/map?focus=tools:a%20b%2Fc');
		expect(mapPath('equipment', '3f2a-uuid')).toBe('/map?focus=equipment:3f2a-uuid');
	});
});

describe('MAP_ROW_COLLECTIONS', () => {
	it('lists the seven kinds with a row action: those with no record page, and insert edges', () => {
		expect([...MAP_ROW_COLLECTIONS].sort()).toEqual(['equipment', 'fast_recipes', 'insert_edges', 'materials', 'prep_recipes', 'raw_stock_lots', 'tools']);
	});
});
