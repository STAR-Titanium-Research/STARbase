import { describe, expect, it } from 'vitest';
import { NAV_GROUPS } from '../nav/navConfig';
import { INDEX_DEFS, indexDefByCollection, indexDefBySlug } from './indexConfig';

const BESPOKE = ['projects', 'people'];
const navLinks = NAV_GROUPS.flatMap((g) => g.links).filter((l) => l.collection);

describe('INDEX_DEFS', () => {
	it('has the 20 entries of the spec', () => {
		expect(INDEX_DEFS).toHaveLength(20);
	});

	it('has unique, URL-safe slugs and unique collections', () => {
		const slugs = INDEX_DEFS.map((d) => d.slug);
		expect(new Set(slugs).size).toBe(20);
		for (const s of slugs) expect(s).toMatch(/^[a-z][a-z0-9-]*$/);
		expect(new Set(INDEX_DEFS.map((d) => d.collection)).size).toBe(20);
	});

	it('matches the navigation: every entry has a link to /home/<slug> and vice versa', () => {
		for (const d of INDEX_DEFS) {
			const link = navLinks.find((l) => l.collection === d.collection);
			expect(link, d.collection).toBeDefined();
			expect(link!.to).toBe(`/home/${d.slug}`);
		}
		const indexed = new Set(INDEX_DEFS.map((d) => d.collection));
		for (const l of navLinks) {
			if (!BESPOKE.includes(l.collection!)) expect(indexed.has(l.collection!), l.label).toBe(true);
		}
	});

	it('puts each entry in the nav group of its own group', () => {
		for (const d of INDEX_DEFS) {
			const group = NAV_GROUPS.find((g) => g.links.some((l) => l.collection === d.collection));
			expect(group?.id, d.collection).toBe(d.group);
		}
	});

	it('has a primary key, columns and a search field everywhere', () => {
		for (const d of INDEX_DEFS) {
			expect(d.primaryKey, d.slug).toBeTruthy();
			expect(d.columns.length, d.slug).toBeGreaterThan(0);
			expect(d.searchFields.length, d.slug).toBeGreaterThan(0);
		}
	});

	it('sorts by, and searches, a column or a dotted relation path', () => {
		for (const d of INDEX_DEFS) {
			const fields = new Set([d.primaryKey, ...d.columns.map((c) => c.field)]);
			const sortField = d.defaultSort.replace(/^-/, '');
			// created_at is the default newest-first sort on collections that do not show it as a column.
			expect(fields.has(sortField) || sortField === 'created_at', `${d.slug} sort ${sortField}`).toBe(true);
			for (const s of d.searchFields) {
				expect(fields.has(s) || s.includes('.'), `${d.slug} search ${s}`).toBe(true);
				if (s.includes('.')) expect(fields.has(s.split('.')[0]), `${d.slug} path ${s}`).toBe(true);
			}
		}
	});

	it('describes each chip filter fully, once per field', () => {
		for (const d of INDEX_DEFS) {
			for (const f of d.filters) {
				expect(f.label, d.slug).toBeTruthy();
				if (f.options.kind === 'relation') {
					expect(f.options.collection).toBeTruthy();
					expect(f.options.display).toBeTruthy();
				}
			}
			expect(new Set(d.filters.map((f) => f.field)).size, d.slug).toBe(d.filters.length);
		}
	});

	it('gives relation columns their display field', () => {
		for (const d of INDEX_DEFS) {
			for (const c of d.columns.filter((x) => x.relation)) {
				expect(c.relation!.collection, `${d.slug}.${c.field}`).toBeTruthy();
				expect(c.relation!.display, `${d.slug}.${c.field}`).toBeTruthy();
			}
		}
	});

	it('opens the four core collections on their record page and the rest in the drawer', () => {
		const record = INDEX_DEFS.filter((d) => d.rowTarget === 'record').map((d) => d.collection);
		expect(record.sort()).toEqual(['campaigns', 'manufacturing_operations', 'physical_samples', 'test_sessions']);
		expect(INDEX_DEFS.filter((d) => d.rowTarget === 'drawer')).toHaveLength(16);
	});

	it('uses the spec primary keys', () => {
		const pk = (c: string) => indexDefByCollection(c)!.primaryKey;
		expect(pk('Machine_Operators')).toBe('id');
		expect(pk('material_iso_classifications')).toBe('iso_code');
		expect(pk('fast_recipes')).toBe('id');
		expect(pk('insert_edges')).toBe('edge_id');
		expect(pk('cutting_inserts')).toBe('insert_id');
		expect(pk('raw_stock_lots')).toBe('lot_id');
		expect(pk('tool_boxes')).toBe('tool_box_id');
		expect(pk('manufacturing_methods')).toBe('method_id');
		expect(pk('insert_types')).toBe('insert_type_id');
		expect(pk('physical_samples')).toBe('sample_id');
		expect(pk('test_sessions')).toBe('session_id');
	});

	it('flags a short id on samples, operations and tests only', () => {
		expect(INDEX_DEFS.filter((d) => d.hasShortId).map((d) => d.slug)).toEqual(['samples', 'operations', 'tests']);
	});

	it('lets operations and tests be narrowed to one campaign (the Campaign page counts link here)', () => {
		for (const slug of ['operations', 'tests']) {
			const d = indexDefBySlug(slug)!;
			expect(d.filters.find((f) => f.field === 'campaign_id'), slug).toEqual({
				field: 'campaign_id', label: 'Campaign', options: { kind: 'relation', collection: 'campaigns', display: 'campaign_code', fallback: 'name' },
			});
		}
		expect(indexDefBySlug('operations')!.filters.map((f) => f.label)).toEqual(['Project', 'Campaign', 'Method', 'Process category', 'With force data']);
		expect(indexDefBySlug('operations')!.filters.at(-1)).toEqual({
			field: 'has_force', label: 'With force data',
			options: { kind: 'flag', filter: { force_analyses: { _some: { status: { _eq: 'done' } } } } },
		});
		expect(indexDefBySlug('tests')!.filters.map((f) => f.label)).toEqual(['Project', 'Campaign', 'Type', 'Status']);
	});

	it('follows the spec table for samples', () => {
		const d = indexDefBySlug('samples')!;
		expect(d.columns.map((c) => c.field)).toEqual([
			'sample_code', 'nickname', 'material_id', 'project_id', 'form', 'current_status', 'location', 'created_at',
		]);
		expect(d.searchFields).toEqual(['sample_code', 'nickname']);
		expect(d.filters.map((f) => f.label)).toEqual(['Project', 'Status', 'Material']);
		expect(d.defaultSort).toBe('-created_at');
	});
});

describe('lookups', () => {
	it('finds a definition by slug or collection', () => {
		expect(indexDefBySlug('stock-lots')?.collection).toBe('raw_stock_lots');
		expect(indexDefByCollection('raw_stock_lots')?.slug).toBe('stock-lots');
	});

	it('returns undefined for the bespoke pages and unknown names', () => {
		expect(indexDefBySlug('projects')).toBeUndefined();
		expect(indexDefByCollection('people')).toBeUndefined();
		expect(indexDefBySlug('nope')).toBeUndefined();
	});
});
