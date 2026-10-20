import { describe, expect, it } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
import type { ContainerNode } from '../model/types';
import { apply, emptyBody, type DraftAction } from './draft';
import { fakeServer, settle } from './fakeBuildServer';
import { OPERATION_DEFS, TEST_DEFS } from './templateFields.fixtures';
import { useGearStatus } from './useGearStatus';
import { useTemplateUi } from './useTemplateUi';
import { useTemplates } from './useTemplates';

const run = (actions: DraftAction[]) => actions.reduce((b, a) => apply(b, a), emptyBody());

const labels = { method_id: 'Method', equipment_id: 'Machine', tool_id: 'Tool', operator_person_id: 'Operator', machining_feed_mm_per_rev: 'Feed' } as Record<string, string>;

/** A draft with one new Turning operation (n2, row n3) that has a machine, a tool, an operator, a date and notes, selected on the canvas. */
function setup(over: { values?: Record<string, unknown>; me?: { id?: string; admin?: boolean }; select?: boolean; recorded?: { restricted: boolean }; ensure?: (sets: Record<string, unknown>[]) => Promise<void> } = {}) {
	const f = fakeServer();
	const templates = useTemplates({ api: f.api, gear: useGearStatus(f.api), me: () => over.me ?? { id: 'u1' } });
	const body = ref(
		over.recorded
			? run([{ type: 'addExisting', kind: 'operation', record: { id: 'o1', version: 3 }, workState: 'done' }])
			: run([
			{ type: 'addSample' },
			{ type: 'addContainer', kind: 'operation', source: { from: 'template', values: over.values ?? { method_id: 'm-turn', process_category: 'machining', equipment_id: 'e1', tool_id: 'tool1', operator_person_id: 'p1', machining_feed_mm_per_rev: 0.2, planned_date: '2026-11-02', outcome_notes: 'hold 2 min' } }, from: { key: 'n1' } },
		]),
	);
	const node = { id: 'c1', type: 'container', kind: 'operation', title: 'Turning', group: { id: 'g1', kind: 'operation', rowIds: [over.recorded ? 'o1' : 'draft:n3'], batch: null } } as unknown as ContainerNode;
	const selectedId = ref<string | null>(over.select === false ? null : 'c1');
	const edit = {
		editing: ref(true),
		drafted: ref(true),
		body,
		catalog: {
			checkFields: ref({ manufacturing_operations: Object.entries(labels).map(([field, label]) => ({ field, label, required: false })) }),
			rawFields: ref({ manufacturing_operations: OPERATION_DEFS, test_sessions: TEST_DEFS }),
			methodById: ref(new Map([['m-turn', { id: 'm-turn', name: 'CNC Turning', code: 'MC', category: 'machining' as const }]])),
			testTypes: ref([]),
			records: reactive(new Map()),
			loadRecords: async () => undefined,
			gear: { ensure: async (sets: Iterable<Record<string, unknown>>) => over.ensure?.([...sets]) },
		},
	};
	if (over.recorded) edit.catalog.records.set('manufacturing_operations:o1', { version: 3, values: { method_id: 'm-turn', process_category: 'machining', equipment_id: 'e1', restricted: over.recorded.restricted } } as never);
	const map = { graph: ref({ nodes: [node], wires: [], hidden: [], truncated: false }), selectedId };
	let opened = 0;
	const ui = useTemplateUi({ edit: edit as never, templates, map: map as never, openPalette: () => void (opened += 1) });
	return { ...f, edit, map, ui, templates, selectedId, opened: () => opened };
}

