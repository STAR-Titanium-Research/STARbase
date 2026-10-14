import { describe, expect, it } from 'vitest';
import { OPERATION_DEFS, SAMPLE_DEFS, TEST_DEFS } from './fieldDefs.fixtures';
import { choiceText, displayText, fieldViews, formTree, isEmptyValue, missingRequired, toFormFields } from './fieldModel';
import type { FormField, FormNode } from './fieldModel';

const byName = (fields: FormField[], name: string): FormField => {
	const f = fields.find((x) => x.field === name);
	if (!f) throw new Error(`no field ${name}`);
	return f;
};
const names = (nodes: FormNode[]): string[] => nodes.map((n) => n.field.field);

describe('toFormFields: samples', () => {
	const fields = toFormFields(SAMPLE_DEFS);

	it('sorts as Data Studio does (sort, then the order sent) and keeps groups', () => {
		const inWhat = fields.filter((f) => f.group === 'grp_what').map((f) => f.field);
		expect(inWhat).toEqual(['sample_code', 'nickname', 'current_status']);
		expect(fields.filter((f) => f.kind === 'group').map((f) => f.field)).toEqual([
			'grp_what', 'grp_material', 'grp_geometry', 'grp_surface', 'grp_who_where', 'grp_notes', 'grp_related', 'grp_legacy',
		]);
	});

	it('leaves out the key, server stamps and presentation-only aliases', () => {
		const all = fields.map((f) => f.field);
		expect(all).not.toContain('sample_id');
		expect(all).not.toContain('created_at');
		expect(all).not.toContain('report_button');
	});

	it('reads the English translation as the label, else humanises the column', () => {
		expect(byName(fields, 'diameter_mm').label).toBe('Diameter Ø');
		expect(byName(fields, 'mounted').label).toBe('Mounted'); // the trailing ? goes
		expect(byName(fields, 'short_id').label).toBe('Short id');
	});

	it('reads the note, width, required and the unit', () => {
		const d = byName(fields, 'diameter_mm');
		expect(d.note).toBe('Outer diameter, across the x and y axes.');
		expect(d.width).toBe('half');
		expect(d.suffix).toBe('mm');
		expect(d.step).toBe(0.001);
		expect(d.integer).toBe(false);
		expect(byName(fields, 'notes').width).toBe('full');
		expect(byName(fields, 'material_id').required).toBe(true);
		expect(byName(fields, 'form').required).toBe(true);
		expect(byName(fields, 'nickname').required).toBe(false);
		expect(byName(fields, 'grp_what').width).toBe('full');
	});

	it('draws each interface as its kind', () => {
		expect(byName(fields, 'nickname').kind).toBe('text');
		expect(byName(fields, 'notes').kind).toBe('textarea');
		expect(byName(fields, 'diameter_mm').kind).toBe('number');
		expect(byName(fields, 'form').kind).toBe('select');
		expect(byName(fields, 'current_status').kind).toBe('select');
		expect(byName(fields, 'mounted').kind).toBe('toggle');
		expect(byName(fields, 'manufactured_date').kind).toBe('date');
		expect(byName(fields, 'material_id').kind).toBe('record');
		expect(byName(fields, 'owner_person_id').kind).toBe('person');
	});

	it('a field it cannot draw is external and keeps its interface name', () => {
		expect(byName(fields, 'sample_code')).toMatchObject({ kind: 'external', interfaceName: 'd1-sample-code' });
		expect(byName(fields, 'co_owners').kind).toBe('external');
		expect(byName(fields, 'campaigns').kind).toBe('external');
	});

	it('reads choices, allow-other and the related collection with its template', () => {
		const form = byName(fields, 'form');
		expect(form.choices).toHaveLength(5);
		expect(form.choices[4]).toEqual({ text: 'Tensile coupon (ISO 6892)', value: 'tensile_coupon' });
		expect(form.allowOther).toBe(true);
		expect(byName(fields, 'current_status').allowOther).toBe(false);
		expect(byName(fields, 'material_id').related).toEqual({ collection: 'materials', template: '{{common_name}} ({{alloy_code}})' });
		expect(byName(fields, 'owner_person_id').related).toEqual({ collection: 'people', template: '{{full_name}}' });
		expect(byName(fields, 'diameter_mm').related).toBeNull();
	});

	it('groups know whether they start collapsed; hidden is the base state', () => {
		expect(byName(fields, 'grp_related').collapsed).toBe(true);
		expect(byName(fields, 'grp_what').collapsed).toBe(false);
		expect(byName(fields, 'item_type').hidden).toBe(true);
		expect(byName(fields, 'item_type').kind).toBe('select');
	});
});

