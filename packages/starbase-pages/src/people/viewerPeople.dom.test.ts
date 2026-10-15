// @vitest-environment happy-dom
// The People page for a Lab Viewer (migration 185), behaviourally: it shows what an administrator sees (everyone's panel, the Account section,
// the attention line, the access lists) and has no control that changes anything. The same page for an administrator is the control.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { setExplorerHostFactory } from '@d1/ui';
import { setPageFrame } from '../frame';
import PeopleView from './PeopleView.vue';

const ANN = 'p-ann';
const person = (id: string, name: string, extra: Record<string, unknown> = {}): any => ({
	person_id: id, full_name: name, email: `${id}@lab.example`, is_researcher: true, is_operator: false, active: true, notes: null, user_id: `u-${id}`,
	login: { status: 'active', role_id: 'r1', role_name: 'Lab Member', last_access: null, email: null }, attention: [], teams: [], ...extra,
});

function fakeApi() {
	return {
		get: vi.fn(async (url: string, config?: { params?: { list?: string } }) => {
			if (url === '/d1-people-admin/people') {
				return {
					data: {
						can_administer_accounts: false,
						roles: [{ id: 'r1', name: 'Lab Member' }],
						people: [person(ANN, 'Ann Member'), person('p-pi', 'Pat Viewer', { login: { status: 'active', role_id: 'r3', role_name: 'Lab Viewer', last_access: null, email: null } })],
						logins_without_person: [{ user_id: 'u-x', email: 'x@lab.example', first_name: null, last_name: null, status: 'active', role_id: 'r1', role_name: 'Lab Member', last_access: null }],
					},
				};
			}
			if (url === '/d1-people-admin/attention') return { data: { items: [{ key: 'login_without_person', count: 1 }] } };
			if (url.startsWith('/d1-people-admin/people/')) {
				const body: any = { owns: 1, shared: 0, investigator: 0, teams: 0, waiting: 0, waiting_owners: 0 };
				if (config?.params?.list === 'owns') {
					body.records = [{ collection: 'physical_samples', id: 's1', kind: 'sample', code: 'SM-001', title: 'Bar A', level: 'view', source: 'access', granted_by: 'Bob', added_at: null }];
				}
				return { data: body };
			}
			if (url === '/d1-teams') return { data: { teams: [] } };
			return { data: { data: [] } };
		}),
		post: vi.fn(),
		patch: vi.fn(),
		delete: vi.fn(),
	};
}

const Plain = (tag: string) => defineComponent({ inheritAttrs: true, setup: (_p, { slots }) => () => h(tag, slots.default?.()) });
const Nothing = defineComponent({ setup: () => () => null });
function registerStubs(app: App) {
	for (const n of ['v-button', 'v-icon', 'v-input', 'v-notice', 'v-progress-circular']) app.component(n, Plain('span'));
	app.component('v-select', Plain('select'));
	for (const n of ['v-dialog', 'v-card', 'v-card-title', 'v-card-text', 'v-card-actions', 'v-checkbox', 'v-textarea']) app.component(n, Nothing);
}

let app: App | null = null;
let api: ReturnType<typeof fakeApi>;

async function mountAs(who: { isAdmin: boolean; viewer: boolean }, rowsExpected = 3) {
	window.matchMedia = ((q: string) => ({ matches: q.includes('min-width: 1000px'), addEventListener() {}, removeEventListener() {} })) as any;
	api = fakeApi();
	setExplorerHostFactory(() => ({
		api: api as any, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(who.isAdmin), adminKnown: ref(true),
		canViewAllAccess: ref(who.viewer), user: ref({ id: 'u-me', role: who.viewer ? 'r3' : 'r1' }),
	}));
	setPageFrame(defineComponent({ props: { title: String }, setup: (_p, { slots }) => () => h('div', [slots.default?.()]) }));
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/people', component: PeopleView }] });
	await router.push('/people');
	app = createApp({ render: () => h('div', [h(RouterView)]) });
	app.use(router);
	registerStubs(app);
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	await vi.waitFor(() => expect(document.querySelectorAll('.prow').length).toBe(rowsExpected));
}

