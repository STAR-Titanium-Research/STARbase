import { describe, expect, it } from 'vitest';
import { INDEX_DEFS } from './index/indexConfig';
import { collectionRoute, dataStudioRoute, indexRoute, recordRoute } from './recordRoute';

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
		expect(collectionRoute('audit_logs')).toBe('/content/audit_logs');
	});
	it('uses /home/<slug> for every index page, plus projects and people', () => {
		expect(INDEX_DEFS).toHaveLength(20);
		for (const d of INDEX_DEFS) expect(collectionRoute(d.collection)).toBe(`/home/${d.slug}`);
		expect(collectionRoute('test_sessions')).toBe('/home/tests');
		expect(collectionRoute('projects')).toBe('/home/projects');
		expect(collectionRoute('people')).toBe('/home/people');
	});
});

describe('dataStudioRoute', () => {
	it('always points at the form', () => {
		expect(dataStudioRoute('physical_samples', 'abc')).toBe('/content/physical_samples/abc');
	});
});

describe('indexRoute', () => {
	it('adds the bookmark and the open row to an index page', () => {
		expect(indexRoute('physical_samples')).toBe('/home/samples');
		expect(indexRoute('physical_samples', { bookmark: 7 })).toBe('/home/samples?bookmark=7');
		expect(indexRoute('tools', { open: 'a/b' })).toBe('/home/tools?open=a%2Fb');
		expect(indexRoute('tools', { bookmark: 2, open: 'x' })).toBe('/home/tools?bookmark=2&open=x');
	});
	it('carries extra query keys, escaped, after the bookmark and open row', () => {
		expect(indexRoute('manufacturing_operations', { query: { q: 'A 12/3' } })).toBe('/home/operations?q=A%2012%2F3');
		expect(indexRoute('campaigns', { query: { 'f.project_id': 'p-1' } })).toBe('/home/campaigns?f.project_id=p-1');
		expect(indexRoute('physical_samples', { bookmark: 7, query: { q: 'x' } })).toBe('/home/samples?bookmark=7&q=x');
		expect(indexRoute('physical_samples', { query: {} })).toBe('/home/samples');
		expect(indexRoute('physical_samples', { query: { q: '' } })).toBe('/home/samples');
	});
	it('gives the bespoke pages the plain path, since they ignore both', () => {
		expect(indexRoute('projects', { bookmark: 3 })).toBe('/home/projects');
		expect(indexRoute('people', { open: 'x' })).toBe('/home/people');
		expect(indexRoute('projects', { query: { q: 'x' } })).toBe('/home/projects');
	});
	it('falls back to the Data Studio list for an unknown collection', () => {
		expect(indexRoute('audit_logs')).toBe('/content/audit_logs');
		expect(indexRoute('audit_logs', { bookmark: 5 })).toBe('/content/audit_logs?bookmark=5');
	});
});