describe('Save as template', () => {
	it('is offered for a selected container in edit mode', async () => {
		const x = setup();
		expect(x.ui.canSaveSelected.value).toBe(true);
		expect(x.ui.selectedKind.value).toBe('operation');
		x.selectedId.value = null;
		expect(x.ui.canSaveSelected.value).toBe(false);
		x.selectedId.value = 'c1';
		x.edit.editing.value = false;
		expect(x.ui.canSaveSelected.value).toBe(false);
		expect(await x.ui.openSelected()).toBe(false);
		expect(x.ui.saving.value).toBeNull();
	});

	it('opens with the method as the name and what it keeps listed, never the date or the notes', async () => {
		const x = setup();
		expect(await x.ui.openSelected()).toBe(true);
		const s = x.ui.saving.value!;
		expect(s).toMatchObject({ what: 'operation', collection: 'manufacturing_operations', name: 'CNC Turning', problem: null, hasNotes: true });
		expect(s.values).toEqual({ method_id: 'm-turn', process_category: 'machining', equipment_id: 'e1', tool_id: 'tool1', operator_person_id: 'p1', machining_feed_mm_per_rev: 0.2 });
		expect(s.valuesWithNotes).toEqual({ ...s.values, outcome_notes: 'hold 2 min' });
		expect(s.labels).toEqual(['Method', 'Machine', 'Tool', 'Operator', 'Feed']);
	});

	it('saves what was asked: private by default, the notes only when ticked, then closes, opens the palette and says so', async () => {
		const x = setup();
		await x.ui.openSelected();
		await x.ui.save({ name: 'Roughing', scope: 'private', notes: false });
		expect(x.s.templates).toHaveLength(1);
		expect(x.s.templates[0]).toMatchObject({ name: 'Roughing', scope: 'private', collection: 'manufacturing_operations' });
		expect(x.s.templates[0].values).not.toHaveProperty('outcome_notes');
		expect(x.s.templates[0].values).not.toHaveProperty('planned_date');
		expect(x.ui.saving.value).toBeNull();
		expect(x.ui.notice.value).toBe('Saved the template Roughing.');
		expect(x.opened()).toBe(1);

		await x.ui.openSelected();
		await x.ui.save({ name: 'With notes', scope: 'global', notes: true });
		expect(x.s.templates[1]).toMatchObject({ name: 'With notes', scope: 'global', values: { outcome_notes: 'hold 2 min' } });
	});

	it('stays open and says what the server said when it is refused', async () => {
		const x = setup();
		await x.ui.openSelected();
		x.s.templateStatus = 403;
		await x.ui.save({ name: 'Roughing', scope: 'private', notes: false });
		expect(x.ui.saving.value).toMatchObject({ busy: false, error: expect.stringMatching(/Only the person who made a template/) });
		expect(x.s.templates).toEqual([]);
	});

	it('cannot be saved for an operation with no method yet, and says so', async () => {
		const x = setup({ values: { equipment_id: 'e1' } });
		await x.ui.openSelected();
		expect(x.ui.saving.value?.problem).toMatch(/method/);
	});

	it('closes without saving', async () => {
		const x = setup();
		await x.ui.openSelected();
		x.ui.closeSave();
		expect(x.ui.saving.value).toBeNull();
		expect(x.s.templates).toEqual([]);
	});
});

describe('the gear the draft names is read for the checks', () => {
	it('reads what a new card names, and the gear the person picks for an attached operation, not the attached record\'s own', async () => {
		const seen: Record<string, unknown>[][] = [];
		const x = setup({ ensure: async (sets) => void seen.push(sets) });
		expect(seen.at(-1)).toContainEqual(expect.objectContaining({ equipment_id: 'e1', tool_id: 'tool1' }));
		// An operation attached from the database (its own machine is not in the draft's values), then a tool picked for it in the rail.
		x.edit.body.value = run([
			{ type: 'addSample' },
			{ type: 'attach', operation: { id: 'op-9', version: 3 }, workState: 'planned', from: { key: 'n1' } },
		]);
		await nextTick();
		expect(seen.at(-1)).not.toContainEqual(expect.objectContaining({ equipment_id: expect.anything() }));
		expect(seen.at(-1)).not.toContainEqual(expect.objectContaining({ tool_id: expect.anything() }));
		x.edit.body.value = apply(x.edit.body.value, { type: 'setValues', key: 'n2', values: { tool_id: 'old-tool' } });
		await nextTick();
		expect(seen.at(-1)).toContainEqual({ tool_id: 'old-tool' });
	});

	it('does not read the gear of an existing record that is only on the canvas', async () => {
		const seen: Record<string, unknown>[][] = [];
		setup({ recorded: { restricted: false }, ensure: async (sets) => void seen.push(sets) });
		expect(seen.at(-1)).toEqual([]);
	});
});

describe('a restricted record is not published through a template', () => {
	it('opens for a restricted record with the shared scopes refused, and a role or everyone save sends nothing', async () => {
		const x = setup({ recorded: { restricted: true } });
		expect(await x.ui.openSelected()).toBe(true);
		expect(x.ui.saving.value).toMatchObject({ restricted: true, problem: null });
		await x.ui.save({ name: 'Shared', scope: 'role', notes: false });
		expect(x.ui.saving.value?.error).toMatch(/restricted.*only me/i);
		await x.ui.save({ name: 'Shared', scope: 'global', notes: false });
		expect(x.s.templates).toEqual([]);
		expect(x.s.calls.filter((c) => c.startsWith('POST /d1-build/templates'))).toEqual([]);
		// Private is fine: nobody else sees it.
		await x.ui.save({ name: 'Mine', scope: 'private', notes: false });
		expect(x.s.templates).toHaveLength(1);
		expect(x.s.templates[0]).toMatchObject({ name: 'Mine', scope: 'private', values: { method_id: 'm-turn', equipment_id: 'e1' } });
	});

	it('a record that is not restricted, and a new card, are shared as asked', async () => {
		const open = setup({ recorded: { restricted: false } });
		await open.ui.openSelected();
		expect(open.ui.saving.value?.restricted).toBe(false);
		await open.ui.save({ name: 'Shared', scope: 'global', notes: false });
		expect(open.s.templates[0].scope).toBe('global');
		const fresh = setup();
		await fresh.ui.openSelected();
		expect(fresh.ui.saving.value?.restricted).toBe(false);
	});

	it('will not put a restricted card\'s settings into a template others can see', async () => {
		const x = setup({ recorded: { restricted: true } });
		x.s.templates.push({ id: 't1', name: 'Shared', scope: 'global', role_id: null, collection: 'manufacturing_operations', values: { method_id: 'm-turn' }, user_id: 'u1', updated_at: 'now', version: 1 } as never);
		await x.templates.ensure();
		expect(await x.ui.replace('t1')).toBe(false);
		expect(x.templates.error.value).toMatch(/restricted/);
		expect(x.s.calls.filter((c) => c.startsWith('PATCH'))).toEqual([]);
		x.s.templates[0].scope = 'private';
		await x.templates.refresh();
		expect(await x.ui.replace('t1')).toBe(true);
	});
});