describe('toFormFields: operations and tests', () => {
	const ops = toFormFields(OPERATION_DEFS);
	const tests = toFormFields(TEST_DEFS);

	it('the operation form: groups in order, method required, category external', () => {
		const tree = formTree(ops);
		expect(names(tree)).toEqual(['orphaned_field', 'grp_what', 'grp_tooling', 'grp_cutting', 'grp_sintering', 'grp_notes_files', 'grp_legacy']);
		expect(byName(ops, 'method_id')).toMatchObject({ kind: 'record', required: true, related: { collection: 'manufacturing_methods' } });
		expect(byName(ops, 'process_category')).toMatchObject({ kind: 'external', interfaceName: 'd1-process-category' });
		expect(byName(ops, 'operation_date')).toMatchObject({ kind: 'datetime', required: true });
		expect(byName(ops, 'machining_spindle_speed_rpm')).toMatchObject({ kind: 'number', suffix: 'rpm', label: 'Spindle Speed' });
		expect(byName(ops, 'sintering_run_number')).toMatchObject({ kind: 'number', integer: true });
		expect(byName(ops, 'pass_code').width).toBe('full');
	});

	it('keeps a hidden legacy code field (a condition can show it) and a JSON field as external', () => {
		expect(byName(ops, 'nc_program_text')).toMatchObject({ kind: 'external', hidden: true });
		expect(byName(ops, 'data_file_links').kind).toBe('external');
	});

	it('the test form: type select with choices, parameters per type', () => {
		expect(byName(tests, 'test_type')).toMatchObject({ kind: 'select', required: true });
		expect(choiceText(byName(tests, 'test_type'), 'sem')).toBe('SEM');
		expect(byName(tests, 'tensile_gauge_length_mm')).toMatchObject({ kind: 'number', suffix: 'mm', step: 0.01 });
		expect(byName(tests, 'tensile_extensometer_used').kind).toBe('toggle');
	});

	it('takes the related collection from `relations` when a definition carries no foreign key', () => {
		const def = { field: 'owner', type: 'uuid', meta: { special: ['m2o'], interface: 'select-dropdown-m2o' } };
		expect(toFormFields([def])[0].kind).toBe('external');
		expect(toFormFields([def], { relations: { owner: 'people' } })[0]).toMatchObject({ kind: 'person', related: { collection: 'people' } });
	});

	it('a foreign key is a record picker even without the m2o special; a file is external', () => {
		const fk = { field: 'tool_id', type: 'uuid', schema: { foreign_key_table: 'tools' }, meta: { interface: 'select-dropdown-m2o' } };
		expect(toFormFields([fk])[0].kind).toBe('record');
		const file = { field: 'image', type: 'uuid', schema: { foreign_key_table: 'directus_files' }, meta: { special: ['file'], interface: 'file-image' } };
		expect(toFormFields([file])[0].kind).toBe('external');
	});

	it('draws a bare definition by its column type, and applies an override', () => {
		const bare = [
			{ field: 'a', type: 'string' },
			{ field: 'b', type: 'integer' },
			{ field: 'c', type: 'boolean' },
			{ field: 'd', type: 'timestamp' },
			{ field: 'e', type: 'uuid', meta: { interface: 'something-custom' } },
			{ field: 'f', type: 'dateTime', meta: { interface: 'datetime' } },
			{ field: 'g', type: 'time', meta: { interface: 'datetime' } },
			{ field: 'h', type: 'string', meta: { interface: 'select-radio', options: { choices: [{ text: 'Yes', value: 'y' }] } } },
			{ field: 'i', type: 'string', meta: { interface: 'select-dropdown' } },
		];
		expect(toFormFields(bare).map((f) => f.kind)).toEqual(['text', 'number', 'toggle', 'datetime', 'external', 'datetime', 'time', 'radio', 'external']);
		const over = toFormFields(bare, { override: { e: { kind: 'text', label: 'Code', readonly: true } } });
		expect(over.find((f) => f.field === 'e')).toMatchObject({ kind: 'text', label: 'Code', readonly: true, field: 'e' });
	});

	it('ignores junk entries', () => {
		expect(toFormFields([null as any, { field: 7 as any }, { field: 'ok' }]).map((f) => f.field)).toEqual(['ok']);
	});
});

