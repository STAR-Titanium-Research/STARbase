import { describe, expect, it } from 'vitest';
import { collectionRoute, dataStudioRoute, recordRoute } from './recordRoute';

describe('recordRoute', () => {
	it.each([
		['physical_samples', '/home/samples/abc'],
		['manufacturing_operations', '/home/operations/abc'],
		['test_sessions', '/home/tests/abc'],
		['campaigns', '/home/campaigns/abc'],
		['projects', '/home/projects/abc'],
	])('%s has an Explorer page', (collection, route) => {
		expect(recordRoute(collection, 'abc')).toBe(route);
	});

	it('falls back to the Data Studio form for collections without a page', () => {
		expect(recordRoute('raw_stock_lots', 'lot-1')).toBe('/content/raw_stock_lots/lot-1');
		expect(recordRoute('equipment', 'e1')).toBe('/content/equipment/e1');
	});

	it('accepts numeric ids and escapes anything that is not path-safe', () => {
		expect(recordRoute('physical_samples', 7)).toBe('/home/samples/7');
		expect(recordRoute('physical_samples', 'a/b?c')).toBe('/home/samples/a%2Fb%3Fc');
	});
});

describe('collectionRoute', () => {
	it('uses the Explorer index when there is one', () => {
		expect(collectionRoute('projects')).toBe('/home/projects');
	});
	it('uses the Data Studio list otherwise', () => {
		expect(collectionRoute('test_sessions')).toBe('/content/test_sessions');
	});
});

describe('dataStudioRoute', () => {
	it('always points at the form', () => {
		expect(dataStudioRoute('physical_samples', 'abc')).toBe('/content/physical_samples/abc');
	});
});
