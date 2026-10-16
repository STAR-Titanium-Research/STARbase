import { describe, expect, it } from 'vitest';
import type { HostApi } from '../host';
import { itemsPath, optionFor, pickerSource, renderTemplate, searchOptions, searchParams, templateFields, toOption } from './recordSource';

function fakeApi(handler: (path: string, config?: any) => unknown): HostApi & { calls: { path: string; params: any }[] } {
	const calls: { path: string; params: any }[] = [];
	const get = async (path: string, config?: any) => {
		calls.push({ path, params: config?.params });
		const out = handler(path, config);
		if (out instanceof Error) throw out;
		return { data: { data: out } };
	};
	return { get, post: async () => ({ data: {} }), patch: async () => ({ data: {} }), delete: async () => ({ data: {} }), calls } as any;
}

const MATERIAL = { collection: 'materials', key: 'material_id', template: '{{common_name}} ({{alloy_code}})' };

describe('templates', () => {
	it('lists the columns a template names, nested ones dotted, once each', () => {
		expect(templateFields('{{common_name}} ({{alloy_code}}) {{alloy_code}}')).toEqual(['common_name', 'alloy_code']);
		expect(templateFields('{{a.b}}')).toEqual(['a.b']);
		expect(templateFields(null)).toEqual([]);
	});
	it('fills a template from a row and tidies what a blank leaves', () => {
		expect(renderTemplate('{{common_name}} ({{alloy_code}})', { common_name: 'Titanium', alloy_code: 'Ti64' })).toBe('Titanium (Ti64)');
		expect(renderTemplate('{{common_name}} ({{alloy_code}})', { common_name: 'Titanium', alloy_code: null })).toBe('Titanium');
		expect(renderTemplate('{{sample_code}} – {{nickname}}', { sample_code: 'S-1', nickname: '' })).toBe('S-1');
		expect(renderTemplate('{{sample_code}} – {{nickname}}', { sample_code: '', nickname: 'Rod' })).toBe('Rod');
		expect(renderTemplate('{{first_name}} {{last_name}}', { first_name: 'Ada', last_name: 'L' })).toBe('Ada L');
		expect(renderTemplate('{{a.b}}', { a: { b: 'deep' } })).toBe('deep');
	});
	it('system collections have their own endpoint', () => {
		expect(itemsPath('materials')).toBe('/items/materials');
		expect(itemsPath('directus_users')).toBe('/users');
	});
});

describe('a collection the finder searches', () => {
	const samples = pickerSource({ collection: 'physical_samples', key: 'sample_id' });

	it('uses the finder source: its fields, its match columns, its labels', () => {
		expect(samples.finder?.group).toBe('Samples');
		expect(samples.fields).toEqual(['sample_id', 'sample_code', 'nickname', 'short_id']);
		const p = searchParams(samples, 'ti64');
		expect(p.fields).toEqual(samples.fields);
		expect(p.limit).toBe(8);
		expect(JSON.parse(p.filter as string)).toEqual({ _or: [{ sample_code: { _icontains: 'ti64' } }, { nickname: { _icontains: 'ti64' } }] });
		expect(toOption(samples, { sample_id: 's1', sample_code: 'S-1', nickname: 'Rod' })).toEqual({ id: 's1', label: 'S-1', detail: 'Rod' });
	});

	it('nothing typed lists plain rows; one typed letter already filters (the finder\'s two-character minimum is not the picker\'s)', () => {
		expect(searchParams(samples, '')).toEqual({ fields: samples.fields, limit: 8 });
		expect(searchParams(samples, '  ')).toEqual({ fields: samples.fields, limit: 8 });
		const one = searchParams(samples, ' a ');
		expect(JSON.parse(one.filter as string)).toEqual({ _or: [{ sample_code: { _icontains: 'a' } }, { nickname: { _icontains: 'a' } }] });
		expect(one.limit).toBe(8);
	});

	it('operations use the finder label (pass code, else the sample and step)', () => {
		const ops = pickerSource({ collection: 'manufacturing_operations', key: 'operation_id' });
		expect(toOption(ops, { operation_id: 'o1', pass_code: 'MT-F1' })?.label).toBe('MT-F1');
	});

	it('people are found by full name', () => {
		const people = pickerSource({ collection: 'people', key: 'person_id', template: '{{full_name}}' });
		expect(JSON.parse(searchParams(people, 'ada').filter as string)).toEqual({ _or: [{ full_name: { _icontains: 'ada' } }] });
		expect(toOption(people, { person_id: 'p1', full_name: 'Ada L' })).toEqual({ id: 'p1', label: 'Ada L' });
	});

	it('searches through the host api and maps the rows', async () => {
		const api = fakeApi(() => [{ sample_id: 's1', sample_code: 'S-1', nickname: '' }, { sample_id: 's2', sample_code: 'S-2' }, null]);
		const options = await searchOptions(api, samples, 'S-');
		expect(api.calls[0].path).toBe('/items/physical_samples');
		expect(options.map((o) => o.id)).toEqual(['s1', 's2']);
	});
});

