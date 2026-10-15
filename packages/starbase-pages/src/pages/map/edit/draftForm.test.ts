import { describe, expect, it } from 'vitest';
import type { DraftOperation, DraftSample, DraftTest } from '@d1/ui';
import { KEY_SETTING_FIELDS } from '../model/formSlots';
import { apply, emptyBody, itemOf } from './draft';
import { collectionFor, existingModel, existingPatch, formDefsFor, inheritedFor, keySettingsFor, patchOf, TEXT_OVERRIDES } from './draftForm';

const defs = (...names: string[]) => names.map((field) => ({ field, meta: {} }));
const sample = (over: Partial<DraftSample> = {}): DraftSample => ({ key: 'n1', kind: 'sample', values: {}, ...over });
const op = (over: Partial<DraftOperation> = {}): DraftOperation => ({ key: 'n2', kind: 'operation', workState: 'planned', values: {}, rows: [{ key: 'n3' }], ...over });
const test = (over: Partial<DraftTest> = {}): DraftTest => ({ key: 'n4', kind: 'test', workState: 'planned', values: {}, ...over });
const names = (list: { field: string }[]) => list.map((d) => d.field);

describe('collectionFor', () => {
	it('maps each kind of draft item to its collection', () => {
		expect(collectionFor(sample())).toBe('physical_samples');
		expect(collectionFor(op())).toBe('manufacturing_operations');
		expect(collectionFor(test())).toBe('test_sessions');
	});
});

describe('formDefsFor', () => {
	const common = ['sample_id', 'output_sample_id', 'operation_id', 'session_id', 'work_state', 'done_by_person_id', 'done_at', 'batch_id', 'operation_sequence'];
	const codes = ['sample_code', 'pass_code', 'test_code'];
	const all = defs(...common, ...codes, 'current_status', 'subject', 'version', 'planned_date', 'operation_date', 'session_date', 'method_id', 'notes');
	const rest = ['planned_date', 'method_id', 'notes'];

	it('leaves out what the server refuses in a draft and what the draft sets itself, and on a new record the codes', () => {
		const shown = names(formDefsFor(all, op()));
		for (const f of [...common, 'pass_code', 'sample_code', 'test_code', 'version']) expect(shown, f).not.toContain(f);
		expect(shown).toEqual(['current_status', 'subject', 'planned_date', 'method_id', 'notes']); // (status and subject are not an operation's reserved fields)
	});

	it('a sample never offers its status, new or existing (d1-build refuses it)', () => {
		expect(names(formDefsFor(all, sample()))).not.toContain('current_status');
		expect(names(formDefsFor(all, sample({ existing: { id: 'x', version: 1 } })))).not.toContain('current_status');
		expect(names(formDefsFor(all, sample()))).not.toContain('sample_id');
	});

	it('a test never offers its subject (the wires set it)', () => {
		expect(names(formDefsFor(all, test()))).not.toContain('subject');
		expect(names(formDefsFor(all, test({ workState: 'done' })))).not.toContain('subject');
	});

	it('hides the date it was done while the record is planned, shows it once done', () => {
		expect(names(formDefsFor(all, op()))).not.toContain('operation_date');
		expect(names(formDefsFor(all, test()))).not.toContain('session_date');
		expect(names(formDefsFor(all, op({ workState: 'done' })))).toContain('operation_date');
		expect(names(formDefsFor(all, test({ workState: 'done' })))).toContain('session_date');
	});

	it('an existing record keeps its codes (shown read-only)', () => {
		const existing = { id: 'x', version: 1 };
		expect(names(formDefsFor(all, op({ existing })))).toEqual(expect.arrayContaining(codes));
		expect(names(formDefsFor(all, op()))).not.toContain('pass_code');
	});

	it('compact keeps only the key fields, in the form order', () => {
		const list = defs('a', 'b', 'c', 'sample_id');
		expect(names(formDefsFor(list, op(), { compact: true, keyFields: ['c', 'a', 'sample_id'] }))).toEqual(['a', 'c']);
		expect(formDefsFor(list, op(), { compact: true })).toEqual([]);
		expect(names(formDefsFor(list, op(), { keyFields: ['a'] }))).toEqual(['a', 'b', 'c']); // keyFields alone does nothing
	});

	it('skips rows with no field name', () => {
		expect(formDefsFor([null, {}, { field: 'notes' }], op())).toEqual([{ field: 'notes' }]);
	});
});