describe('managing from the palette', () => {
	const seeded = async (x: ReturnType<typeof setup>, over: Record<string, unknown> = {}) => {
		x.s.templates.push({ id: 't1', name: 'Roughing', scope: 'private', role_id: null, collection: 'manufacturing_operations', values: { method_id: 'm-turn', equipment_id: 'old' }, user_id: 'u1', updated_at: 'now', version: 1, ...over } as never);
		await x.templates.ensure();
		await settle();
	};

	it('renames, changes the scope and deletes, saying each', async () => {
		const x = setup();
		await seeded(x);
		expect(await x.ui.rename('t1', 'Finishing')).toBe(true);
		expect(x.ui.notice.value).toBe('Renamed the template Finishing.');
		expect(await x.ui.setScope('t1', 'role')).toBe(true);
		expect(x.s.templates[0]).toMatchObject({ name: 'Finishing', scope: 'role' });
		expect(await x.ui.remove('t1')).toBe(true);
		expect(x.ui.notice.value).toBe('Deleted the template Finishing. What was made from it is unchanged.');
		expect(x.s.templates).toEqual([]);
	});

	it('replaces the settings with those of the selected card (never its notes or date)', async () => {
		const x = setup();
		await seeded(x);
		expect(await x.ui.replace('t1')).toBe(true);
		expect(x.s.templates[0].values).toEqual({ method_id: 'm-turn', process_category: 'machining', equipment_id: 'e1', tool_id: 'tool1', operator_person_id: 'p1', machining_feed_mm_per_rev: 0.2 });
		expect(x.ui.notice.value).toMatch(/Replaced the settings of Roughing with those of Turning/);
	});

	it('keeps the template\'s own notes when its settings are replaced, and says so; a template without notes gets none', async () => {
		const x = setup();
		await seeded(x, { values: { method_id: 'm-turn', equipment_id: 'old', outcome_notes: 'check the chuck first' } });
		expect(await x.ui.replace('t1')).toBe(true);
		expect(x.s.templates[0].values).toMatchObject({ equipment_id: 'e1', outcome_notes: 'check the chuck first' });
		expect(x.ui.notice.value).toMatch(/Its notes were kept\./);
		const plain = setup();
		await seeded(plain);
		await plain.ui.replace('t1');
		expect(plain.s.templates[0].values).not.toHaveProperty('outcome_notes');
		expect(plain.ui.notice.value).not.toMatch(/notes/);
	});

	it('refuses to replace a test template with an operation card, and nothing is sent', async () => {
		const x = setup();
		await seeded(x, { collection: 'test_sessions', values: { test_type: 'tensile' } });
		expect(await x.ui.replace('t1')).toBe(false);
		expect(x.templates.error.value).toMatch(/Select a test/);
		expect(x.s.calls.filter((c) => c.startsWith("PATCH"))).toEqual([]);
	});

	it('says plainly when someone else changed the template (a stale version)', async () => {
		const x = setup();
		await seeded(x);
		x.s.templates[0].version = 4;
		expect(await x.ui.rename('t1', 'Mine')).toBe(false);
		expect(x.templates.error.value).toMatch(/changed since you opened it/);
		expect(x.ui.paletteProps.value).toMatchObject({ templateFailed: true, templateNotice: expect.stringMatching(/try again/) });
	});

	it('binds what the palette needs: the notice, whether the selected card can be a source, and the events', async () => {
		const x = setup();
		expect(x.ui.paletteProps.value).toMatchObject({ selectedKind: 'operation', selectedTitle: 'Turning', templateFailed: false, templateNotice: '' });
		expect(Object.keys(x.ui.paletteEvents)).toEqual(['template-rename', 'template-scope', 'template-replace', 'template-delete', 'template-dismiss']);
		x.templates.error.value = 'x';
		x.ui.paletteEvents['template-dismiss']();
		expect(x.templates.error.value).toBe('');
	});
});
