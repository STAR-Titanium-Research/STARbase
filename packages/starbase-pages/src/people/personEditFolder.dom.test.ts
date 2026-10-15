// @vitest-environment happy-dom
// The People edit dialog's inbox fields (administrators): the uni alias and "Scan while Former", with the reset note; a new person is created
// WITHOUT them and they are set by a second PATCH; an existing person's save sends only what changed; the alias is checked like the database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, ref, type App } from 'vue';
import { setExplorerHostFactory } from '@d1/ui';
import PersonEditDialog from './PersonEditDialog.vue';
import type { PeopleRow } from './peopleQuery';

const Button = defineComponent({
	props: { disabled: Boolean, loading: Boolean },
	emits: ['click'],
	setup: (p, { slots, emit }) => () => h('button', { type: 'button', disabled: p.disabled || p.loading, onClick: () => emit('click') }, slots.default?.()),
});
const Div = defineComponent({ setup: (_p, { slots }) => () => h('div', slots.default?.()) });
const Dialog = defineComponent({ props: { modelValue: Boolean }, setup: (p, { slots }) => () => (p.modelValue ? h('div', { role: 'dialog' }, slots.default?.()) : null) });
// v-input / v-textarea / v-select are plain inputs here: only the alias fields are under test.
const Input = defineComponent({ props: { modelValue: { type: String, default: '' } }, emits: ['update:modelValue'], setup: (p, { emit }) => () => h('input', { value: p.modelValue, onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value) }) });

const row = (over: Partial<PeopleRow> = {}): PeopleRow => ({
	kind: 'person', person_id: 'p1', full_name: 'Ann Lee', email: null, is_researcher: true, is_operator: false, active: true, notes: null, user_id: null, login: null, attention: [], ...over,
});

const failure = (message: string, code?: string) => Object.assign(new Error('Request failed'), { response: { status: 400, data: { errors: [{ message, extensions: code ? { code } : {} }] } } });

let app: App | null = null;
let api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
const saved = vi.fn();

async function open(person: PeopleRow | null, admin = true) {
	api = {
		get: vi.fn(async (url: string) => (url.startsWith('/items/people/') ? { data: { data: { uni_alias: 'ab1cd', scan_while_former: false } } } : { data: { data: [] } })),
		post: vi.fn(async () => ({ data: { data: { person_id: 'p-new' } } })),
		patch: vi.fn(async () => ({ data: {} })),
		delete: vi.fn(),
	};
	setExplorerHostFactory(() => ({
		api: api as any, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(admin), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u-me' }),
	}));
	const model = ref(true);
	app = createApp({ render: () => h(PersonEditDialog, { modelValue: model.value, person, 'onUpdate:modelValue': (v: boolean) => (model.value = v), onSaved: saved }) });
	app.component('v-button', Button);
	app.component('v-dialog', Dialog);
	app.component('v-icon', Div);
	app.component('v-input', Input);
	app.component('v-textarea', Input);
	app.component('v-select', Div);
	app.component('v-checkbox', Div);
	for (const n of ['v-card', 'v-card-title', 'v-card-text', 'v-card-actions']) app.component(n, Div);
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
}

