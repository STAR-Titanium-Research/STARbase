// @vitest-environment happy-dom
// The Teams view and a team's page for a Lab Viewer (migration 185), behaviourally: everything is shown, and nothing that changes anything is
// offered, not even to a viewer who manages the team or is in it. The same pages for a manager are the control.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, ref, type App } from 'vue';
import { EXPLORER_HOST, setExplorerHostFactory, type ExplorerHost } from '@d1/ui';
import { setPageFrame } from '../frame';
import TeamPage from './TeamPage.vue';
import TeamsView from './TeamsView.vue';

const TEAM = {
	team_id: 't1', name: 'Additive', description: 'Powder people', color: 'teal', logo: null, member_count: 2,
	managers: [{ person_id: 'p-me', full_name: 'Me Myself' }], is_member: true, is_manager: true,
};

function fakeApi() {
	return {
		get: vi.fn(async (url: string) => {
			if (url === '/d1-teams') return { data: { teams: [TEAM] } };
			if (url === '/d1-teams/t1') {
				return {
					data: {
						team: TEAM,
						members: [
							{ person_id: 'p-me', full_name: 'Me Myself', can_sign_in: true, is_manager: true, joined_at: null },
							{ person_id: 'p-bob', full_name: 'Bob Member', can_sign_in: true, is_manager: false, joined_at: null },
						],
						counts: { view: 1, edit: 0, investigator: 0, owns: 0 },
						records: [{ collection: 'physical_samples', id: 's1', kind: 'sample', code: 'SM-001', title: 'Bar A', role: 'view' }],
						hidden_count: 0,
						events: [],
					},
				};
			}
			if (url === '/items/people') return { data: { data: [{ person_id: 'p-me' }] } };
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
	// the kit's own components that read the host and the router are not under test here
	app.component('AppLink', Plain('a'));
}

let app: App | null = null;
let api: ReturnType<typeof fakeApi>;

function mountPage(component: any, props: Record<string, unknown>, who: { isAdmin: boolean; viewer: boolean }) {
	api = fakeApi();
	const host: ExplorerHost = {
		api: api as any, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(who.isAdmin), adminKnown: ref(true),
		canViewAllAccess: ref(who.viewer), user: ref({ id: 'u-me', role: who.viewer ? 'r3' : 'r1' }),
	};
	setExplorerHostFactory(() => host);
	setPageFrame(defineComponent({ props: { title: String }, setup: (_p, { slots }) => () => h('div', [slots.default?.()]) }));
	app = createApp({ render: () => h(component, props) });
	app.provide(EXPLORER_HOST, host); // the team card (hover members) asks ExplorerView's provide
	registerStubs(app);
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
}

const buttons = (label: RegExp) => [...document.querySelectorAll('button, span')].filter((b) => label.test((b.textContent ?? '').trim()) && b.children.length <= 1);
const has = (label: RegExp) => buttons(label).length > 0;

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

describe('a team page for a Lab Viewer', () => {
	it('shows the members, the records and the counts, and offers nothing that changes the team, even to a viewer who manages it and is in it', async () => {
		mountPage(TeamPage, { id: 't1' }, { isAdmin: false, viewer: true });
		await vi.waitFor(() => expect(document.body.textContent).toContain('Bob Member'));
		await vi.waitFor(() => expect(api.get.mock.calls.map((c) => c[0])).toContain('/items/people')); // the page found out which member is the viewer
		expect(document.body.textContent).toContain('SM-001');
		expect(document.body.textContent).toContain('Powder people');
		for (const label of [/^Edit$/, /^Delete$/, /Add member/, /^Make manager$/, /^Remove manager$/, /^Remove$/, /^Leave$/]) expect(has(label), String(label)).toBe(false);
		expect(api.patch).not.toHaveBeenCalled();
		expect(api.post).not.toHaveBeenCalled();
		expect(api.delete).not.toHaveBeenCalled();
	});

	it('the same page for the team manager has them (so the checks above bite)', async () => {
		mountPage(TeamPage, { id: 't1' }, { isAdmin: false, viewer: false });
		await vi.waitFor(() => expect(document.body.textContent).toContain('Bob Member'));
		await vi.waitFor(() => expect(has(/^Leave$/)).toBe(true));
		for (const label of [/^Edit$/, /^Delete$/, /Add member/, /^Remove manager$|^Make manager$/, /^Remove$/]) expect(has(label), String(label)).toBe(true);
	});
});

describe('the Teams view for a Lab Viewer', () => {
	it('lists the teams and has no New team', async () => {
		mountPage(TeamsView, {}, { isAdmin: false, viewer: true });
		await vi.waitFor(() => expect(document.body.textContent).toContain('Additive'));
		expect(has(/New team/)).toBe(false);
	});
	it('a member still has New team', async () => {
		mountPage(TeamsView, {}, { isAdmin: false, viewer: false });
		await vi.waitFor(() => expect(document.body.textContent).toContain('Additive'));
		expect(has(/New team/)).toBe(true);
	});
});