describe('formTree', () => {
	it('nests a group inside a group and children under their group, in order', () => {
		const tree = formTree(toFormFields(OPERATION_DEFS));
		const sintering = tree.find((n) => n.field.field === 'grp_sintering');
		expect(names(sintering?.children ?? [])).toEqual(['sintering_machine_group']);
		const machine = sintering?.children[0];
		expect(names(machine?.children ?? [])).toEqual(['sintering_run_number', 'sintering_max_temp_celsius']);
		const what = tree.find((n) => n.field.field === 'grp_what');
		expect(names(what?.children ?? [])).toEqual(['method_id', 'process_category', 'sample_id', 'operation_date', 'machining_operation_subtype', 'pass_code']);
	});

	it('a field whose group is not there goes to the top', () => {
		const tree = formTree(toFormFields(OPERATION_DEFS));
		expect(names(tree)[0]).toBe('orphaned_field');
	});

	it('a loop of groups does not lose or repeat anything', () => {
		const loop = toFormFields([
			{ field: 'a', type: 'alias', meta: { special: ['group'], interface: 'group-detail', group: 'b', sort: 1 } },
			{ field: 'b', type: 'alias', meta: { special: ['group'], interface: 'group-detail', group: 'a', sort: 2 } },
			{ field: 'x', type: 'string', meta: { group: 'a', sort: 3 } },
		]);
		const flat = (nodes: FormNode[]): string[] => nodes.flatMap((n) => [n.field.field, ...flat(n.children)]);
		expect(flat(formTree(loop)).sort()).toEqual(['a', 'b', 'x']);
	});

	it('a field cannot sit inside a plain field', () => {
		const tree = formTree(toFormFields([{ field: 'p', type: 'string' }, { field: 'q', type: 'string', meta: { group: 'p' } }]));
		expect(names(tree)).toEqual(['p', 'q']);
	});
});

