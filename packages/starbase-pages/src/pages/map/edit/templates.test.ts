import { describe, expect, it } from 'vitest';
import type { DraftItem, DraftOperation, DraftTest, TemplateRecord } from '@d1/ui';
import type { MethodEntry, TestTypeEntry } from './catalog';
import { OPERATION_DEFS, TEST_DEFS } from './templateFields.fixtures';
import { MISSING_METHOD, MISSING_TYPE, SCOPES, canChange, scopeLabel, templateCollectionOf, templateEntries, templateEntry, templateProblem, templateValuesOf, templatesOf, warnOf, type TemplateItem } from './templates';

const methods: MethodEntry[] = [
	{ id: 'mt', name: 'CNC Turning', code: 'MC', category: 'machining' },
	{ id: 'mf', name: 'FAST sintering', code: 'MF', category: 'sintering' },
];
const testTypes: TestTypeEntry[] = [{ value: 'tensile', name: 'Tensile' }];
const cat = { methods, testTypes };

const op = (values: Record<string, unknown>, extra: Partial<DraftOperation> = {}): DraftOperation => ({ key: 'n1', kind: 'operation', workState: 'planned', rows: [{ key: 'n2' }], values, ...extra }) as DraftOperation;
const test = (values: Record<string, unknown>): DraftTest => ({ key: 'n1', kind: 'test', workState: 'planned', values }) as DraftTest;

const rec = (over: Partial<TemplateRecord> = {}): TemplateRecord => ({
	id: 't1', name: 'Roughing pass', scope: 'private', role_id: null, collection: 'manufacturing_operations',
	values: { method_id: 'mt', equipment_id: 'e1', process_category: 'machining' }, user_id: 'u1', updated_at: 'now', version: 1, ...over,
});
const item = (r: TemplateRecord = rec(), over: Partial<TemplateItem> = {}): TemplateItem => ({ rec: r, mine: true, ...over });

const defs = OPERATION_DEFS;
const tdefs = TEST_DEFS;

describe('what a template saves', () => {
	it('keeps the method, machine, tool, edge, operator and settings', () => {
		const v = templateValuesOf(
			op({ method_id: 'mt', process_category: 'machining', equipment_id: 'e1', tool_id: 't1', insert_edge_id: 'edge1', operator_person_id: 'p1', machining_cutting_speed_m_per_min: 120 }),
			undefined,
			defs,
		);
		expect(v).toEqual({ method_id: 'mt', process_category: 'machining', equipment_id: 'e1', tool_id: 't1', insert_edge_id: 'edge1', operator_person_id: 'p1', machining_cutting_speed_m_per_min: 120 });
	});

	it('never keeps the dates, the sample, the owner, the project, the work state or blanks', () => {
		const v = templateValuesOf(
			op({ method_id: 'mt', planned_date: '2026-11-01', operation_date: '2026-10-01', sample_id: 's1', owner_person_id: 'p9', project_id: 'proj1', equipment_id: '', tool_id: null, outcome_notes: 'run 7', notes: 'x' }),
			undefined,
			defs,
		);
		expect(v).toEqual({ method_id: 'mt' });
	});

	it('leaves the notes out unless they are ticked, then keeps them', () => {
		const it = op({ method_id: 'mt', outcome_notes: 'hold for 2 min' });
		expect(templateValuesOf(it, undefined, defs)).toEqual({ method_id: 'mt' });
		expect(templateValuesOf(it, undefined, defs, { notes: true })).toEqual({ method_id: 'mt', outcome_notes: 'hold for 2 min' });
		expect(templateValuesOf(op({ method_id: 'mt' }), undefined, defs, { notes: true })).toEqual({ method_id: 'mt' });
		// A test keeps its own `notes`.
		const t = test({ test_type: 'tensile', notes: 'jaws 4' });
		expect(templateValuesOf(t, undefined, tdefs)).toEqual({ test_type: 'tensile' });
		expect(templateValuesOf(t, undefined, tdefs, { notes: true })).toEqual({ test_type: 'tensile', notes: 'jaws 4' });
	});

	it('reads a record that exists as it stands: the loaded fields, then the changes (a null change clears)', () => {
		const loaded = { operation_id: 'o1', method_id: 'mt', equipment_id: 'e1', tool_id: 't1', operation_date: '2026-10-01', work_state: 'done', version: 3, sample_id: 's1' };
		const it = op({ equipment_id: 'e2', tool_id: null }, { existing: { id: 'o1', version: 3 } });
		expect(templateValuesOf(it, loaded, defs)).toEqual({ method_id: 'mt', equipment_id: 'e2' });
	});

	it('keeps only real columns when the definitions are known (an alias is not one)', () => {
		const v = templateValuesOf(op({ method_id: 'mt', co_workers: ['p1'], machining_unknown: 1 }), undefined, defs);
		expect(v).toEqual({ method_id: 'mt' });
	});

	it('keeps a test\'s type and settings but not the edge the server refuses on a test', () => {
		const v = templateValuesOf(test({ test_type: 'tensile', equipment_id: 'e1', insert_edge_id: 'edge1' }), undefined, tdefs);
		expect(v).toEqual({ test_type: 'tensile', equipment_id: 'e1' });
	});
});

