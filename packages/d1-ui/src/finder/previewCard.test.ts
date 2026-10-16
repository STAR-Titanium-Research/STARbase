import { describe, expect, it } from 'vitest';
import { FINDER_SOURCES } from './finder';
import type { FinderHit } from './finder';
import { buildCard, bytesText, instantCard, previewKey, previewRequest } from './previewCard';

const hit = (collection: string, id: string, extra: Partial<FinderHit> = {}): FinderHit => ({
	group: 'Samples', label: 'LBL', to: `/x/${id}`, rank: 3, record: { collection, id }, ...extra,
});
const facts = (c: ReturnType<typeof buildCard>) => Object.fromEntries((c?.facts ?? []).map((f) => [f.label, f.value]));

describe('previewKey and previewRequest', () => {
	it('has a key for every record the finder can find, and for nothing else', () => {
		for (const s of FINDER_SOURCES) {
			expect(previewKey(hit(s.collection, '1')), s.collection).toBe(`${s.collection}:1`);
			expect(previewRequest(s.collection, '1')?.fields.length, s.collection).toBeGreaterThan(0);
		}
		expect(previewKey({ record: undefined })).toBeNull();
		expect(previewKey(hit('physical_samples', '1', { more: true }))).toBeNull();
		expect(previewKey(hit('unknown_table', '1'))).toBeNull();
		expect(previewKey(null)).toBeNull();
		expect(previewRequest('unknown_table', '1')).toBeNull();
	});

	it('reads one item with the card fields, files through /files', () => {
		expect(previewRequest('physical_samples', 'a b')?.path).toBe('/items/physical_samples/a%20b');
		expect(previewRequest('directus_files', 'f1')?.path).toBe('/files/f1');
	});

	it('asks for the relations the facts need and no more than the record pages read', () => {
		const sample = previewRequest('physical_samples', '1')!.fields;
		expect(sample).toEqual(expect.arrayContaining(['material_id.alloy_code', 'owner_person_id.full_name', 'owner_team_id.name', 'project_id.project_code']));
		// equipment.manufacturer_id has no directus_relations row on live (only facility_id does): reading it through would refuse the whole request
		expect(previewRequest('equipment', '1')!.fields).toEqual(expect.arrayContaining(['facility_id.name', 'manufacturer']));
		expect(previewRequest('equipment', '1')!.fields.join()).not.toContain('manufacturer_id');
		// the file owner has no Directus relation, so it is never asked for
		expect(previewRequest('directus_files', '1')!.fields.join()).not.toMatch(/owner|thumb/);
	});
});

describe('instantCard', () => {
	it('is the label, the kind, the detail and the matched line, with no facts', () => {
		const c = instantCard(hit('physical_samples', '1', { label: '12-ABC', detail: 'disc', matchedIn: 'notes', matchedSnippet: '…a crack…' }))!;
		expect(c).toMatchObject({ title: '12-ABC', kind: 'Sample', detail: 'disc', facts: [], matched: { field: 'notes', snippet: '…a crack…' } });
	});

	it('names a relation field without a value (never invents one)', () => {
		const c = instantCard(hit('physical_samples', '1', { matchedIn: 'owner' }))!;
		expect(c.matched).toEqual({ field: 'owner' });
	});

	it('leaves out a detail that only repeats the kind (inventory hits)', () => {
		const c = instantCard(hit('tools', '1', { group: 'Inventory', detail: 'Tool' }))!;
		expect(c.detail).toBeUndefined();
	});

	it('is null for a hit that is not a record', () => {
		expect(instantCard({ group: 'Pages', label: 'Samples', to: '/home/samples', rank: 3 })).toBeNull();
	});
});