const alias = () => document.querySelector<HTMLInputElement>('[data-test="person-alias"]')!;
const former = () => document.querySelector<HTMLInputElement>('[data-test="person-scan-former"]')!;
const type = (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input')); };
const saveButton = () => [...document.querySelectorAll('button')].find((b) => /^(Save|Add person)$/.test((b.textContent ?? '').trim()))!;
const text = () => document.querySelector('[role="dialog"]')?.textContent ?? '';

beforeEach(() => {
	document.body.innerHTML = '';
	saved.mockReset();
});
afterEach(() => {
	app?.unmount();
	app = null;
	setExplorerHostFactory(null);
});

describe('People edit dialog: uni alias and Scan while Former', () => {
	it('shows the fields to an administrator with the reset note, and not to a member', async () => {
		await open(row());
		await vi.waitFor(() => expect(alias().value).toBe('ab1cd'));
		expect(text()).toContain('Changing this resets the Inbox for this folder; linked files stay linked.');
		expect(text()).toContain('Scan while Former');
		app!.unmount();
		document.body.innerHTML = '';
		await open(row(), false);
		expect(document.querySelector('[data-test="person-folder"]')).toBeNull();
	});

	it('an existing person: a save with nothing changed sends no alias; a changed alias sends only that', async () => {
		await open(row());
		await vi.waitFor(() => expect(alias().value).toBe('ab1cd'));
		saveButton().click();
		await vi.waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(api.patch.mock.calls[0][1]).not.toHaveProperty('uni_alias');
		expect(api.patch.mock.calls[0][1]).not.toHaveProperty('scan_while_former');
		await vi.waitFor(() => expect(saved).toHaveBeenCalled());
	});

	it('an existing person: changing the alias and the switch sends them', async () => {
		await open(row());
		await vi.waitFor(() => expect(alias().value).toBe('ab1cd'));
		type(alias(), ' zz9 ');
		former().checked = true;
		former().dispatchEvent(new Event('change'));
		saveButton().click();
		await vi.waitFor(() => expect(api.patch).toHaveBeenCalled());
		expect(api.patch).toHaveBeenCalledWith('/items/people/p1', expect.objectContaining({ uni_alias: 'zz9', scan_while_former: true }));
	});

	it('an invalid alias is refused before anything is sent', async () => {
		await open(row());
		await vi.waitFor(() => expect(alias().value).toBe('ab1cd'));
		type(alias(), 'a/b');
		await vi.waitFor(() => expect(document.querySelector('[data-test="person-alias-issue"]')?.textContent).toContain('letters, digits'));
		saveButton().click();
		await vi.waitFor(() => expect(text()).toContain('Use letters, digits'));
		expect(api.patch).not.toHaveBeenCalled();
		type(alias(), '.ab');
		await vi.waitFor(() => expect(document.querySelector('[data-test="person-alias-issue"]')?.textContent).toContain('cannot start with a dot'));
	});

	it('a duplicate alias shows the message that names no one, and the dialog stays open', async () => {
		await open(row());
		await vi.waitFor(() => expect(alias().value).toBe('ab1cd'));
		api.patch.mockRejectedValueOnce(failure('Value for field "uni_alias" in collection "people" has to be unique.', 'RECORD_NOT_UNIQUE'));
		type(alias(), 'taken1');
		saveButton().click();
		await vi.waitFor(() => expect(text()).toContain('That alias is already used by another person.'));
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		expect(saved).not.toHaveBeenCalled();
	});

	it('a new person is created WITHOUT the alias, then the alias is set by a second PATCH', async () => {
		await open(null);
		const name = document.querySelector<HTMLInputElement>('.edit-card input')!;
		type(name, 'Bo Chan');
		type(alias(), 'bc2de');
		saveButton().click();
		await vi.waitFor(() => expect(api.patch).toHaveBeenCalled());
		expect(api.post).toHaveBeenCalledTimes(1);
		expect(api.post.mock.calls[0][1]).not.toHaveProperty('uni_alias');
		expect(api.post.mock.calls[0][1]).not.toHaveProperty('scan_while_former');
		expect(api.patch).toHaveBeenCalledWith('/items/people/p-new', { uni_alias: 'bc2de' });
		await vi.waitFor(() => expect(saved).toHaveBeenCalled());
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
	});

	it('if the second PATCH fails the person stays, the list is told, and the message says what was not saved', async () => {
		await open(null);
		type(document.querySelector<HTMLInputElement>('.edit-card input')!, 'Bo Chan');
		type(alias(), 'bc2de');
		api.patch.mockRejectedValueOnce(failure('duplicate key value violates unique constraint "people_uni_alias_key"'));
		saveButton().click();
		await vi.waitFor(() => expect(text()).toContain('Bo Chan was added, but the folder settings were not saved: That alias is already used by another person.'));
		expect(saved).toHaveBeenCalledTimes(1);
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		// the next Save is an edit of the new person and sends the alias
		type(alias(), 'bc2df');
		saveButton().click();
		await vi.waitFor(() => expect(api.patch).toHaveBeenLastCalledWith('/items/people/p-new', expect.objectContaining({ uni_alias: 'bc2df' })));
		expect(api.post).toHaveBeenCalledTimes(1);
	});
});
