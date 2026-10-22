// @vitest-environment happy-dom
// The scan progress, on screen: the "Scan progress" card on the Inbox page (the person's own folders; closed when everything is at 100%, open otherwise, left out
// when the person has no folder) and the "Folders" table of the Inbox crawler tab (every folder, largest first, with the login and the same bars).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, ref, type App } from 'vue';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { configureLinks, resetLinks, setExplorerHostFactory, starbaseLinks } from '@d1/ui';
import { setPageFrame } from '../frame';
import InboxCrawlerPanel from './InboxCrawlerPanel.vue';
import InboxView from './InboxView.vue';
import { createFakeInbox, foundFile, progressFolder, type FakeInboxOptions } from './fakeInboxServer';
import { FOLDERS_KNOWN_HELP } from './progressModel';

const Button = defineComponent({
	props: { disabled: Boolean, loading: Boolean },
	emits: ['click'],
	setup: (p, { slots, emit }) => () => h('button', { type: 'button', disabled: p.disabled || p.loading, onClick: () => emit('click') }, slots.default?.()),
});
const Span = defineComponent({ setup: (_p, { slots }) => () => h('span', slots.default?.()) });

let app: App | null = null;
let fake: ReturnType<typeof createFakeInbox>;

function host(api: ReturnType<typeof createFakeInbox>['api'], admin: boolean) {
	setExplorerHostFactory(() => ({
		api, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(admin), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u-me' }),
	}));
}
function register(a: App) {
	a.component('v-button', Button);
	for (const n of ['v-icon', 'v-progress-circular']) a.component(n, Span);
}

async function mountPage(opts: FakeInboxOptions = {}) {
	fake = createFakeInbox({ files: [foundFile()], ...opts });
	host(fake.api, false);
	configureLinks(starbaseLinks('https://d1.example'));
	setPageFrame(defineComponent({ props: { title: String }, setup: (_p, { slots }) => () => h('div', [slots.default?.()]) }));
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/inbox', component: InboxView }] });
	await router.push('/inbox');
	app = createApp({ render: () => h('div', [h(RouterView)]) });
	app.use(router);
	register(app);
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	await vi.waitFor(() => expect(document.querySelector('nav[aria-label="Inbox tabs"]')).not.toBeNull());
	await vi.waitFor(() => expect(fake.calls.some((c) => c.path === '/d1-inbox/progress')).toBe(true));
	await vi.waitFor(() => expect(document.querySelector('.d1-state')).toBeNull());
}

async function mountPanel(opts: FakeInboxOptions = {}) {
	fake = createFakeInbox(opts);
	host(fake.api, true);
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: Span }] });
	await router.push('/crawler?tab=inbox');
	app = createApp({ render: () => h(InboxCrawlerPanel) });
	app.use(router);
	register(app);
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	await vi.waitFor(() => expect(document.querySelector('[data-test="ic-daemon"]')).not.toBeNull());
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const pcts = (root: ParentNode) => [...root.querySelectorAll('[data-test="scan-pct"]')].map((e) => e.textContent);
const FINISHED = '2026-10-15T11:45:00.000Z';

beforeEach(() => {
	document.body.innerHTML = '';
});
afterEach(() => {
	app?.unmount();
	app = null;
	setExplorerHostFactory(null);
	resetLinks();
});