describe('TEXT_OVERRIDES', () => {
	it('shows the process category and the codes as read-only text', () => {
		for (const f of ['process_category', 'sample_code', 'pass_code', 'test_code']) {
			expect(TEXT_OVERRIDES[f]).toMatchObject({ kind: 'text', readonly: true, required: false });
		}
	});
});

describe('keySettingsFor', () => {
	it('an operation: the fields of the key settings table the map draws, for its process category', () => {
		expect(keySettingsFor('operation', 'machining')).toEqual([
			'machining_cutting_speed_m_per_min', 'machining_feed_mm_per_rev', 'machining_axial_depth_of_cut_mm', 'machining_coolant_used',
		]);
		expect(keySettingsFor('operation', 'sintering')).toEqual(['sintering_max_temp_celsius', 'sintering_max_force_kn', 'sintering_mould_diameter_mm']);
	});

	it('every category of the table gives exactly its fields', () => {
		for (const [category, list] of Object.entries(KEY_SETTING_FIELDS)) {
			if (category === 'test') continue;
			expect(keySettingsFor('operation', category)).toEqual(list.flatMap((d) => d.fields.map((f) => f.field)));
		}
	});

	it('sample prep, an unknown category and no category have none', () => {
		expect(keySettingsFor('operation', 'sample_prep')).toEqual([]);
		expect(keySettingsFor('operation', 'nope')).toEqual([]);
		expect(keySettingsFor('operation', null)).toEqual([]);
		expect(keySettingsFor('operation', 'test')).toEqual([]);
	});

	it('a test gives its type, standard and headline result', () => {
		expect(keySettingsFor('test', 'tensile')).toEqual(['test_type', 'tensile_uts_mpa']);
		expect(keySettingsFor('test', 'charpy')).toEqual(['test_type', 'charpy_specimen_standard', 'charpy_absorbed_energy_j']);
		expect(keySettingsFor('test', 'sem')).toEqual(['test_type']);
	});

	it('a test always offers test_type, even while it is unset, so the type can be chosen', () => {
		expect(keySettingsFor('test', null)).toEqual(['test_type']);
		expect(keySettingsFor('test', undefined)).toEqual(['test_type']);
		expect(keySettingsFor('test', '')).toEqual(['test_type']);
	});

	it('the headline fields of a test type are among the fields the map reads for a test', () => {
		const fromTable = new Set(KEY_SETTING_FIELDS.test.flatMap((d) => d.fields.map((f) => f.field)));
		for (const type of ['tensile', 'compression', 'hardness', 'charpy', 'tribology']) {
			for (const f of keySettingsFor('test', type)) expect(fromTable.has(f)).toBe(true);
		}
	});
});

