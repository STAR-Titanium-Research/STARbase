// @vitest-environment happy-dom
// The Inbox page, behaviourally, against the fake d1-inbox: rows with what the crawler thinks and why, Link / Change / Dismiss, Accept all
// with its confirm and one Undo, the surface-scan row with its Link off, documents collapsed under Other files, Rescan and its 429 message.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, ref, type App } from 'vue';
import { RouterView, createMemoryHistory, createRouter, type Router } from 'vue-router';
import { setExplorerHostFactory, type HostApi } from '@d1/ui';
import { setPageFrame } from '../frame';
import InboxView from './InboxView.vue';
import { createFakeInbox, exactMatch, foundFile } from './fakeInboxServer';

const Button = defineComponent({
	props: { disabled: Boolean, loading: Boolean, title: String },
	emits: ['click'],
	setup: (p, { slots, emit }) => () => h('button', { type: 'button', disabled: p.disabled || p.loading, title: p.title, onClick: () => emit('click') }, slots.default?.()),
});
const Div = defineComponent({ setup: (_p, { slots }) => () => h('div', slots.default?.()) });
const Dialog = defineComponent({ props: { modelValue: Boolean }, setup: (p, { slots }) => () => (p.modelValue ? h('div', { role: 'dialog' }, slots.default?.()) : null) });
function registerStubs(app: App) {
	app.component('v-button', Button);
	app.component('v-icon', defineComponent({ setup: () => () => h('span') }));
	app.component('v-progress-circular', defineComponent({ setup: () => () => h('span') }));
	app.component('v-dialog', Dialog);
	for (const n of ['v-card', 'v-card-title', 'v-card-text', 'v-card-actions']) app.component(n, Div);
}

let app: App | null = null;
let router: Router;
let fake: ReturnType<typeof createFakeInbox>;

const SAMPLES = [{ sample_id: 's-picked', sample_code: 'S-0099', nickname: 'Chosen bar' }];

async function mount(files = defaultFiles(), now?: () => number) {
	fake = createFakeInbox({ files, now });
	const base = fake.api;
	// /items reads (the record picker) answer from a tiny table; everything else is the fake endpoint.
	const api: HostApi = { ...base, get: (path, config) => (path.startsWith('/items/') ? (Promise.resolve({ data: { data: SAMPLES } }) as any) : base.get(path, config)) };
	setExplorerHostFactory(() => ({
		api, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u-me' }),
	}));
	setPageFrame(defineComponent({ props: { title: String }, setup: (_p, { slots }) => () => h('div', [slots.default?.()]) }));
	router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/inbox', component: InboxView }] });
	await router.push('/inbox');
	app = createApp({ render: () => h('div', [h(RouterView)]) });
	app.use(router);
	registerStubs(app);
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	await vi.waitFor(() => expect(document.querySelector('[role="tablist"]')).not.toBeNull());
	await vi.waitFor(() => expect(document.querySelector('.d1-state')).toBeNull());
}

const defaultFiles = () => [
	exactMatch(),
	exactMatch({ rel_path: 'Users/ab1cd/sem/9ab3c4d5_B2.tif' }, '9ab3c4d5', 'S-0043'),
	foundFile({ rel_path: 'Users/ab1cd/misc/plain.tif' }),
	foundFile({ kind: 'surface_scan', rel_path: 'Users/ab1cd/scans/edge1.al3d' }),
	foundFile({ kind: 'document', rel_path: 'Users/ab1cd/notes.pdf' }),
	foundFile({ origin: 'backlog', rel_path: 'Users/ab1cd/old/old.tif' }),
];

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-test="inbox-row"]')];
const rowOf = (name: string) => rows().find((r) => r.textContent?.includes(name))!;
const click = (el: Element | null | undefined) => (el as HTMLElement).click();
const button = (root: ParentNode, label: RegExp) => [...root.querySelectorAll('button')].find((b) => label.test((b.textContent ?? '').trim()))!;
const text = () => document.body.textContent ?? '';
const settle = () => vi.waitFor(() => expect(document.querySelector('[data-test="rows"]')).not.toBeNull());

beforeEach(() => {
	document.body.innerHTML = '';
});
afterEach(() => {
	app?.unmount();
	app = null;
	setExplorerHostFactory(null);
});