describe('what cannot be saved', () => {
	it('wants a method for an operation and a type for a test, and refuses a sample', () => {
		expect(templateProblem(op({}), {})).toMatch(/method/);
		expect(templateProblem(op({ method_id: 'mt' }), { method_id: 'mt' })).toBeNull();
		expect(templateProblem(test({}), {})).toMatch(/type/);
		expect(templateProblem(test({ test_type: 'tensile' }), { test_type: 'tensile' })).toBeNull();
		expect(templateProblem({ key: 'n1', kind: 'sample', values: {} } as DraftItem, {})).toMatch(/operation or a test/);
		expect(templateProblem(null, {})).toMatch(/operation or a test/);
	});

	it('knows the collection a draft item\'s template is for', () => {
		expect(templateCollectionOf(op({}))).toBe('manufacturing_operations');
		expect(templateCollectionOf(test({}))).toBe('test_sessions');
		expect(templateCollectionOf({ key: 'n1', kind: 'sample', values: {} } as DraftItem)).toBeNull();
	});
});

describe('reading the list', () => {
	it('keeps well-formed templates and drops the rest', () => {
		const good = rec();
		const out = templatesOf([good, null, { id: 'x' }, { ...good, id: 't2', scope: 'weird' }, { ...good, id: 't3', collection: 'physical_samples' }, { ...good, id: 't4', values: null }, { ...good, id: 't5', role_id: 7, version: 'x' }]);
		expect(out.map((t) => t.id)).toEqual(['t1', 't5']);
		expect(out[1]).toMatchObject({ role_id: null, version: 1 });
		expect(templatesOf(undefined)).toEqual([]);
	});
});

describe('who may change one', () => {
	it('is the person who made it, or an administrator', () => {
		expect(canChange({ user_id: 'u1' }, { id: 'u1' })).toBe(true);
		expect(canChange({ user_id: 'u1' }, { id: 'u2' })).toBe(false);
		expect(canChange({ user_id: 'u1' }, { id: 'u2', admin: true })).toBe(true);
		expect(canChange({ user_id: 'u1' }, {})).toBe(false);
	});
});

describe('the scopes', () => {
	it('are the three saved-view scopes, in the lab\'s words', () => {
		expect(SCOPES.map((s) => s.value)).toEqual(['private', 'role', 'global']);
		expect(scopeLabel('role')).toBe('My account role');
		expect(scopeLabel('global')).toBe('Everyone');
	});
});