const row = (id: string) => document.querySelector<HTMLElement>(`.prow[data-key="${id}"]`)!;
const text = () => document.body.textContent ?? '';
const buttons = (label: RegExp) => [...document.querySelectorAll('button, .act')].filter((b) => label.test((b.textContent ?? '').trim()));
const openPanelWithList = async () => {
	row(ANN).click();
	await vi.waitFor(() => expect(document.querySelector('.person-panel')).not.toBeNull());
	await vi.waitFor(() => expect(buttons(/^1 record$/).length).toBe(1));
	(buttons(/^1 record$/)[0] as HTMLElement).click();
	await vi.waitFor(() => expect(document.querySelector('.recs li')).not.toBeNull());
};

beforeEach(() => {
	document.body.innerHTML = '';
});
afterEach(() => {
	app?.unmount();
	app = null;
	setExplorerHostFactory(null);
	setPageFrame(null);
	document.body.innerHTML = '';
});

describe('People for a Lab Viewer', () => {
	it('loads the administrator reads (people and attention), shows every login, and offers no Invite, Add person or Link', async () => {
		await mountAs({ isAdmin: false, viewer: true });
		const urls = api.get.mock.calls.map((c) => c[0]);
		expect(urls).toContain('/d1-people-admin/people');
		expect(urls).toContain('/d1-people-admin/attention');
		expect(urls).not.toContain('/items/people'); // the member's list is not what a viewer reads
		expect(text()).toContain('Lab Member'); // the account role column is shown
		expect(text()).toContain('1 thing needs attention'); // the attention line is shown
		expect(buttons(/Invite/)).toHaveLength(0);
		expect(buttons(/Add person/)).toHaveLength(0);
		expect(buttons(/Link to a person/)).toHaveLength(0);
		// the viewer's own login is listed under Users, not Admins
		const groupOf = (id: string) => row(id).closest('.group')?.querySelector('.grp')?.textContent ?? '';
		expect(groupOf('p-pi')).toMatch(/^Users/);
	});

	it("opens anyone's panel with the Account section, Teams and the access counts, and a record list, with nothing that changes anything", async () => {
		await mountAs({ isAdmin: false, viewer: true });
		await openPanelWithList();
		const panel = document.querySelector('.person-panel')!;
		expect(panel.querySelector('[aria-label="Account"]')).not.toBeNull();
		expect(panel.querySelector('[aria-label="Teams"]')).not.toBeNull();
		expect(panel.querySelector('[aria-label="Access"]')).not.toBeNull();
		expect(panel.textContent).toContain('Lab Member'); // the role, as text
		expect(panel.textContent).toContain('Active');
		expect(panel.textContent).toContain('SM-001');
		// nothing that changes anything
		expect(panel.querySelector('.edit')).toBeNull(); // Edit
		expect(panel.querySelector('select')).toBeNull(); // the role select
		expect(buttons(/Suspend|Reactivate|Resend|Invite|Remove/)).toHaveLength(0);
		expect(api.patch).not.toHaveBeenCalled();
		expect(api.post).not.toHaveBeenCalled();
		expect(api.delete).not.toHaveBeenCalled();
	});

	it('the same page for an administrator has every control (so the checks above bite)', async () => {
		await mountAs({ isAdmin: true, viewer: false });
		expect(buttons(/Invite/).length).toBeGreaterThan(0);
		expect(buttons(/Add person/).length).toBeGreaterThan(0);
		expect(buttons(/Link to a person/).length).toBeGreaterThan(0);
		await openPanelWithList();
		const panel = document.querySelector('.person-panel')!;
		expect(panel.querySelector('.edit')).not.toBeNull();
		expect(panel.querySelector('select')).not.toBeNull();
		expect(buttons(/^Remove$/).length).toBe(1);
	});

	it('a viewer who is also flagged an administrator is still read-only (the role decides)', async () => {
		await mountAs({ isAdmin: true, viewer: true });
		expect(buttons(/Invite/)).toHaveLength(0);
		expect(buttons(/Add person/)).toHaveLength(0);
		await openPanelWithList();
		expect(document.querySelector('.person-panel .edit')).toBeNull();
		expect(buttons(/^Remove$/)).toHaveLength(0);
	});

	it('a Lab Member (neither) keeps the member list: no administrator endpoint is asked', async () => {
		await mountAs({ isAdmin: false, viewer: false }, 0).catch(() => {});
		await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
		const urls = api.get.mock.calls.map((c) => c[0]);
		expect(urls).toContain('/items/people');
		expect(urls).not.toContain('/d1-people-admin/people');
		expect(urls).not.toContain('/d1-people-admin/attention');
	});
});