describe('any other collection', () => {
	const materials = pickerSource(MATERIAL);

	it('asks for the key and the template columns and searches with Directus `search`', () => {
		expect(materials.finder).toBeNull();
		expect(materials.fields).toEqual(['material_id', 'common_name', 'alloy_code']);
		expect(searchParams(materials, ' Ti ')).toEqual({ fields: materials.fields, limit: 8, search: 'Ti' });
		expect(searchParams(materials, '')).toEqual({ fields: materials.fields, limit: 8 });
	});

	it('labels from the template, falls back to the key', () => {
		expect(toOption(materials, { material_id: 'm1', common_name: 'Titanium', alloy_code: 'Ti64' })).toEqual({ id: 'm1', label: 'Titanium (Ti64)' });
		expect(toOption(materials, { material_id: 'm2', common_name: null, alloy_code: null })).toEqual({ id: 'm2', label: 'm2' });
		expect(toOption(materials, { common_name: 'no key' })).toBeNull();
	});

	it('with no template, reads every column and labels by the first code or name', () => {
		const equipment = pickerSource({ collection: 'facilities', key: 'facility_id' });
		expect(equipment.fields).toEqual(['*']);
		expect(toOption(equipment, { facility_id: 'e1', created_at: 'x', facility_code: 'LAB-1', name: 'Lab' })?.label).toBe('LAB-1');
		expect(toOption(equipment, { facility_id: 'e2', notes: 'n' })?.label).toBe('e2');
	});

	it('a key-less definition falls back to `id`', () => {
		expect(pickerSource({ collection: 'fast_recipes', template: '{{name}}' }).fields).toEqual(['id', 'name']);
	});

	it('a refusal rejects the search (the picker says it could not search)', async () => {
		const api = fakeApi(() => new Error('403'));
		await expect(searchOptions(api, materials, 'Ti')).rejects.toThrow('403');
	});

	it('shows no options when the answer is not a list', async () => {
		expect(await searchOptions(fakeApi(() => null), materials, 'Ti')).toEqual([]);
	});
});

describe('optionFor', () => {
	it('reads one record by its key for the label', async () => {
		const api = fakeApi(() => ({ material_id: 'm 1', common_name: 'Titanium', alloy_code: 'Ti64' }));
		expect(await optionFor(api, pickerSource(MATERIAL), 'm 1')).toEqual({ id: 'm 1', label: 'Titanium (Ti64)' });
		expect(api.calls[0]).toEqual({ path: '/items/materials/m%201', params: { fields: ['material_id', 'common_name', 'alloy_code'] } });
	});
	it('is null when the record cannot be read', async () => {
		expect(await optionFor(fakeApi(() => new Error('404')), pickerSource(MATERIAL), 'gone')).toBeNull();
	});
});
