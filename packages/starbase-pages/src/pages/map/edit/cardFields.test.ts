import { describe, expect, it } from 'vitest';
import type { Check, DraftBody, DraftItem } from '@d1/ui';
import { KEY_SETTING_FIELDS, MAX_SETTINGS } from '../model/formSlots';
import type { MapNode } from '../model/types';
import { cardFieldNames, cardFieldsFor, cardItemOf, cardSegments, flaggedFields, isMadeByCheck, readonlyOnCard } from './cardFields';
import { checks } from './checks';
import { apply, emptyBody, type DraftAction } from './draft';
import { keySettingsFor } from './draftForm';

const run = (actions: DraftAction[], from: DraftBody = emptyBody()) => actions.reduce((b, a) => apply(b, a), from);
const op = (values: Record<string, unknown> = {}, over: Partial<DraftItem> = {}): DraftItem => ({ key: 'n1', kind: 'operation', workState: 'planned', values, rows: [{ key: 'n2' }], ...over }) as DraftItem;
const test = (values: Record<string, unknown> = {}): DraftItem => ({ key: 'n1', kind: 'test', workState: 'planned', values }) as DraftItem;
const body = emptyBody();
const settingsOf = (category: string) => keySettingsFor('operation', category);

describe('cardFieldsFor: what a new card asks for', () => {
	it('a planned Turning operation: the machine, the planned date, then its key settings, never the kind', () => {
		const fields = cardFieldsFor(op({ method_id: 'm-turn', process_category: 'machining' }), body, {});
		expect(fields.slice(0, 2)).toEqual(['equipment_id', 'planned_date']);
		expect(fields.slice(2)).toEqual(settingsOf('machining').slice(0, MAX_SETTINGS));
		expect(fields.length - 2).toBeGreaterThan(0);
		expect(fields).not.toContain('method_id');
		expect(fields).not.toContain('test_type');
	});

	it('never more than four key settings, and none twice, for every process category', () => {
		for (const category of Object.keys(KEY_SETTING_FIELDS).filter((c) => c !== 'test')) {
			const fields = cardFieldsFor(op({ process_category: category }), body, {});
			const own = new Set(settingsOf(category));
			expect(fields.filter((f) => own.has(f)).length).toBeLessThanOrEqual(MAX_SETTINGS);
			expect(new Set(fields).size).toBe(fields.length);
		}
	});

	it('a FAST (sintering) operation shows its own key settings and no more than four', () => {
		const fields = cardFieldsFor(op({ process_category: 'sintering' }), body, {});
		expect(fields.slice(2)).toEqual(['sintering_max_temp_celsius', 'sintering_max_force_kn', 'sintering_mould_diameter_mm']);
	});

	it('a settings field the forms also require is asked once', () => {
		const done = op({ process_category: 'machining' }, { workState: 'done' });
		const fields = cardFieldsFor(done, body, { requiredForDone: ['operation_date', 'machining_feed_mm_per_rev', 'outcome_notes'] });
		expect(fields.slice(0, 4)).toEqual(['equipment_id', 'operation_date', 'machining_feed_mm_per_rev', 'outcome_notes']);
		expect(fields.filter((f) => f === 'machining_feed_mm_per_rev')).toHaveLength(1);
		expect(fields).not.toContain('planned_date');
	});

	it('what the forms require of a done card is never capped away, even a key setting past the fourth', () => {
		const done = op({ process_category: 'machining' }, { workState: 'done' });
		const required = ['operation_date', ...settingsOf('machining')];
		const fields = cardFieldsFor(done, body, { requiredForDone: required });
		for (const f of required) expect(fields).toContain(f);
	});

	it('a test draws the machine, the date and its type\'s own fields, without the type', () => {
		expect(cardFieldsFor(test(), body, {})).toEqual(['equipment_id', 'planned_date']);
		expect(cardFieldsFor(test({ test_type: 'tensile' }), body, {})).toEqual(['tensile_uts_mpa', 'equipment_id', 'planned_date']);
	});

	it('a new sample: its name (the nickname the card shows), material, geometry and the method of its code', () => {
		expect(cardFieldsFor({ key: 'n1', kind: 'sample', values: {} } as DraftItem, body, {})).toEqual(['nickname', 'material_id', 'form', 'primary_method_id']);
	});
});

describe('readonlyOnCard', () => {
	const made = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } }, { type: 'addSample', from: { key: 'n2', row: 0 } }]);
	it('"Made by" is read-only on a sample a draft operation makes', () => {
		const out = made.items.find((i) => i.key === 'n4')!;
		expect(readonlyOnCard(out, made)).toEqual(['primary_method_id']);
	});
	it('and typed on a sample nothing makes', () => {
		const first = made.items.find((i) => i.key === 'n1')!;
		expect(readonlyOnCard(first, made)).toEqual([]);
		expect(readonlyOnCard(op(), made)).toEqual([]);
	});
});

