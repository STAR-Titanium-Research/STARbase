// @vitest-environment happy-dom
// The fields typed on a new card (K4-K6, K8): what is drawn, that typing goes to the draft item the side form edits, that the map's keys
// stay out of a card's field, that what is missing is amber, and that the canvas is told when the card grew.
// (Named .dom.test.ts: `cardFields.test.ts`, the pure part, differs from it only by case, which a Windows checkout cannot hold.)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { setExplorerHostFactory, type Check, type DraftBody, type ExplorerHost } from '@d1/ui';
import { keyTarget } from '../keyboard';
import { keyDecision as mapKeyDecision } from '../useMapInput';
import CardFields from './CardFields.vue';
import DraftItemForm from './DraftItemForm.vue';
import { apply, emptyBody, type DraftAction } from './draft';
import { EDIT_RAIL_KEY, type EditRailContext } from './railContext';
import { EDIT_MODE_KEY, type EditMode } from './useEditMode';
import { useEditKeys } from './useEditKeys';

setExplorerHostFactory(() => ({ api: { get: async () => ({ data: { data: [] } }) } }) as unknown as ExplorerHost);

let app: App | null = null;
afterEach(() => {
	app?.unmount();
	app = null;
	document.body.innerHTML = '';
});

const def = (field: string, meta: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
	field, type: 'string', schema: { data_type: 'text', is_nullable: true }, meta: { interface: 'input', sort: null, width: 'half', ...meta }, ...extra,
});
const m2o = (field: string, table: string, meta: Record<string, unknown> = {}) => def(field, { interface: 'select-dropdown-m2o', special: ['m2o'], ...meta }, { schema: { foreign_key_table: table, foreign_key_column: 'id' } });
const showWhenMachining = [{ name: 'machining', rule: { _and: [{ process_category: { _eq: 'machining' } }] }, hidden: false }];
const number = (field: string, meta: Record<string, unknown> = {}) => def(field, { hidden: true, conditions: showWhenMachining, ...meta }, { type: 'decimal', schema: { data_type: 'numeric' } });
const OPERATION_DEFS = [
	def('process_category', { interface: 'd1-process-category', sort: 1 }),
	m2o('method_id', 'manufacturing_methods', { sort: 2 }),
	m2o('equipment_id', 'equipment', { sort: 3 }),
	def('planned_date', { interface: 'datetime', sort: 4 }, { type: 'date', schema: { data_type: 'date' } }),
	number('machining_cutting_speed_m_per_min', { sort: 5, options: { suffix: 'm/min' } }),
	number('machining_feed_mm_per_rev', { sort: 6 }),
	def('notes', { interface: 'input-multiline', sort: 9 }, { type: 'text' }),
];
const SAMPLE_DEFS = [
	def('nickname', { sort: 1 }),
	m2o('material_id', 'materials', { sort: 2 }),
	def('form', { interface: 'select-dropdown', options: { choices: [{ text: 'Disc', value: 'disc' }] }, sort: 3 }),
	m2o('primary_method_id', 'manufacturing_methods', { sort: 4 }),
	def('notes', { interface: 'input-multiline', sort: 9 }, { type: 'text' }),
];