describe('the entries', () => {
	it('lists an operation template under Templates, found by its name and its method, chosen like the method it is made of', () => {
		const e = templateEntry(item(), cat);
		expect(e).toMatchObject({ id: 'tpl:t1', section: 'Templates', label: 'Roughing pass', detail: 'CNC Turning', template: { id: 't1', mine: true, scope: 'private', collection: 'manufacturing_operations' } });
		expect(e.keys).toContain('CNC Turning');
		expect(e.keys).toContain('MC');
		expect(e.choice).toEqual({ kind: 'operation', methodId: 'mt', category: 'machining', template: { id: 't1', values: { method_id: 'mt', equipment_id: 'e1', process_category: 'machining' } } });
	});

	it('adds the process category of the method when the template has none (the typed panels hang on it)', () => {
		const e = templateEntry(item(rec({ values: { method_id: 'mf' } })), cat);
		expect(e.choice).toMatchObject({ kind: 'operation', category: 'sintering', template: { values: { method_id: 'mf', process_category: 'sintering' } } });
	});

	it('lists a test template, says who it is shared with and carries a warning', () => {
		const e = templateEntry(item(rec({ id: 't2', name: 'Pull', collection: 'test_sessions', scope: 'global', values: { test_type: 'tensile' } }), { mine: false, warn: 'The machine Instron is retired.' }), cat);
		expect(e).toMatchObject({ label: 'Pull', detail: 'Tensile · Everyone', warn: 'The machine Instron is retired.', template: { mine: false } });
		expect(e.choice).toEqual({ kind: 'test', testType: 'tensile', template: { id: 't2', values: { test_type: 'tensile' } } });
		expect(e.disabled).toBeUndefined();
	});

	it('a method that is no longer in the list makes the entry unusable with the reason (Create would fail on the reference), once the list is known', () => {
		const e = templateEntry(item(rec({ values: { method_id: 'gone' } })), cat);
		expect(e.detail).toBe('Operation');
		expect(e.disabled).toBe(MISSING_METHOD);
		expect(e.choice).toMatchObject({ kind: 'operation', methodId: 'gone', category: null });
		// While the methods are still being read nothing is known: not marked.
		expect(templateEntry(item(rec({ values: { method_id: 'gone' } })), { methods: [], testTypes: [] }).disabled).toBeUndefined();
		expect(templateEntry(item(), cat).disabled).toBeUndefined();
	});

	it('a test type that is no longer in the list is unusable too', () => {
		const t = rec({ id: 't9', collection: 'test_sessions', values: { test_type: 'retired_type' } });
		expect(templateEntry(item(t), cat).disabled).toBe(MISSING_TYPE);
		expect(templateEntry(item(t), { methods, testTypes: [] }).disabled).toBeUndefined();
		expect(templateEntry(item(rec({ id: 't8', collection: 'test_sessions', values: { test_type: 'tensile' } })), cat).disabled).toBeUndefined();
	});

	it('sorts by name and narrows to operations or tests', () => {
		const items = [item(rec({ id: 'a', name: 'Zed' })), item(rec({ id: 'b', name: 'Alpha', collection: 'test_sessions', values: { test_type: 'tensile' } })), item(rec({ id: 'c', name: 'Mid' }))];
		expect(templateEntries(items, cat).map((e) => e.label)).toEqual(['Alpha', 'Mid', 'Zed']);
		expect(templateEntries(items, cat, 'operation').map((e) => e.label)).toEqual(['Mid', 'Zed']);
		expect(templateEntries(items, cat, 'test').map((e) => e.label)).toEqual(['Alpha']);
	});
});

describe('the warning of a template', () => {
	it('is the first thing it names that is wrong', () => {
		const problem = (f: string, id: string) => (f === 'tool_id' && id === 't9' ? 'The tool X is retired.' : f === 'insert_edge_id' ? 'The cutting edge is used up.' : undefined);
		expect(warnOf({ equipment_id: 'e1' }, problem)).toBeUndefined();
		expect(warnOf({ equipment_id: 'e1', tool_id: 't9', insert_edge_id: 'g1' }, problem)).toBe('The tool X is retired.');
		expect(warnOf({ insert_edge_id: 'g1' }, problem)).toBe('The cutting edge is used up.');
		expect(warnOf({}, problem)).toBeUndefined();
	});
});