describe('buildCard', () => {
	it('samples: material, geometry, status, owner, location, project, mass', () => {
		const c = buildCard(hit('physical_samples', '1'), {
			form: 'round_bar', current_status: 'in_use', location: 'Shelf 2', mass_grams: 12.5,
			material_id: { alloy_code: 'Ti64', common_name: 'Titanium 6-4' },
			project_id: { project_id: 'p1', project_code: 'PRJ-1' },
			owner_person_id: { full_name: 'Ada Lovelace' },
		})!;
		expect(c.kind).toBe('Sample · Round bar');
		expect(c.facts.map((f) => f.label)).toEqual(['Material', 'Geometry', 'Status', 'Owner', 'Location', 'Project', 'Mass']);
		expect(facts(c)).toEqual({ Material: 'Titanium 6-4', Geometry: 'Round bar', Status: 'In use', Owner: 'Ada Lovelace', Location: 'Shelf 2', Project: 'PRJ-1', Mass: '12.5 g' });
	});

	it('samples: a team owner names the owner; null relations are left out', () => {
		const c = buildCard(hit('physical_samples', '1'), { form: null, material_id: null, project_id: null, owner_person_id: null, owner_team_id: { name: 'Powder team' } })!;
		expect(facts(c)).toEqual({ Owner: 'Powder team' });
		expect(c.kind).toBe('Sample');
	});

	it('samples: a project that came back as a bare id is "Not visible to you", never the id', () => {
		const c = buildCard(hit('physical_samples', '1'), { project_id: 'p-hidden', owner_person_id: 'someone' })!;
		expect(facts(c)).toEqual({ Project: 'Not visible to you' });
		expect(JSON.stringify(c)).not.toContain('p-hidden');
		expect(JSON.stringify(c)).not.toContain('someone');
	});

	it('equipment: type, manufacturer, facility, location, active', () => {
		const c = buildCard(hit('equipment', '1', { group: 'Inventory' }), {
			equipment_type: 'Universal_Tester', manufacturer: 'Zwick', facility_id: { name: 'Diamond' }, location: 'Bay 3', is_active: false,
		})!;
		expect(facts(c)).toEqual({ Type: 'Universal tester', Manufacturer: 'Zwick', Facility: 'Diamond', Location: 'Bay 3', Active: 'No' });
		// a facility that came back as a bare id is left out, never printed
		expect(facts(buildCard(hit('equipment', '1'), { manufacturer: 'Zwick', facility_id: 'f' }))).toEqual({ Manufacturer: 'Zwick' });
	});

	it('operations: method, sample, machine, operator, date', () => {
		const c = buildCard(hit('manufacturing_operations', '1', { group: 'Operations' }), {
			process_category: 'Machining', operation_date: '2026-03-04', operator_name: 'free text',
			method_id: { method_name: 'Turning' }, equipment_id: { equipment_name: 'NLX' }, operator_person_id: { full_name: 'Grace Hopper' },
			sample_id: { sample_id: 's1', sample_code: '12-ABC' },
		})!;
		expect(c.kind).toBe('Operation · Machining');
		expect(c.facts.map((f) => f.label)).toEqual(['Method', 'Sample', 'Machine', 'Operator', 'Date']);
		expect(facts(c)).toMatchObject({ Method: 'Turning', Sample: '12-ABC', Machine: 'NLX', Operator: 'Grace Hopper', Date: '4 Mar 2026' });
	});

	it('operations: a missing operator person falls back to the typed name; a hidden sample is flagged; undated reads Undated', () => {
		const c = buildCard(hit('manufacturing_operations', '1'), { operator_name: 'free text', sample_id: 'hidden-id', operation_date: null })!;
		expect(facts(c)).toEqual({ Sample: 'Not visible to you', Operator: 'free text', Date: 'Undated' });
	});

	it('tests: type, status, sample, date', () => {
		const c = buildCard(hit('test_sessions', '1', { group: 'Tests' }), { test_type: 'tensile', status: 'completed', session_date: '2026-01-02', sample_id: { sample_id: 's', sample_code: 'S-1' } })!;
		expect(c.kind).toBe('Test');
		expect(facts(c)).toEqual({ Type: 'Tensile', Status: 'Completed', Sample: 'S-1', Date: '2 Jan 2026' });
		expect(facts(buildCard(hit('test_sessions', '1'), { test_type: 'tensile', sample_id: 'x' }))).toEqual({ Type: 'Tensile', Sample: 'Not visible to you' });
		expect(facts(buildCard(hit('test_sessions', '1'), { test_type: 'tensile', sample_id: null }))).toEqual({ Type: 'Tensile' });
	});

	it('files: type, size, uploaded, archive path; no thumbnail and no owner', () => {
		const c = buildCard(hit('directus_files', 'f', { group: 'Files', label: 'scan.tif' }), {
			type: 'image/tiff', filesize: '2621440', uploaded_on: '2026-02-03T10:00:00Z', metadata: { archive_path: 'sem/scan.tif' },
		})!;
		expect(c).toMatchObject({ title: 'scan.tif', kind: 'File', icon: 'inbox' });
		expect(facts(c)).toEqual({ Type: 'image/tiff', Size: '2.5 MB', Uploaded: '3 Feb 2026', 'Archive path': 'sem/scan.tif' });
		expect(Object.keys(c)).not.toContain('thumbnail');
		expect(facts(buildCard(hit('directus_files', 'f'), { type: null, filesize: null, metadata: null }))).toEqual({});
	});

	it('the minimal cards give a kind and two facts', () => {
		const material = buildCard(hit('materials', '1', { group: 'Reference' }), { common_name: 'Ti-6Al-4V', density_g_per_cm3: '4.43' })!;
		expect(material.kind).toBe('Material');
		expect(facts(material)).toEqual({ Name: 'Ti-6Al-4V', Density: '4.43 g/cm³' });
		expect(facts(buildCard(hit('campaigns', '1'), { status: 'in_progress', campaign_type: 'machining_trial' }))).toEqual({ Status: 'In progress', Type: 'Machining trial' });
		expect(facts(buildCard(hit('projects', '1'), { principal_investigator_name: 'Dr X', is_active: true }))).toEqual({ 'Principal investigator': 'Dr X', Active: 'Yes' });
		expect(facts(buildCard(hit('people', '1'), { email: 'a@b.c', is_operator: true, is_researcher: true, active: true }))).toEqual({ Role: 'Operator, Researcher', Active: 'Yes' });
		expect(previewRequest('people', '1')!.fields).not.toContain('email');
		expect(facts(buildCard(hit('tools', '1'), { tool_name: 'Drill', tool_type: 'drill', is_active: true }))).toEqual({ Name: 'Drill', Type: 'drill' });
		expect(facts(buildCard(hit('tool_boxes', '1'), { description: 'Box', location: null }))).toEqual({ Description: 'Box' });
		expect(facts(buildCard(hit('cutting_inserts', '1'), { location: 'Drawer', is_depleted: false }))).toEqual({ Location: 'Drawer', Depleted: 'No' });
		expect(facts(buildCard(hit('insert_edges', '1'), { edge_identifier: 'A', is_used: true }))).toEqual({ Edge: 'A', Used: 'Yes' });
		expect(facts(buildCard(hit('raw_stock_lots', '1'), { stock_type: 'bar', supplier_name: 'Acme', remaining_mass_grams: 1200 }))).toEqual({ Supplier: 'Acme', Remaining: '1,200 g' });
	});

	it('keeps the matched line and the detail of the hit on the finished card', () => {
		const c = buildCard(hit('physical_samples', '1', { detail: 'disc', matchedIn: 'location', matchedSnippet: 'Shelf 2' }), { location: 'Shelf 2' })!;
		expect(c.detail).toBe('disc');
		expect(c.matched).toEqual({ field: 'location', snippet: 'Shelf 2' });
	});

	it('a row that is not an object gives just the instant part', () => {
		expect(buildCard(hit('physical_samples', '1'), null)).toEqual(instantCard(hit('physical_samples', '1')));
		expect(buildCard(hit('physical_samples', '1'), 'oops')?.facts).toEqual([]);
		expect(buildCard({ group: 'Pages', label: 'x', to: '/x', rank: 3 }, {})).toBeNull();
	});
});

describe('bytesText', () => {
	it('reads sizes, and nothing for a bad value', () => {
		expect(bytesText(512)).toBe('512 B');
		expect(bytesText(2048)).toBe('2.0 KB');
		expect(bytesText('1073741824')).toBe('1.0 GB');
		expect(bytesText(null)).toBe('');
		expect(bytesText(-1)).toBe('');
		expect(bytesText('abc')).toBe('');
	});
});