describe('the Inbox page', () => {
	it('lists the pictures as rows with what the crawler thinks and why, and the documents collapsed under Other files', async () => {
		await mount();
		expect(rows().map((r) => r.querySelector('.name')?.textContent)).toEqual(['3fa9c1d2_A1.tif', '9ab3c4d5_B2.tif', 'plain.tif', 'edge1.al3d']);
		const first = rowOf('3fa9c1d2_A1.tif');
		expect(first.querySelector('[data-test="suggestion"]')?.textContent).toMatch(/Looks like\s+S-0042:\s+short ID `3fa9c1d2` in the file name/);
		expect(first.textContent).toContain('Possible SEM image');
		expect(first.textContent).toContain('Exact short ID');
		expect(rowOf('plain.tif').querySelector('[data-test="suggestion"]')).toBeNull();
		const other = document.querySelector('[data-test="other-files"]')!;
		expect(other.textContent).toContain('Other files');
		expect(other.textContent).not.toContain('notes.pdf');
		click(other.querySelector('[data-test="toggle-other"]'));
		await vi.waitFor(() => expect(text()).toContain('notes.pdf'));
		expect(other.textContent).toContain('Linking reads this file once to fingerprint it.');
	});

	it('a surface scan is found, but its Link is off and says why', async () => {
		await mount();
		const scan = rowOf('edge1.al3d');
		expect(button(scan, /^Link$/).disabled).toBe(true);
		expect(scan.querySelector('[data-test="scan-notice"]')?.textContent).toBe('Surface scans can be added soon');
		expect(scan.textContent).not.toMatch(/attach/i);
	});

	it('only picture rows get a thumbnail', async () => {
		await mount();
		expect(rowOf('3fa9c1d2_A1.tif').querySelector('img')?.getAttribute('src')).toMatch(/^.*\/assets\/f\d+-0000-4000-8000-000000000000\?/);
		expect(rowOf('edge1.al3d').querySelector('img')).toBeNull();
	});

	it('Link on a suggested file links it, the row goes, and Undo brings it back', async () => {
		await mount();
		click(button(rowOf('3fa9c1d2_A1.tif'), /^Link$/));
		await vi.waitFor(() => expect(rows().map((r) => r.querySelector('.name')?.textContent)).not.toContain('3fa9c1d2_A1.tif'));
		expect(document.querySelector('[data-test="notice"]')?.textContent).toContain('Linked 1 found file.');
		expect(fake.files[0].state).toBe('linked');
		click(document.querySelector('[data-test="undo"]'));
		await vi.waitFor(() => expect(rows().map((r) => r.querySelector('.name')?.textContent)).toContain('3fa9c1d2_A1.tif'));
		expect(fake.files[0].state).toBe('new');
	});

	it('Dismiss moves a file to Dismissed, where Restore puts it back', async () => {
		await mount();
		click(button(rowOf('plain.tif'), /^Dismiss$/));
		await vi.waitFor(() => expect(rows().map((r) => r.querySelector('.name')?.textContent)).not.toContain('plain.tif'));
		await router.replace({ path: '/inbox', query: { tab: 'dismissed' } });
		await vi.waitFor(() => expect(rows().map((r) => r.querySelector('.name')?.textContent)).toEqual(['plain.tif']));
		click(button(rowOf('plain.tif'), /^Restore$/));
		await vi.waitFor(() => expect(rows()).toHaveLength(0));
		expect(fake.files[2].state).toBe('new');
	});

	it('Accept all confirms with the count, links the exact matches in one batch, and one Undo reverses it', async () => {
		await mount();
		const accept = document.querySelector<HTMLButtonElement>('[data-test="accept-all"]')!;
		expect(accept.textContent?.trim()).toBe('Accept all (2)');
		click(accept);
		await vi.waitFor(() => expect(document.querySelector('[data-test="accept-confirm"]')).not.toBeNull());
		expect(document.querySelector('[data-test="accept-confirm"]')?.textContent).toContain('Link 2 found files to the record that each short ID names?');
		click(document.querySelector('[data-test="accept-confirm-button"]'));
		await vi.waitFor(() => expect(document.querySelector('[data-test="notice"]')?.textContent).toContain('Linked 2 found files.'));
		expect(fake.files.filter((f) => f.link_kind === 'bulk')).toHaveLength(2);
		click(document.querySelector('[data-test="undo"]'));
		await vi.waitFor(() => expect(fake.files.filter((f) => f.state === 'linked')).toHaveLength(0));
		await settle();
	});

	it('Change opens the record picker, a search finds records, and choosing one links the file to it', async () => {
		await mount();
		click(button(rowOf('3fa9c1d2_A1.tif'), /^Change$/));
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
		const input = document.querySelector<HTMLInputElement>('[data-test="link-search"]')!;
		input.value = 'S-0099';
		input.dispatchEvent(new Event('input'));
		await vi.waitFor(() => expect(document.body.textContent).toContain('Chosen bar'), { timeout: 2000 });
		click(document.querySelector('input[type="radio"][name="inbox-record"]:not(:checked)'));
		await vi.waitFor(() => expect(button(document.body, /^Link to S-0099$/)).toBeTruthy());
		click(button(document.body, /^Link to S-0099$/));
		await vi.waitFor(() => expect(fake.files[0].linked_record_id).toBe('s-picked'));
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
	});

	it('Rescan my folder queues once; asking again shows the rate-limit message', async () => {
		let t = 1_000_000;
		await mount(defaultFiles(), () => t);
		click(document.querySelector('[data-test="rescan"]'));
		await vi.waitFor(() => expect(document.querySelector('[data-test="notice"]')?.textContent).toContain('Rescan requested.'));
		t += 120_000;
		click(document.querySelector('[data-test="rescan"]'));
		await vi.waitFor(() => expect(document.querySelector('[data-test="notice"]')?.textContent).toContain('A scan of your folder is already queued or ran recently.'));
		expect(document.querySelector('[data-test="notice"]')?.textContent).toContain('Try again in 8 minutes.');
	});

	it('the Older files tab shows the backlog, and the tab and filters live in the URL', async () => {
		await mount();
		click(document.querySelector('[data-test="tab-older"]'));
		await vi.waitFor(() => expect(rows().map((r) => r.querySelector('.name')?.textContent)).toEqual(['old.tif']));
		expect(router.currentRoute.value.query).toEqual({ tab: 'older' });
		const kind = document.querySelector<HTMLSelectElement>('[data-test="filter-kind"]')!;
		kind.value = 'sem_image';
		kind.dispatchEvent(new Event('change'));
		await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ tab: 'older', kind: 'sem_image' }));
		await vi.waitFor(() => expect(text()).toContain('No older files match a record.'));
	});

	it('says an empty tab in words, never a blank page', async () => {
			await mount([]);
		await vi.waitFor(() => expect(document.querySelector('[data-test="empty"]')?.textContent).toContain('Nothing new.'));
	});
});