describe('the Scan progress card on the Inbox page', () => {
	it('is left out when the person has no folder', async () => {
		await mountPage({ progress: { folders: [], last_scan_finished_at: FINISHED } });
		expect(q('[data-test="scan-progress"]')).toBeNull();
		expect(document.body.textContent).not.toContain('Scan progress');
	});

	it('is left out when the server has no progress route (an older d1-inbox)', async () => {
		fake = createFakeInbox({ files: [foundFile()] });
		const api = { ...fake.api, get: (p: string, c?: any) => (p === '/d1-inbox/progress' ? Promise.reject(Object.assign(new Error('x'), { response: { status: 404, data: {} } })) : fake.api.get(p, c)) };
		host(api as any, false);
		setPageFrame(defineComponent({ props: { title: String }, setup: (_p, { slots }) => () => h('div', [slots.default?.()]) }));
		const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/inbox', component: InboxView }] });
		await router.push('/inbox');
		app = createApp({ render: () => h('div', [h(RouterView)]) });
		app.use(router);
		register(app);
		const el = document.createElement('div');
		document.body.appendChild(el);
		app.mount(el);
		await vi.waitFor(() => expect(document.querySelector('nav[aria-label="Inbox tabs"]')).not.toBeNull());
		await new Promise((r) => setTimeout(r, 20));
		expect(q('[data-test="scan-progress"]')).toBeNull();
	});

	it('is open when something is short: one row per folder, four labelled bars, the percentages, and when the scan finished', async () => {
		await mountPage({
			progress: {
				folders: [
					progressFolder({ images: 1000, images_read: 1000, images_with_thumb: 998, sem: 120, sem_with_scale: 120 }),
					progressFolder({ owner: { kind: 'team', id: 't1', name: 'SEM team', folder: 'SEM', root: 'Shared/SEM', has_login: null }, folders_known: 4, folders_listed: 2, images: 10, images_read: 3, images_with_thumb: 0, sem: 0, sem_with_scale: 0 }),
				],
				last_scan_finished_at: FINISHED,
			},
		});
		await vi.waitFor(() => expect(q('[data-test="scan-progress"]')).not.toBeNull());
		const folders = qa('[data-test="scan-folder"]');
		expect(folders).toHaveLength(2);
		expect(folders[0].textContent).toContain('My folder');
		expect(folders[0].textContent).toContain('Users/ab1cd');
		expect(folders[1].textContent).toContain('SEM team team folder');
		expect(folders[1].textContent).toContain('Shared/SEM');
		for (const label of ['Folders listed', 'Images read', 'Thumbnails', 'SEM images with a scale']) expect(folders[0].textContent).toContain(label);
		expect(pcts(folders[0])).toEqual(['100%', '100%', '99.8%', '100%']);
		expect(pcts(folders[1])).toEqual(['50%', '30%', '0%', '—']);
		expect(q('[data-test="scan-updated"]')?.textContent).toMatch(/^Updated .*2026/);
		expect(q('[data-test="scan-progress"]')?.textContent).toContain(FOLDERS_KNOWN_HELP);
	});

	it('is closed when every folder is at 100%, and opens on a click on its title', async () => {
		await mountPage({ progress: { folders: [progressFolder(), progressFolder({ owner: { id: 'p2', kind: 'team', name: 'Team', folder: 'T', root: 'Shared/T', has_login: null } })], last_scan_finished_at: FINISHED } });
		await vi.waitFor(() => expect(q('[data-test="scan-progress"]')).not.toBeNull());
		expect(q('[data-test="scan-progress"]')?.textContent).toContain('Scan progress');
		expect(q('[data-test="scan-updated"]')?.textContent).toMatch(/^Updated /);
		expect(qa('[data-test="scan-folder"]')).toHaveLength(0);
		q('[data-test="scan-progress"] header')?.click();
		await vi.waitFor(() => expect(qa('[data-test="scan-folder"]')).toHaveLength(2));
		expect(pcts(q('[data-test="scan-progress"]') as HTMLElement).every((p) => p === '100%')).toBe(true);
	});

	it('says a folder that has not been scanned yet is waiting, with dashes, and no scan finished yet', async () => {
		await mountPage({
			progress: { folders: [progressFolder({ folders_known: 0, folders_listed: 0, files: 0, images: 0, images_read: 0, images_with_thumb: 0, sem: 0, sem_with_scale: 0 })], last_scan_finished_at: null },
		});
		await vi.waitFor(() => expect(qa('[data-test="scan-folder"]')).toHaveLength(1));
		expect(q('[data-test="scan-folder"]')?.textContent).toContain('Not scanned yet');
		expect(pcts(q('[data-test="scan-folder"]') as HTMLElement)).toEqual(['—', '—', '—', '—']);
		expect(q('[data-test="scan-updated"]')?.textContent).toBe('No scan has finished yet');
	});

	it('colours by meaning: green at 100%, amber only below 50% once a scan has finished', async () => {
		await mountPage({ progress: { folders: [progressFolder({ images: 100, images_read: 40, images_with_thumb: 60, sem: 10, sem_with_scale: 10 })], last_scan_finished_at: FINISHED } });
		await vi.waitFor(() => expect(qa('[data-test="scan-bar"]')).toHaveLength(4));
		expect(qa('[data-test="scan-bar"]').map((b) => ['tone-ok', 'tone-warn', 'tone-neutral'].find((t) => b.classList.contains(t)))).toEqual(['tone-ok', 'tone-warn', 'tone-neutral', 'tone-ok']);
	});

	it('gives each bar the exact counts as its tooltip', async () => {
		await mountPage({ progress: { folders: [progressFolder({ images: 1000, images_read: 998 })], last_scan_finished_at: FINISHED } });
		await vi.waitFor(() => expect(qa('[data-test="scan-bar"]')).toHaveLength(4));
		expect(qa('[data-test="scan-bar"]')[1].getAttribute('title')).toBe('Images read: 998 of 1,000');
	});
});