describe('flaggedFields', () => {
	const list: Check[] = [
		{ key: 'n1', level: 'warn', field: 'equipment_id', text: 'No machine yet.' },
		{ key: 'n1', level: 'block', field: 'planned_date', text: 'x', code: 'REQUIRED' },
		{ key: 'n1', level: 'block', field: 'equipment_id', text: 'Permission', code: 'PERMISSION' },
		{ key: 'n1', level: 'block', text: 'Needs a sample.' },
		{ key: 'n9', level: 'warn', field: 'form', text: 'other card' },
	];
	it('keeps the fields of the card\'s checks, without what only the server can tell, once each', () => {
		expect(flaggedFields(list, 'n1')).toEqual(['equipment_id', 'planned_date']);
		expect(flaggedFields(list.filter((c) => c.code !== 'REQUIRED'), 'n1')).toEqual(['equipment_id']);
	});
	it('drops a PERMISSION check and keeps a machine that is missing (a warning)', () => {
		const only: Check[] = [list[2], list[0]];
		expect(flaggedFields([list[2]], 'n1')).toEqual([]);
		expect(flaggedFields(only, 'n1')).toEqual(['equipment_id']);
	});
	it('reads the real checks of a new sample and an operation with no machine', () => {
		const b = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } }]);
		const all = checks(b, {});
		expect(flaggedFields(all, 'n1').sort()).toEqual(['material_id', 'primary_method_id']);
		expect(flaggedFields(all, 'n2')).toContain('equipment_id');
	});
});

describe('cardSegments: relations are slot rows, the rest runs together', () => {
	it('cuts the fields at each relation, in order', () => {
		expect(cardSegments(['equipment_id', 'planned_date', 'machining_feed_mm_per_rev', 'tool_id', 'insert_edge_id', 'machining_coolant_used'])).toEqual([
			{ slot: 'equipment', fields: ['equipment_id'] },
			{ fields: ['planned_date', 'machining_feed_mm_per_rev'] },
			{ slot: 'tool', fields: ['tool_id'] },
			{ slot: 'insert_edge', fields: ['insert_edge_id'] },
			{ fields: ['machining_coolant_used'] },
		]);
		expect(cardSegments(['fast_recipe_id', 'source_recipe_id']).map((s) => s.slot)).toEqual(['recipe', 'recipe']);
		expect(cardSegments(['nickname', 'material_id', 'form', 'primary_method_id'])).toEqual([{ fields: ['nickname', 'material_id', 'form', 'primary_method_id'] }]);
		expect(cardSegments([])).toEqual([]);
	});
});

describe('cardItemOf: which card types its fields', () => {
	const node = (over: Record<string, unknown>) => over as unknown as MapNode;
	const container = (rowId: string) => node({ id: `c:${rowId}`, type: 'container', kind: 'operation', group: { id: `c:${rowId}`, kind: 'operation', rowIds: [rowId], batch: null } });
	const sampleNode = (id: string) => node({ id: `s:${id}`, type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id, code: 'x' }, ins: [], outs: [] });

	it('a new sample always; a new operation or test once its kind is chosen', () => {
		const b = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' } }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' } }, { type: 'addContainer', kind: 'test', source: { from: 'blank' } }, { type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'tensile' } }]);
		expect(cardItemOf(b, sampleNode('draft:n1'))?.key).toBe('n1');
		expect(cardItemOf(b, container('draft:n3'))).toBeNull(); // no method yet: the header and the dropdown only
		expect(cardItemOf(b, container('draft:n5'))?.key).toBe('n4');
		expect(cardItemOf(b, container('draft:n6'))).toBeNull();
		expect(cardItemOf(b, container('draft:n7'))?.key).toBe('n7');
	});

	it('nothing for a record that exists, a card of something else, or a card not in the draft', () => {
		const b = run([{ type: 'addExistingSamples', samples: [{ id: 's1', version: 1 }] }]);
		expect(cardItemOf(b, sampleNode('s1'))).toBeNull();
		expect(cardItemOf(b, container('recorded'))).toBeNull();
		expect(cardItemOf(b, node({ id: 'm:1', type: 'record', kind: 'material', ref: { collection: 'materials', id: '1', code: 'Ti' }, ins: [], outs: [] }))).toBeNull();
	});
});

describe('"Made by" on a sample a draft operation makes is not the card to fill (§5a)', () => {
	// n1 a sample, n2 an operation with no kind chosen (row n3), n4 the sample it makes
	const made = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } }, { type: 'addSample', from: { key: 'n2', row: 0 } }]);
	const all = checks(made, {});

	it('the real checks do refuse the sample without a method (Create is unchanged)', () => {
		expect(all.some((c) => c.key === 'n4' && c.field === 'primary_method_id')).toBe(true);
		expect(all.some((c) => c.key === 'n2' && c.field === 'method_id')).toBe(true);
	});

	it('is not flagged on the sample the operation makes, and still is on the one nothing makes', () => {
		expect(flaggedFields(all, 'n4', made)).not.toContain('primary_method_id');
		expect(flaggedFields(all, 'n4', made)).toContain('material_id');
		expect(flaggedFields(all, 'n1', made)).toContain('primary_method_id');
		expect(isMadeByCheck(all.find((c) => c.key === 'n4' && c.field === 'primary_method_id')!, made)).toBe(true);
		expect(isMadeByCheck(all.find((c) => c.key === 'n1' && c.field === 'primary_method_id')!, made)).toBe(false);
	});
});

describe('cardFieldNames', () => {
	it('is empty until the field definitions of the form are read, then the fields of the card', () => {
		const item = op({ process_category: 'machining' });
		expect(cardFieldNames(item, body, { form: [] })).toEqual([]);
		expect(cardFieldNames(item, body, { form: [{ field: 'x' }] })).toEqual(cardFieldsFor(item, body, {}));
	});
});