describe('patchOf: clearing a field reaches the draft', () => {
	const bodyWith = (item: DraftSample | DraftOperation) => ({ ...emptyBody(), items: [item] });
	const through = (item: DraftSample | DraftOperation, next: Record<string, unknown>) =>
		itemOf(apply(bodyWith(item), { type: 'setValues', key: item.key, values: patchOf(item, next) }), item.key)!;

	it('a changed field is part of the patch, with the rest of what the form holds', () => {
		const item = sample({ values: { nickname: 'a', form: 'disc' } });
		expect(patchOf(item, { nickname: 'b', form: 'disc' })).toEqual({ nickname: 'b', form: 'disc' });
		expect(through(item, { nickname: 'b', form: 'disc' }).values).toEqual({ nickname: 'b', form: 'disc' });
	});

	it('a cleared field of a new item (FieldForm drops its key) is removed from the draft', () => {
		const item = sample({ values: { nickname: 'a', form: 'disc' } });
		const patch = patchOf(item, { form: 'disc' });
		expect(patch).toEqual({ form: 'disc', nickname: undefined });
		expect(through(item, { form: 'disc' }).values).toEqual({ form: 'disc' });
	});

	it('a cleared field of an existing item becomes null, so Create writes it as empty', () => {
		const item = op({ existing: { id: 'o1', version: 2 }, values: { machining_feed_mm_per_rev: 0.2, notes: 'x' } });
		expect(patchOf(item, { notes: 'x' })).toEqual({ notes: 'x', machining_feed_mm_per_rev: null });
		const after = through(item, { notes: 'x' });
		expect(after.values).toEqual({ machining_feed_mm_per_rev: null, notes: 'x' });
		expect(after.existing).toEqual({ id: 'o1', version: 2 });
	});

	it('clearing the last field and then typing again works', () => {
		const item = sample({ values: { nickname: 'a' } });
		const cleared = through(item, {});
		expect(cleared.values).toEqual({});
		expect(through(cleared as DraftSample, { nickname: 'c' }).values).toEqual({ nickname: 'c' });
	});

	it('an existing item whose field is already null stays null when the form drops it again', () => {
		const item = op({ existing: { id: 'o1', version: 2 }, values: { notes: null } });
		expect(patchOf(item, {})).toEqual({ notes: null });
	});

	it('changes nothing in the draft when the form holds what the item has', () => {
		const item = sample({ values: { nickname: 'a' } });
		const body = bodyWith(item);
		expect(apply(body, { type: 'setValues', key: item.key, values: patchOf(item, { nickname: 'a' }) })).toBe(body);
	});
});

describe('inheritedFor', () => {
	it('shows what an existing record has, except a field the person cleared (null in the changes)', () => {
		const item = op({ existing: { id: 'o1', version: 1 }, values: { notes: null, machining_feed_mm_per_rev: 0.3 } });
		expect(inheritedFor(item, { notes: 'old', machining_feed_mm_per_rev: 0.2, method_id: 'm1' })).toEqual({ machining_feed_mm_per_rev: 0.2, method_id: 'm1' });
	});
	it('leaves a new item\'s inheritance as it is, and nothing as nothing', () => {
		const inherited = { form: 'disc' };
		expect(inheritedFor(sample({ values: {} }), inherited)).toBe(inherited);
		expect(inheritedFor(sample({ values: {} }), undefined)).toBeUndefined();
	});
});

describe('existingModel / existingPatch: editing an existing record over its loaded values', () => {
	const bodyWith = (it: DraftOperation) => ({ ...emptyBody(), items: [it] });
	const item = { key: 'n1', kind: 'operation', workState: 'planned', rows: [{ key: 'n1' }], existing: { id: 'op1', version: 3 }, values: {} } as any;
	const current = { notes: 'old', machining_feed_mm_per_rev: 0.2, method_id: 'm1' };
	it('shows the record with the changes over it', () => {
		expect(existingModel({ ...item, values: { notes: null, machining_feed_mm_per_rev: 0.3 } }, current)).toEqual({ machining_feed_mm_per_rev: 0.3, method_id: 'm1' });
	});
	it('a changed field goes in, an unchanged one does not', () => {
		expect(existingPatch(item, current, { ...current, machining_feed_mm_per_rev: 0.3 })).toEqual({ machining_feed_mm_per_rev: 0.3 });
	});
	it('clearing a field the record has writes null, and it reaches the draft', () => {
		const patch = existingPatch(item, current, { machining_feed_mm_per_rev: 0.2, method_id: 'm1' });
		expect(patch).toEqual({ notes: null });
		const after = itemOf(apply(bodyWith(item), { type: 'setValues', key: item.key, values: patch }), item.key)!;
		expect(after.values).toEqual({ notes: null });
	});
	it('changing a field back to the record value drops the change', () => {
		const edited = { ...item, values: { notes: 'new' } };
		const patch = existingPatch(edited, current, { ...current });
		expect(patch).toEqual({ notes: undefined });
		const after = itemOf(apply(bodyWith(edited), { type: 'setValues', key: edited.key, values: patch }), edited.key)!;
		expect(after.values).toEqual({});
	});
});