describe('the Folders table of the Inbox crawler tab', () => {
	const ALL = {
		folders: [
			progressFolder({ files: 12, owner: { id: 'p2', name: 'Bo Chan', folder: 'bc2', root: 'Users/bc2', has_login: false }, folders_known: 2, folders_listed: 2, images: 8, images_read: 4, images_with_thumb: 8, sem: 0, sem_with_scale: 0 }),
			progressFolder({ files: 3400, owner: { id: 'p1', name: 'Ann Lee' } }),
			progressFolder({ files: 600, owner: { id: 't1', kind: 'team', name: 'SEM team', folder: 'SEM', root: 'Shared/SEM', has_login: null }, images_with_thumb: 270, images: 300 }),
		],
		last_scan_finished_at: FINISHED,
	};

	it('lists every folder, largest first, with the owner, the login, the files and the four percentages', async () => {
		await mountPanel({ progressAll: ALL });
		await vi.waitFor(() => expect(qa('[data-test="scan-folder-row"]')).toHaveLength(3));
		const rows = qa('[data-test="scan-folder-row"]');
		expect(rows.map((r) => r.querySelector('[data-test="scan-owner"]')?.textContent)).toEqual(['Ann Lee', 'SEM team', 'Bo Chan']);
		expect(rows.map((r) => r.querySelector('[data-test="scan-login"]')?.textContent)).toEqual(['login', 'team folder', 'no login']);
		expect(rows.map((r) => r.querySelector('[data-test="scan-files"]')?.textContent)).toEqual(['3,400', '600', '12']);
		expect(pcts(rows[0])).toEqual(['100%', '100%', '100%', '100%']);
		expect(pcts(rows[1])).toEqual(['100%', '100%', '90%', '100%']);
		expect(pcts(rows[2])).toEqual(['100%', '50%', '100%', '—']);
		expect(rows[2].textContent).toContain('bc2');
		expect(q('[data-test="ic-folders"]')?.textContent).toContain('Folders');
		expect(q('[data-test="ic-folders-help"]')?.textContent).toContain(FOLDERS_KNOWN_HELP);
	});

	it('asks for every folder (all=1), once at the start', async () => {
		await mountPanel({ progressAll: ALL });
		await vi.waitFor(() => expect(qa('[data-test="scan-folder-row"]')).toHaveLength(3));
		expect(fake.calls.filter((c) => c.path === '/d1-inbox/progress').map((c) => c.params)).toEqual([{ all: 1 }]);
	});

	it('says plainly when no folder has an alias or a share folder yet', async () => {
		await mountPanel({ progressAll: { folders: [], last_scan_finished_at: null } });
		await vi.waitFor(() => expect(q('[data-test="ic-folders"]')?.textContent).toContain('No folder has an alias or a share folder yet.'));
		expect(q('[data-test="scan-folders"]')).toBeNull();
	});

	it('shows the failure when the progress cannot be read, and the rest of the tab still works', async () => {
		fake = createFakeInbox();
		const api = { ...fake.api, get: (p: string, c?: any) => (p === '/d1-inbox/progress' ? Promise.reject(Object.assign(new Error('x'), { response: { status: 500, data: { errors: [{ message: 'The database is busy.' }] } } })) : fake.api.get(p, c)) };
		host(api as any, true);
		const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: Span }] });
		await router.push('/crawler?tab=inbox');
		app = createApp({ render: () => h(InboxCrawlerPanel) });
		app.use(router);
		register(app);
		const el = document.createElement('div');
		document.body.appendChild(el);
		app.mount(el);
		await vi.waitFor(() => expect(q('[data-test="ic-folders"]')?.textContent).toContain('The database is busy.'));
		expect(q('[data-test="ic-daemon"]')?.textContent).toBe('Online, running');
	});
});
