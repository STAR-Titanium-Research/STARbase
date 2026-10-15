// @vitest-environment happy-dom
// The person panel's sheet, behaviourally: mounted in a DOM, in a narrow viewport. (panelSheet.test.ts has the pure helpers.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { RouterView, createMemoryHistory, createRouter, type Router } from 'vue-router';
import { setExplorerHostFactory } from '@d1/ui';
import { setPageFrame } from '../frame';
import PeopleView from './PeopleView.vue';
import PersonPanel from './PersonPanel.vue';
import type { PeopleRow } from './peopleQuery';

const ANN = 'p-ann';
const BOB = 'p-bob';
const person = (id: string, name: string): any => ({
	person_id: id, full_name: name, email: `${id}@lab.example`, is_researcher: true, is_operator: false, active: true, notes: null, user_id: `u-${id}`,
	login: { status: 'active', role_id: 'r1', role_name: 'Lab Member', last_access: null, email: null }, attention: [], teams: [],
});

function fakeApi() {
	return {
		get: vi.fn(async (url: string) => {
			if (url === '/d1-people-admin/people') {
				return { data: { can_administer_accounts: true, roles: [{ id: 'r1', name: 'Lab Member' }], people: [person(ANN, 'Ann Member'), person(BOB, 'Bob Member')], logins_without_person: [] } };
			}
			if (url === '/d1-people-admin/attention') return { data: { items: [] } };
			if (url.startsWith('/d1-people-admin/people/')) return { data: { owns: 0, shared: 0, investigator: 0, teams: 0, waiting: 0, waiting_owners: 0 } };
			if (url === '/d1-teams') return { data: { teams: [] } };
			return { data: { data: [] } };
		}),
		post: vi.fn(),
		patch: vi.fn(),
		delete: vi.fn(),
	};
}

// The stand-ins for the host's v-* components: the real ones are the host's. Dialogs draw nothing while closed.
const Plain = (tag: string) => defineComponent({ inheritAttrs: true, setup: (_p, { slots }) => () => h(tag, slots.default?.()) });
const Nothing = defineComponent({ setup: () => () => null });
function registerStubs(app: App) {
	for (const n of ['v-button', 'v-icon', 'v-input', 'v-notice', 'v-progress-circular']) app.component(n, Plain('span'));
	app.component('v-select', Plain('select'));
	for (const n of ['v-dialog', 'v-card', 'v-card-title', 'v-card-text', 'v-card-actions', 'v-checkbox', 'v-textarea']) app.component(n, Nothing);
}

let app: App | null = null;
let host: HTMLElement;
let router: Router;

function narrow(isNarrow: boolean) {
	window.matchMedia = ((q: string) => ({ matches: q.includes('min-width: 1000px') ? !isNarrow : false, addEventListener() {}, removeEventListener() {} })) as any;
}

async function mountPage() {
	const api = fakeApi();
	setExplorerHostFactory(() => ({
		api: api as any, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(true), adminKnown: ref(true), canViewAllAccess: ref(false),
		user: ref({ id: 'u-me' }),
	}));
	setPageFrame(defineComponent({ props: { title: String }, setup: (_p, { slots }) => () => h('div', [slots.default?.()]) }));
	router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/people', component: PeopleView }] });
	await router.push('/people');
	app = createApp({ render: () => h('div', [h(RouterView)]) });
	app.use(router);
	registerStubs(app);
	host = document.createElement('div');
	document.body.appendChild(host);
	app.mount(host);
	await vi.waitFor(() => expect(document.querySelectorAll('.prow').length).toBe(2));
}

const row = (id: string) => document.querySelector<HTMLElement>(`.prow[data-key="${id}"]`)!;
const flush = async () => { await nextTick(); await new Promise((r) => setTimeout(r, 0)); await nextTick(); };
const esc = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

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