describe('fieldViews', () => {
	const ops = toFormFields(OPERATION_DEFS);

	it('a machining operation shows tooling and cutting, hides sintering with everything in it', () => {
		const v = fieldViews(ops, { process_category: 'machining' });
		expect(v.get('grp_tooling')?.hidden).toBe(false);
		expect(v.get('tool_id')?.hidden).toBe(false);
		expect(v.get('machining_spindle_speed_rpm')?.hidden).toBe(false);
		expect(v.get('grp_sintering')?.hidden).toBe(true);
		expect(v.get('sintering_run_number')?.hidden).toBe(true);
		expect(v.get('sintering_run_number')?.hiddenByGroup).toBe(true);
		expect(v.get('sintering_max_temp_celsius')?.hidden).toBe(true);
	});

	it('a blank form hides every conditional group and shows the unconditional ones', () => {
		const v = fieldViews(ops, {});
		expect(v.get('grp_what')?.hidden).toBe(false);
		expect(v.get('grp_tooling')?.hidden).toBe(true);
		expect(v.get('tool_id')?.hidden).toBe(true);
		expect(v.get('machining_operation_subtype')?.hidden).toBe(true);
	});

	it('the input sample becomes required for machining', () => {
		expect(fieldViews(ops, { process_category: 'machining' }).get('sample_id')?.required).toBe(true);
		expect(fieldViews(ops, { process_category: 'sintering' }).get('sample_id')?.required).toBe(false);
	});

	it('the legacy code field shows once it has a value', () => {
		expect(fieldViews(ops, {}).get('nc_program_text')?.hidden).toBe(true);
		expect(fieldViews(ops, { nc_program_text: 'G01 X0' }).get('nc_program_text')?.hidden).toBe(false);
	});

	it('a sample hides the geometry for a rig kit, and a dimension for the wrong geometry', () => {
		const s = toFormFields(SAMPLE_DEFS);
		expect(fieldViews(s, { item_type: 'equipment' }).get('grp_geometry')?.hidden).toBe(true);
		expect(fieldViews(s, { item_type: 'equipment' }).get('diameter_mm')?.hidden).toBe(true);
		expect(fieldViews(s, { item_type: 'sample', form: 'disc' }).get('diameter_mm')?.hidden).toBe(false);
		expect(fieldViews(s, { item_type: 'sample', form: 'block' }).get('diameter_mm')?.hidden).toBe(true);
	});

	it('Related records stay hidden until the sample has been saved', () => {
		const s = toFormFields(SAMPLE_DEFS);
		expect(fieldViews(s, { short_id: '' }).get('campaigns')?.hidden).toBe(true);
		expect(fieldViews(s, { short_id: 'ab12cd' }).get('campaigns')?.hidden).toBe(false);
	});
});

describe('missingRequired', () => {
	const samples = toFormFields(SAMPLE_DEFS);
	const ops = toFormFields(OPERATION_DEFS);

	it('lists the shown required fields with no value, in form order', () => {
		expect(missingRequired(samples, { item_type: 'sample' }).map((f) => f.field)).toEqual(['form', 'material_id']);
		expect(missingRequired(samples, { item_type: 'sample', form: 'disc', material_id: 'm1' })).toEqual([]);
	});

	it('does not ask for a field a hidden group hides (a rig kit has no geometry or material)', () => {
		expect(missingRequired(samples, { item_type: 'equipment' })).toEqual([]);
	});

	it('counts a condition that makes a field required, only while it is shown', () => {
		expect(missingRequired(ops, { process_category: 'machining', method_id: 'x', operation_date: '2026-10-14' }).map((f) => f.field)).toEqual(['sample_id']);
		expect(missingRequired(ops, { process_category: 'sintering', method_id: 'x', operation_date: '2026-10-14' })).toEqual([]);
	});

	it('0 and false are values', () => {
		const fields = toFormFields([{ field: 'n', type: 'integer', meta: { required: true } }, { field: 'b', type: 'boolean', meta: { required: true } }]);
		expect(missingRequired(fields, { n: 0, b: false })).toEqual([]);
		expect(missingRequired(fields, { n: '', b: null }).map((f) => f.field)).toEqual(['n', 'b']);
	});
});

describe('values as text', () => {
	const fields = toFormFields(SAMPLE_DEFS);
	it('isEmptyValue', () => {
		expect([null, undefined, '', '  ', []].every(isEmptyValue)).toBe(true);
		expect([0, false, 'x', [1]].some(isEmptyValue)).toBe(false);
	});
	it('choiceText falls back to the value', () => {
		expect(choiceText(byName(fields, 'form'), 'tensile_coupon')).toBe('Tensile coupon (ISO 6892)');
		expect(choiceText(byName(fields, 'form'), 'custom')).toBe('custom');
	});
	it('displayText', () => {
		expect(displayText(byName(fields, 'mounted'), true)).toBe('Yes');
		expect(displayText(byName(fields, 'form'), 'ring')).toBe('Ring');
		expect(displayText(byName(fields, 'co_owners'), [])).toBe('');
		expect(displayText(byName(fields, 'co_owners'), [1, 2, 3])).toBe('3 items');
		expect(displayText(byName(fields, 'sample_code'), { a: 1 })).toBe('{"a":1}');
		expect(displayText(byName(fields, 'diameter_mm'), '12.5')).toBe('12.5');
	});
});
