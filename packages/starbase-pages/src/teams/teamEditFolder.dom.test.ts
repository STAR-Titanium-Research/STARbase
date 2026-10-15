// @vitest-environment happy-dom
// The Team edit dialog's share folder (administrators): shown with the reset note, validated like the database, saved by /items/teams after
// the team itself is saved, and a refusal says the team was saved and names no other team.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, ref, type App } from 'vue';
import { setExplorerHostFactory, type TeamSummary } from '@d1/ui';
import TeamEditDialog from './TeamEditDialog.vue';

const Button = defineComponent({
	props: { disabled: Boolean, loading: Boolean },
	emits: ['click'],
	setup: (p, { slots, emit }) => () => h('button', { type: 'button', disabled: p.disabled || p.loading, onClick: () => emit('click') }, slots.default?.()),
});
const Div = defineComponent({ setup: (_p, { slots }) => () => h('div', slots.default?.()) });
const Dialog = defineComponent({ props: { modelValue: Boolean }, setup: (p, { slots }) => () => (p.modelValue ? h('div', { role: 'dialog' }, slots.default?.()) : null) });
const Input = defineComponent({ props: { modelValue: { type: String, default: '' } }, emits: ['update:modelValue'], setup: (p, { emit }) => () => h('input', { value: p.modelValue, onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value) }) });

const team = { team_id: 't1', name: 'Additive', description: null, color: 'teal', logo: null } as unknown as TeamSummary;
const failure = (message: string) => Object.assign(new Error('Request failed'), { response: { status: 400, data: { errors: [{ message, extensions: {} }] } } });

let app: App | null = null;
let api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
const saved = vi.fn();

async function open(t: TeamSummary | null, admin = true) {
	api = {
		get: vi.fn(async (url: string) => (url.startsWith('/items/teams/') ? { data: { data: { share_folder: 'Additive' } } } : { data: {} })),
		post: vi.fn(async (_u: string, body: any) => ({ data: { ...team, ...body, team_id: 't-new' } })),
		patch: vi.fn(async (url: string, body: any) => (url.startsWith('/d1-teams') ? { data: { ...team, ...body } } : { data: {} })),
		delete: vi.fn(),
	};
	setExplorerHostFactory(() => ({
		api: api as any, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(admin), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u-me' }),
	}));
	const model = ref(true);
	app = createApp({ render: () => h(TeamEditDialog, { modelValue: model.value, team: t, 'onUpdate:modelValue': (v: boolean) => (model.value = v), onSaved: saved }) });
	app.component('v-button', Button);
	app.component('v-dialog', Dialog);
	app.component('v-input', Input);
	app.component('v-textarea', Input);
	for (const n of ['v-card', 'v-card-title', 'v-card-text', 'v-card-actions']) app.component(n, Div);
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
}

const field = () => document.querySelector<HTMLInputElement>('[data-test="team-share-folder"]')!;
const type = (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input')); };
const saveButton = () => [...document.querySelectorAll('button')].find((b) => /^(Save|Create team)$/.test((b.textContent ?? '').trim()))!;
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

describe('Team edit dialog: share folder', () => {
	it('shows the field to an administrator with the reset note, and not to anyone else', async () => {
		await open(team);
		await vi.waitFor(() => expect(field().value).toBe('Additive'));
		expect(text()).toContain('Changing this resets the Inbox for this folder; linked files stay linked.');
		app!.unmount();
		document.body.innerHTML = '';
		await open(team, false);
		expect(document.querySelector('[data-test="team-folder"]')).toBeNull();
	});

	it('an unchanged folder is not sent; a changed one goes to /items/teams after the team is saved', async () => {
		await open(team);
		await vi.waitFor(() => expect(field().value).toBe('Additive'));
		saveButton().click();
		await vi.waitFor(() => expect(saved).toHaveBeenCalled());
		expect(api.patch.mock.calls.some(([url]) => String(url).startsWith('/items/teams'))).toBe(false);
		saved.mockReset();
		document.body.innerHTML = '';
		await open(team);
		await vi.waitFor(() => expect(field().value).toBe('Additive'));
		type(field(), ' Old project ');
		saveButton().click();
		await vi.waitFor(() => expect(saved).toHaveBeenCalled());
		const urls = api.patch.mock.calls.map(([url]) => String(url));
		expect(urls.findIndex((u) => u.startsWith('/d1-teams'))).toBeLessThan(urls.findIndex((u) => u.startsWith('/items/teams')));
		expect(api.patch).toHaveBeenLastCalledWith('/items/teams/t1', { share_folder: 'Old project' });
	});

	it('a folder with a slash is refused before anything is sent', async () => {
		await open(team);
		await vi.waitFor(() => expect(field().value).toBe('Additive'));
		type(field(), 'x/y');
		await vi.waitFor(() => expect(document.querySelector('[data-test="team-share-folder-issue"]')?.textContent).toContain('no slashes'));
		saveButton().click();
		await vi.waitFor(() => expect(text()).toContain('no slashes'));
		expect(api.patch).not.toHaveBeenCalled();
	});

	it('a new team is created, then its folder is set; a duplicate folder says the team was saved and names no other team', async () => {
		await open(null);
		type(document.querySelector<HTMLInputElement>('.edit-card input')!, 'Powder');
		type(field(), 'Additive');
		api.patch.mockRejectedValueOnce(failure('duplicate key value violates unique constraint "teams_share_folder_key"'));
		saveButton().click();
		await vi.waitFor(() => expect(text()).toContain('was saved, but the share folder was not: That share folder is already used by another team.'));
		expect(api.post).toHaveBeenCalledTimes(1);
		expect(api.patch).toHaveBeenCalledWith('/items/teams/t-new', { share_folder: 'Additive' });
		expect(saved).toHaveBeenCalledTimes(1);
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
	});
});