describe('the person panel as a sheet (narrow viewport)', () => {
	it('opens as a modal dialog over an inert page, with focus in the sheet', async () => {
		narrow(true);
		await mountPage();
		expect(document.querySelector('.behind')!.hasAttribute('inert')).toBe(false);
		row(ANN).click();
		await vi.waitFor(() => expect(document.querySelector('.sheet-backdrop')).not.toBeNull());
		await flush();
		const sheet = document.querySelector<HTMLElement>('.panel-slot.sheet')!;
		expect(sheet.getAttribute('role')).toBe('dialog');
		expect(sheet.getAttribute('aria-modal')).toBe('true');
		expect(sheet.parentElement!.parentElement).toBe(document.body); // teleported out of the page
		expect(document.querySelector('.behind')!.hasAttribute('inert')).toBe(true);
		expect(document.querySelector('.behind[inert]')).not.toBeNull();
		expect(sheet.contains(document.activeElement)).toBe(true);
	});

	it('Esc closes it: the page is no longer inert and focus is back on the row', async () => {
		narrow(true);
		await mountPage();
		row(ANN).click();
		await vi.waitFor(() => expect(document.querySelector('.sheet-backdrop')).not.toBeNull());
		await flush();
		esc();
		await vi.waitFor(() => expect(document.querySelector('.sheet-backdrop')).toBeNull());
		await vi.waitFor(() => expect(document.querySelector('.behind[inert]')).toBeNull());
		await vi.waitFor(() => expect(document.activeElement).toBe(row(ANN)));
	});

	it('a tap on the backdrop closes it, a press that started inside the sheet does not', async () => {
		narrow(true);
		await mountPage();
		row(BOB).click();
		await vi.waitFor(() => expect(document.querySelector('.sheet-backdrop')).not.toBeNull());
		const backdrop = document.querySelector<HTMLElement>('.sheet-backdrop')!;
		const sheet = document.querySelector<HTMLElement>('.panel-slot.sheet')!;
		sheet.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush();
		expect(document.querySelector('.sheet-backdrop')).not.toBeNull();
		backdrop.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await vi.waitFor(() => expect(document.querySelector('.sheet-backdrop')).toBeNull());
		await vi.waitFor(() => expect(document.activeElement).toBe(row(BOB)));
	});

	it('when the person goes away some other way (the URL), focus still goes back to their row', async () => {
		narrow(true);
		await mountPage();
		row(ANN).click();
		await vi.waitFor(() => expect(document.querySelector('.sheet-backdrop')).not.toBeNull());
		await flush();
		await router.replace('/people'); // Back, or the stale-person watcher: closePanel is not called
		await vi.waitFor(() => expect(document.querySelector('.sheet-backdrop')).toBeNull());
		await vi.waitFor(() => expect(document.activeElement).toBe(row(ANN)));
	});
});

describe('the person panel beside the list (wide viewport)', () => {
	it('is not a sheet: no backdrop, no inert page, no dialog role', async () => {
		narrow(false);
		await mountPage();
		row(ANN).click();
		await vi.waitFor(() => expect(document.querySelector('.panel-slot')).not.toBeNull());
		expect(document.querySelector('.sheet-backdrop')).toBeNull();
		expect(document.querySelector('.behind[inert]')).toBeNull();
		expect(document.querySelector('.panel-slot')!.getAttribute('role')).toBeNull();
	});
});

describe('PersonPanel and Esc', () => {
	async function mountPanel(wrapper: (inner: () => any) => any) {
		const api = fakeApi();
		setExplorerHostFactory(() => ({
			api: api as any, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(true), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u-me' }),
		}));
		const closed = vi.fn();
		const rows: PeopleRow[] = [{ ...person(ANN, 'Ann Member'), kind: 'person' }];
		const inner = () => h(PersonPanel, { personId: ANN, rows, canAdministerAccounts: true, roles: [], onClose: closed });
		app = createApp({ render: () => wrapper(inner) });
		registerStubs(app);
		host = document.createElement('div');
		document.body.appendChild(host);
		app.mount(host);
		await flush();
		return closed;
	}

	it('still closes on Esc when its own ancestor is the aria-modal sheet', async () => {
		const closed = await mountPanel((inner) => h('div', { 'aria-modal': 'true', role: 'dialog' }, [inner()]));
		esc();
		expect(closed).toHaveBeenCalledTimes(1);
	});

	it('does not close on Esc while some other aria-modal dialog is open', async () => {
		const closed = await mountPanel((inner) => h('div', [inner(), h('div', { 'aria-modal': 'true', role: 'dialog' })]));
		esc();
		expect(closed).not.toHaveBeenCalled();
	});
});
