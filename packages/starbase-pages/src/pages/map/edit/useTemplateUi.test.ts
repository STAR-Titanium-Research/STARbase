import { describe, expect, it } from 'vitest';
import { reactive, ref } from 'vue';
import type { ContainerNode } from '../model/types';
import { apply, emptyBody, type DraftAction } from './draft';
import { fakeServer, settle } from './fakeBuildServer';
import { useGearStatus } from './useGearStatus';
import { useTemplateUi } from './useTemplateUi';
import { useTemplates } from './useTemplates';

const run = (actions: DraftAction[]) => actions.reduce((b, a) => apply(b, a), emptyBody());

const col = (field: string, label: string) => ({ field, type: 'string', schema: {}, meta: {} , label });
const defs = ['method_id', 'process_category', 'equipment_id', 'tool_id', 'operator_person_id', 'planned_date', 'operation_date', 'notes', 'outcome_notes', 'machining_feed_mm_per_rev', 'test_type'].map((f) => col(f, f));
const labels = { method_id: 'Method', equipment_id: 'Machine', tool_id: 'Tool', operator_person_id: 'Operator', machining_feed_mm_per_rev: 'Feed' } as Record<string, string>;

/** A draft with one new Turning operation (n2, row n3) that has a machine, a tool, an operator, a date and notes, selected on the canvas. */
function setup(over: { values?: Record<string, unknown>; me?: { id?: string; admin?: boolean }; select?: boolean } = {}) {
	const f = fakeServer();
	const templates = useTemplates({ api: f.api, gear: useGearStatus(f.api), me: () => over.me ?? { id: 'u1' } });
	const body = ref(
		run([
			{ type: 'addSample' },
			{ type: 'addContainer', kind: 'operation', source: { from: 'template', values: over.values ?? { method_id: 'm-turn', process_category: 'machining', equipment_id: 'e1', tool_id: 'tool1', operator_person_id: 'p1', machining_feed_mm_per_rev: 0.2, planned_date: '2026-11-02', outcome_notes: 'hold 2 min' } }, from: { key: 'n1' } },
		]),
	);
	const node = { id: 'c1', type: 'container', kind: 'operation', title: 'Turning', group: { id: 'g1', kind: 'operation', rowIds: ['draft:n3'], batch: null } } as unknown as ContainerNode;
	const selectedId = ref<string | null>(over.select === false ? null : 'c1');
	const edit = {
		editing: ref(true),
		body,
		templates,
		catalog: {
			checkFields: ref({ manufacturing_operations: Object.entries(labels).map(([field, label]) => ({ field, label, required: false })) }),
			rawFields: ref({ manufacturing_operations: defs, test_sessions: defs }),
			methodById: ref(new Map([['m-turn', { id: 'm-turn', name: 'CNC Turning', code: 'MC', category: 'machining' as const }]])),
			testTypes: ref([]),
			records: reactive(new Map()),
			loadRecords: async () => undefined,
		},
	};
	const map = { graph: ref({ nodes: [node], wires: [], hidden: [], truncated: false }), selectedId };
	let opened = 0;
	const ui = useTemplateUi({ edit: edit as never, map: map as never, openPalette: () => void (opened += 1) });
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