const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);
/** n1 a sample, n2 a Turning operation (row n3) taking it in, n4 the sample it makes. */
const cut = () =>
	run([
		{ type: 'addSample' },
		{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm-turn' }, from: { key: 'n1' } },
		{ type: 'setValues', key: 'n2', values: { method_id: 'm-turn', process_category: 'machining' } },
		{ type: 'addSample', from: { key: 'n2', row: 0 } },
	]);

function fakeEdit(body: DraftBody, checks: Check[] = []) {
	const state = ref(body);
	const list = ref(checks);
	const setValues = vi.fn((key: string, values: Record<string, unknown>) => void (state.value = apply(state.value, { type: 'setValues', key, values })));
	const edit = {
		body: state,
		checks: list,
		setValues,
		catalog: {
			rawFields: ref({ manufacturing_operations: OPERATION_DEFS, physical_samples: SAMPLE_DEFS, test_sessions: [] }),
			ctx: () => ({}),
			methodById: ref(new Map([['m-turn', { id: 'm-turn', name: 'Turning', code: 'TUR', category: 'machining' }]])),
		},
	};
	return { edit: edit as unknown as EditMode, state, list, setValues };
}

function mount(o: { edit: EditMode; key: string; rail?: Partial<EditRailContext>; onGrew?: () => void; extra?: () => unknown }) {
	const el = document.createElement('div');
	document.body.appendChild(el);
	const itemOf = () => o.edit.body.value.items.find((i) => i.key === o.key)!;
	app = createApp(defineComponent({ render: () => h('div', [h(CardFields, { item: itemOf(), onGrew: o.onGrew }), o.extra?.() as never]) }));
	app.component('v-icon', defineComponent({ props: { name: String }, setup: (p) => () => h('i', { class: 'v-icon' }, p.name) }));
	app.provide(EDIT_MODE_KEY, o.edit);
	if (o.rail) app.provide(EDIT_RAIL_KEY, { labelFor: (k: string) => k, select: () => undefined, openExternal: () => undefined, showMissing: ref(false), ...o.rail });
	app.mount(el);
	return el;
}
const settle = async () => {
	for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
	await nextTick();
};
const input = (el: Element, field: string) => el.querySelector<HTMLInputElement>(`[data-field="${field}"] input, [data-field="${field}"] select`)!;
const type = (el: HTMLInputElement, value: string) => {
	el.value = value;
	el.dispatchEvent(new Event('input', { bubbles: true }));
};
const fields = (el: Element) => [...el.querySelectorAll('[data-field]')].map((r) => r.getAttribute('data-field'));

describe('CardFields: an operation card', () => {
	it('draws the machine as a slot row with its icon, the date and the kind\'s key settings, never the kind', async () => {
		const { edit } = fakeEdit(cut());
		const el = mount({ edit, key: 'n2' });
		await settle();
		expect(fields(el)).toEqual(['equipment_id', 'planned_date', 'machining_cutting_speed_m_per_min', 'machining_feed_mm_per_rev']);
		const slot = el.querySelector('.slotrow')!;
		expect(slot.querySelector('[data-field="equipment_id"]')).not.toBeNull();
		expect(slot.querySelector('.v-icon')?.textContent).toBe('precision_manufacturing');
		expect(el.querySelectorAll('.slotrow')).toHaveLength(1);
		expect(el.querySelector('[data-field="method_id"]')).toBeNull();
		expect(el.querySelector('.card-fields')?.classList.contains('nodrag')).toBe(true);
		expect(el.querySelector('.card-fields')?.classList.contains('nopan')).toBe(true);
		expect(el.textContent).toContain('All fields in the side panel');
	});

	it('draws nothing until the form\'s field definitions are read', async () => {
		const { edit } = fakeEdit(cut());
		edit.catalog.rawFields.value = {};
		const el = mount({ edit, key: 'n2' });
		await settle();
		expect(el.querySelector('.card-fields')).toBeNull();
	});

	it('typing in a card input is a change of the draft item (edit.setValues, as the side form does)', async () => {
		const { edit, setValues, state } = fakeEdit(cut());
		const el = mount({ edit, key: 'n2' });
		await settle();
		type(input(el, 'machining_feed_mm_per_rev'), '0.2');
		await settle();
		expect(setValues).toHaveBeenCalledTimes(1);
		expect(setValues.mock.calls[0][0]).toBe('n2');
		expect(setValues.mock.calls[0][1]).toMatchObject({ machining_feed_mm_per_rev: 0.2 });
		expect(state.value.items.find((i) => i.key === 'n2')!.values.machining_feed_mm_per_rev).toBe(0.2);
	});

	it('flags what the checks say is missing (amber row, an asterisk), and the others are plain', async () => {
		const { edit } = fakeEdit(cut(), [
			{ key: 'n2', level: 'warn', field: 'equipment_id', text: 'No machine yet.' },
			{ key: 'n2', level: 'block', field: 'planned_date', text: 'x', code: 'PERMISSION' },
			{ key: 'n9', level: 'warn', field: 'machining_feed_mm_per_rev', text: 'other card' },
		]);
		const el = mount({ edit, key: 'n2' });
		await settle();
		expect([...el.querySelectorAll('.row.flag')].map((r) => r.getAttribute('data-field'))).toEqual(['equipment_id']);
		expect(el.querySelector('[data-field="equipment_id"] abbr.req')?.getAttribute('aria-label')).toBe('missing');
		expect(el.querySelector('[data-field="planned_date"]')?.classList.contains('flag')).toBe(false);
	});

	it('tells the canvas when the card first draws its fields, and when its kind changes them', async () => {
		const { edit, state } = fakeEdit(cut());
		const onGrew = vi.fn();
		mount({ edit, key: 'n2', onGrew });
		await settle();
		expect(onGrew).toHaveBeenCalledTimes(1);
		state.value = apply(state.value, { type: 'setValues', key: 'n2', values: { process_category: 'sintering' } });
		await settle();
		expect(onGrew).toHaveBeenCalledTimes(2);
	});

	it('"All fields in the side panel" selects the card and puts the focus in the panel\'s form', async () => {
		const { edit } = fakeEdit(cut());
		const select = vi.fn();
		const el = mount({ edit, key: 'n2', rail: { select } });
		const panel = document.createElement('section');
		panel.className = 'pm-item';
		panel.innerHTML = '<form class="d1-field-form"><div data-field="equipment_id"><input id="rail-first"></div></form>';
		document.body.appendChild(panel);
		await settle();
		el.querySelector<HTMLButtonElement>('.all')!.click();
		await settle();
		expect(select).toHaveBeenCalledWith('n2');
		expect(document.activeElement?.id).toBe('rail-first');
	});
});

describe('CardFields: a sample card', () => {
	it('draws its name, material, geometry and Made by, typed when nothing makes it', async () => {
		const { edit } = fakeEdit(cut());
		const el = mount({ edit, key: 'n1' });
		await settle();
		expect(fields(el)).toEqual(['nickname', 'material_id', 'form', 'primary_method_id']);
		expect(el.querySelector('.slotrow')).toBeNull(); // the material is a dropdown of materials, not a slot row
		expect(input(el, 'primary_method_id').disabled).toBe(false);
	});

	it('shows Made by read-only, from the operation, on a sample a draft operation makes (§5a)', async () => {
		const { edit } = fakeEdit(cut());
		const el = mount({ edit, key: 'n4' });
		await settle();
		expect(input(el, 'primary_method_id').disabled).toBe(true);
		expect(input(el, 'nickname').disabled).toBe(false);
	});
});

describe('typing on a card while the side panel shows the same item (Review Focus 1)', () => {
	it('the two forms are views of one item: each shows what the other typed, and the typed-in input is not replaced', async () => {
		const { edit, state, setValues } = fakeEdit(cut());
		const rail = () => h(DraftItemForm, { item: state.value.items.find((i) => i.key === 'n1')!, fieldDefs: SAMPLE_DEFS, onUpdate: (v: Record<string, unknown>) => setValues('n1', v) });
		const el = mount({ edit, key: 'n1', extra: () => h('aside', { class: 'rail' }, [rail()]) });
		await settle();
		const card = () => el.querySelector('.card-fields')!;
		const side = () => el.querySelector('.rail')!;
		const typed = input(card(), 'nickname');
		type(typed, 'Bar A');
		await settle();
		expect(input(side(), 'nickname').value).toBe('Bar A');
		expect(input(card(), 'nickname')).toBe(typed); // the same element: the caret does not jump
		expect(typed.value).toBe('Bar A');
		type(input(side(), 'nickname'), 'Bar AB');
		await settle();
		expect(input(card(), 'nickname').value).toBe('Bar AB');
		// their label ids do not clash: each label points at its own input
		const ids = [...el.querySelectorAll('[data-field="nickname"] input')].map((i) => i.id);
		expect(new Set(ids).size).toBe(2);
	});
});

describe('the map\'s keys stay out of a card\'s field (Review Focus 2)', () => {
	const keys = [
		{ key: 'Delete' },
		{ key: 'Backspace' },
		{ key: 'x' },
		{ key: 'i' },
		{ key: 'A', shiftKey: true },
		{ key: 'ArrowLeft' },
		{ key: 'a', ctrlKey: true },
	];
	function mountWithKeys() {
		const spies = { add: vi.fn(), insert: vi.fn(() => true), undo: vi.fn(), redo: vi.fn(), remove: vi.fn(() => true), dissolve: vi.fn(() => true), duplicate: vi.fn(() => true), duplicateMany: vi.fn(() => true) };
		const { edit } = fakeEdit(cut());
		const Keys = defineComponent({
			setup() {
				useEditKeys({ editing: () => true, blocked: () => false, pointer: () => ({ x: 0, y: 0 }), ...spies });
				return () => null;
			},
		});
		const el = mount({ edit, key: 'n1', extra: () => h(Keys) });
		return { el, spies };
	}

	it('Delete, Backspace, X, I and Shift+A typed in a field do not remove the card or open the add search', async () => {
		const { el, spies } = mountWithKeys();
		await settle();
		const field = input(el, 'nickname');
		field.focus();
		const seen: boolean[] = [];
		for (const k of keys) {
			const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...k });
			field.dispatchEvent(e);
			seen.push(e.defaultPrevented);
		}
		expect(seen.every((p) => !p)).toBe(true); // the browser keeps the key, so the field edits
		for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
	});

	it('the same keys on the card with nothing in focus are the map\'s (the test above is not vacuous)', async () => {
		const { el, spies } = mountWithKeys();
		await settle();
		el.querySelector('.card-fields')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Delete' }));
		expect(spies.remove).toHaveBeenCalledTimes(1);
	});

	it('the canvas\'s own keyboard (Enter selects, + expands, o opens) leaves a field alone too', async () => {
		const { el } = mountWithKeys();
		await settle();
		const field = input(el, 'nickname');
		for (const key of ['Enter', '+', 'o']) expect(mapKeyDecision({ key }, keyTarget(field))).toEqual({ do: 'none' });
	});

	it('Escape leaves the field and does not travel on to anything that clears the selection', async () => {
		const { el } = mountWithKeys();
		await settle();
		const onWindow = vi.fn();
		window.addEventListener('keydown', onWindow);
		const field = input(el, 'nickname');
		field.focus();
		expect(document.activeElement).toBe(field);
		field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
		window.removeEventListener('keydown', onWindow);
		expect(document.activeElement).not.toBe(field);
		expect(onWindow).not.toHaveBeenCalled();
	});

	it('Escape puts the keyboard on the card the field is on, not on the page', async () => {
		const { edit } = fakeEdit(cut());
		const el = mount({ edit, key: 'n1' });
		el.classList.add('vue-flow__node'); // the card as the canvas draws it: a focusable node
		el.tabIndex = 0;
		await settle();
		const field = input(el, 'nickname');
		field.focus();
		field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
		expect(document.activeElement).toBe(el);
	});

	it('a double-click in a field (selecting a word) is not the card\'s double-click', async () => {
		const { edit } = fakeEdit(cut());
		const onCard = vi.fn();
		const el = mount({ edit, key: 'n1' });
		el.addEventListener('dblclick', onCard);
		await settle();
		input(el, 'nickname').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		expect(onCard).not.toHaveBeenCalled();
	});
});
