import { describe, expect, it } from 'vitest';
import { resolveInsertGeometry } from './insertGeometry';
import { boxRailFacts, edgeRailFacts, insertRailFacts, placementText, typeFacts } from './toolingFacts';
import { visibleFacts } from '../record/facts';

const type = {
	type_code: 'CNMG120408-MF', iso_designation: 'CNMG 12 04 08-MF', manufacturer: 'old text', manufacturer_id: 'm1',
	coating: 'TiAlN', substrate: null, material_class: '', edge_count: 8, inserts_per_box: '10',
};

describe('typeFacts', () => {
	it('reads the maker from the separately read manufacturer name, then the type\'s own text', () => {
		const maker = (name?: string | null) => typeFacts(type, null, name).find((f) => f.label === 'Manufacturer')?.value;
		expect(maker('Sandvik')).toBe('Sandvik');
		expect(maker('')).toBe('old text'); // the role may not read manufacturers
		expect(maker(undefined)).toBe('old text');
		expect(typeFacts({ ...type, manufacturer: null }).find((f) => f.label === 'Manufacturer')?.value).toBe('');
	});
	it('leaves out what the type does not say', () => {
		const labels = visibleFacts(typeFacts(type)).map((f) => f.label);
		expect(labels).toEqual(['Type', 'ISO designation', 'Manufacturer', 'Coating', 'Edges per insert', 'Inserts per box']);
		expect(visibleFacts(typeFacts(type)).find((f) => f.label === 'Inserts per box')?.value).toBe(10);
	});
	it('falls back to the geometry for edges per insert, and is empty without a type', () => {
		const geometry = resolveInsertGeometry({ iso_designation: 'CNMG 12 04 08' });
		expect(typeFacts({ iso_designation: 'CNMG 12 04 08' }, geometry).find((f) => f.label === 'Edges per insert')?.value).toBe(4);
		expect(typeFacts(null)).toEqual([]);
	});
});

describe('rail facts', () => {
	it('links the project and the parents through recordRoute', () => {
		const box = boxRailFacts({ insert_type_id: { type_code: 'T1' }, project_id: { project_id: 'p1', project_code: 'H13' }, location: 'Shelf 2' });
		expect(box.find((f) => f.label === 'Project')).toMatchObject({ value: 'H13', to: '/home/projects/p1' });
		expect(insertRailFacts({ insert_number: 3, is_depleted: false }, 'b1', 'BOX-1')[0]).toMatchObject({ value: 'BOX-1', to: '/home/tool-boxes/b1' });
		const edge = edgeRailFacts({ edge_identifier: 'fC', is_used: true }, { boxId: 'b1', boxCode: 'BOX-1' }, { id: 'i1', code: 'I-3' }, {
			id: 'e', code: 'I-3-fC', identifier: 'fC', letter: 'C', used: true, notes: null, placement: { face: 'bottom', corner: 0 },
		});
		expect(edge.find((f) => f.label === 'Insert')).toMatchObject({ to: '/home/inserts/i1' });
		expect(edge.find((f) => f.label === 'Edge letter')?.value).toBe('C');
		expect(edge.find((f) => f.label === 'Position')?.value).toBe('Underside');
		expect(edge.find((f) => f.label === 'Marked used')?.value).toBe('Yes');
	});
	it('says a project the user may not read is not visible, and leaves out a box with no project', () => {
		const hiddenProject = boxRailFacts({ project_id: null }, { project_id: true }).find((f) => f.label === 'Project');
		expect(hiddenProject).toMatchObject({ hidden: true, value: null });
		// A link that came back as a bare id (no read access to projects) is hidden too.
		expect(boxRailFacts({ project_id: 'p9' }).find((f) => f.label === 'Project')).toMatchObject({ hidden: true });
		const none = boxRailFacts({ project_id: null }).find((f) => f.label === 'Project');
		expect(none?.hidden).toBeUndefined();
		expect(visibleFacts(boxRailFacts({ project_id: null })).map((f) => f.label)).not.toContain('Project');
		expect(visibleFacts(boxRailFacts({ project_id: null }, { project_id: true })).map((f) => f.label)).toContain('Project');
	});
	it('is empty without a record', () => {
		expect(boxRailFacts(null)).toEqual([]);
		expect(insertRailFacts(null, 'b', 'c')).toEqual([]);
	});
});

describe('placementText', () => {
	it('says the face, or why there is no position', () => {
		expect(placementText({ letter: 'A', placement: { face: 'top', corner: 0 } })).toBe('Top face');
		expect(placementText({ letter: 'E', placement: null })).toBe('Position unknown');
		expect(placementText({ letter: null, placement: null })).toBe('No edge letter');
	});
});
