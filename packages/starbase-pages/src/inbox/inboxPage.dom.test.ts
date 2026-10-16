// @vitest-environment happy-dom
// The Inbox page, behaviourally, against the fake d1-inbox (d1-inbox's own shapes): rows with what the crawler thinks and why, Link / Change /
// Dismiss and where focus goes after them, Accept all with its dry-run confirm and one Undo, the surface-scan row with its Add a surface scan dialog,
// documents collapsed under Other files, Rescan and its 429 message, the tabs as links, and the one status region.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, ref, type App } from 'vue';
import { RouterView, createMemoryHistory, createRouter, type Router } from 'vue-router';
import { configureLinks, resetLinks, setExplorerHostFactory, starbaseLinks, type HostApi } from '@d1/ui';
import { setPageFrame } from '../frame';
import InboxView from './InboxView.vue';
import { createFakeInbox, exactMatch, foundFile, type FakeInboxOptions } from './fakeInboxServer';

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
const INSERTS = [{ insert_id: '00000000-0000-4000-8000-000000000201', insert_code: 'H13A-#2' }];
const EDGES = [{ edge_id: '00000000-0000-4000-8000-000000000202', edge_code: 'H13A-#2-fC', insert_id: { insert_code: 'H13A-#2' } }];
const OPERATIONS = [{ operation_id: '00000000-0000-4000-8000-000000000102', pass_code: 'P2', operation_sequence: 2, operation_date: '2026-10-12', process_category: 'turning', sample_id: { sample_code: 'S-0042' } }];
/** What each /items read answers (the dialogs search through /items as the signed-in user). */
const ITEMS: Record<string, unknown[]> = { cutting_inserts: INSERTS, insert_edges: EDGES, manufacturing_operations: OPERATIONS };
let itemReads: Array<{ path: string; params: any }> = [];

async function mount(files = defaultFiles(), opts: FakeInboxOptions = {}, url = '/inbox') {
	fake = createFakeInbox({ files, ...opts });
	const base = fake.api;
	// /items reads (the record picker) answer from a tiny table; everything else is the fake endpoint.
	itemReads = [];
	const api: HostApi = {
		...base,
		get: (path, config) => {
			if (!path.startsWith('/items/')) return base.get(path, config);
			itemReads.push({ path, params: config?.params });
			return Promise.resolve({ data: { data: ITEMS[path.slice('/items/'.length)] ?? SAMPLES } }) as any;
		},
	};
	setExplorerHostFactory(() => ({
		api, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u-me' }),
	}));
	configureLinks(starbaseLinks('https://d1.example'));
	setPageFrame(defineComponent({ props: { title: String }, setup: (_p, { slots }) => () => h('div', [slots.default?.()]) }));
	router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/inbox', component: InboxView }] });
	await router.push(url);
	app = createApp({ render: () => h('div', [h(RouterView)]) });
	app.use(router);
	registerStubs(app);
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	await vi.waitFor(() => expect(document.querySelector('nav[aria-label="Inbox tabs"]')).not.toBeNull());
	await vi.waitFor(() => expect(document.querySelector('.d1-state')).toBeNull());
}

const defaultFiles = () => [
	exactMatch(),
	exactMatch({ rel_path: 'Users/ab1cd/sem/9ab3c4d5_B2.tif' }, '9ab3c4d5', 'S-0043'),
	foundFile({ rel_path: 'Users/ab1cd/misc/plain.tif' }),
	exactMatch({ kind: 'surface_scan', rel_path: 'Users/ab1cd/scans/edge1.al3d' }, '77aa88bb', 'S-9'),
	foundFile({ kind: 'document', rel_path: 'Users/ab1cd/notes.pdf' }),
	foundFile({ origin: 'backlog', rel_path: 'Users/ab1cd/old/old.tif' }),
];

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-test="inbox-row"]')];
const names = () => rows().map((r) => r.querySelector('.name')?.textContent);
const rowOf = (name: string) => rows().find((r) => r.textContent?.includes(name))!;
const click = (el: Element | null | undefined) => (el as HTMLElement).click();
const button = (root: ParentNode, label: RegExp) => [...root.querySelectorAll('button')].find((b) => label.test((b.textContent ?? '').trim()))!;
const text = () => document.body.textContent ?? '';

beforeEach(() => {
	document.body.innerHTML = '';
});
afterEach(() => {
	app?.unmount();
	app = null;
	resetLinks();
	setExplorerHostFactory(null);
});

describe('the Inbox page', () => {
	it('opens the Home link to older exact matches with the Match filter set and the list asked for exactly those', async () => {
		const older = (o: Partial<Parameters<typeof foundFile>[0]>, token: string) => exactMatch({ origin: 'backlog', ...o }, token, 'S-1');
		await mount(
			[
				older({ rel_path: 'Users/ab1cd/old/aaaa1111_x.tif' }, 'aaaa1111'),
				older({ rel_path: 'Users/ab1cd/old/bbbb2222_x.tif', match_strength: 'code' }, 'bbbb2222'),
				foundFile({ origin: 'backlog', rel_path: 'Users/ab1cd/old/nothing.tif' }),
				older({ rel_path: 'Users/ab1cd/old/cccc3333_x.tif', match_strength: 'edge_code' }, 'cccc3333'),
			],
			{},
			'/inbox?tab=older&strength=short_id,code&owner=me',
		);
		expect(names()).toEqual(['aaaa1111_x.tif', 'bbbb2222_x.tif']);
		const select = document.querySelector<HTMLSelectElement>('[data-test="filter-strength"]')!;
		expect(select.value).toBe('short_id,code');
		expect(select.selectedOptions[0]?.textContent).toBe('Exact match');
		const asked = fake.calls.filter((c) => c.path === '/d1-inbox/files');
		expect(asked.length).toBeGreaterThan(0);
		for (const c of asked) expect(c.params).toMatchObject({ tab: 'older', strength: 'short_id,code', owner: 'me' });
		expect(router.currentRoute.value.query).toMatchObject({ tab: 'older', strength: 'short_id,code', owner: 'me' });
	});

	it('lists the pictures as rows with what the crawler thinks and why, and the documents collapsed under Other files', async () => {
		await mount();
		expect(names()).toEqual(['3fa9c1d2_A1.tif', '9ab3c4d5_B2.tif', 'plain.tif', 'edge1.al3d']);
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

	it('a surface scan has an enabled Add a surface scan button, is not called Link, and says what it does', async () => {
		await mount();
		const scan = rowOf('edge1.al3d');
		expect(button(scan, /^Add a surface scan$/).disabled).toBe(false);
		expect(scan.querySelector('[data-test="scan-notice"]')?.textContent).toBe('Added to an insert or an edge, with the condition you choose.');
		expect([...scan.querySelectorAll('button')].some((b) => /^Link$/.test((b.textContent ?? '').trim()))).toBe(false);
		expect([...scan.querySelectorAll('button')].some((b) => /^Change$/.test((b.textContent ?? '').trim()))).toBe(false);
		expect(scan.textContent).not.toMatch(/attach|soon/i);
	});

	it('a file without has_thumbnail draws no picture and asks for none: its row shows the icon of its kind (pictures: inboxPictures.dom.test.ts)', async () => {
		await mount();
		expect(document.querySelectorAll('img')).toHaveLength(0);
		expect(rowOf('3fa9c1d2_A1.tif').querySelector('.thumb')).not.toBeNull();
		expect(fake.pictureStats.requests).toBe(0);
	});

	it('Link on a suggested file links it, the row goes, focus moves to the next row, and Undo brings it back', async () => {
		await mount();
		click(button(rowOf('3fa9c1d2_A1.tif'), /^Link$/));
		await vi.waitFor(() => expect(names()).not.toContain('3fa9c1d2_A1.tif'));
		expect(document.querySelector('[data-test="notice"]')?.textContent).toContain('Linked 1 found file.');
		expect(fake.files[0].state).toBe('linked');
		// focus is on a button of the row that took its place, not lost
		expect(rowOf('9ab3c4d5_B2.tif').contains(document.activeElement)).toBe(true);
		click(document.querySelector('[data-test="undo"]'));
		await vi.waitFor(() => expect(names()).toContain('3fa9c1d2_A1.tif'));
		expect(fake.files[0].state).toBe('new');
	});

	it('when the last row goes, focus goes to the status line that says what happened', async () => {
		await mount([exactMatch()]);
		click(button(rowOf('3fa9c1d2_A1.tif'), /^Link$/));
		await vi.waitFor(() => expect(rows()).toHaveLength(0));
		expect(document.activeElement).toBe(document.querySelector('[data-test="status"]'));
	});

	it('has one status region, always in the page (live, polite), that holds each message', async () => {
		await mount();
		const region = document.querySelector('[data-test="status"]')!;
		expect(region.getAttribute('role')).toBe('status');
		expect(region.getAttribute('aria-live')).toBe('polite');
		expect(document.querySelectorAll('[role="status"], [role="alert"]').length).toBeGreaterThanOrEqual(1);
		expect(region.textContent).toBe('');
		click(document.querySelector('[data-test="rescan"]'));
		await vi.waitFor(() => expect(region.textContent).toContain('Rescan requested.'));
		// the same element all along, and its Close button is named by what it says
		expect(document.querySelector('[data-test="status"]')).toBe(region);
		const close = button(region, /^Close$/);
		expect(close.getAttribute('aria-label')).toBeNull();
		click(close);
		await vi.waitFor(() => expect(region.textContent).toBe(''));
	});

	it('a refused link says the endpoint\'s words in the status region, and the row stays', async () => {
		await mount(defaultFiles(), { editable: () => false });
		click(button(rowOf('3fa9c1d2_A1.tif'), /^Link$/));
		await vi.waitFor(() => expect(document.querySelector('[data-test="notice"]')?.textContent).toContain('You can only link a file to a record you can edit.'));
		expect(names()).toContain('3fa9c1d2_A1.tif');
	});

	it('Dismiss moves a file to Dismissed, where Restore puts it back', async () => {
		await mount();
		click(button(rowOf('plain.tif'), /^Dismiss$/));
		await vi.waitFor(() => expect(names()).not.toContain('plain.tif'));
		await router.replace({ path: '/inbox', query: { tab: 'dismissed' } });
		await vi.waitFor(() => expect(names()).toEqual(['plain.tif']));
		click(button(rowOf('plain.tif'), /^Restore$/));
		await vi.waitFor(() => expect(rows()).toHaveLength(0));
		expect(fake.files[2].state).toBe('new');
	});

	it('Accept all opens on a dry run: Confirm waits for it, the dialog names the count and where files go, and Confirm links exactly those', async () => {
		await mount();
		const accept = document.querySelector<HTMLButtonElement>('[data-test="accept-all"]')!;
		expect(accept.textContent?.trim()).toBe('Accept all');
		click(accept);
		await vi.waitFor(() => expect(document.querySelector('[data-test="accept-confirm"]')).not.toBeNull());
		const body = document.querySelector('[role="dialog"]')!.textContent!;
		expect(body).toContain('Link 2 found files to the record that each short ID names?');
		expect(document.querySelector('[data-test="accept-pairs"]')?.textContent).toContain('3fa9c1d2_A1.tif');
		expect(document.querySelector('[data-test="accept-pairs"]')?.textContent).toContain('S-0042');
		expect(document.querySelector('[data-test="accept-left"]')?.textContent).toContain('1 surface scan');
		expect(fake.files.every((f) => f.state === 'new')).toBe(true);
		click(document.querySelector('[data-test="accept-confirm-button"]'));
		await vi.waitFor(() => expect(document.querySelector('[data-test="notice"]')?.textContent).toContain('Linked 2 found files.'));
		expect(fake.files.filter((f) => f.link_kind === 'bulk')).toHaveLength(2);
		click(document.querySelector('[data-test="undo"]'));
		await vi.waitFor(() => expect(fake.files.filter((f) => f.state === 'linked')).toHaveLength(0));
	});

	it('Cancel on the Accept all confirm links nothing', async () => {
		await mount();
		click(document.querySelector('[data-test="accept-all"]'));
		await vi.waitFor(() => expect(document.querySelector('[data-test="accept-confirm"]')).not.toBeNull());
		click(button(document.querySelector('[role="dialog"]')!, /^Cancel$/));
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
		expect(fake.files.every((f) => f.state === 'new')).toBe(true);
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

	it('switching the kind of record in the picker clears the record chosen for the other kind', async () => {
		await mount();
		click(button(rowOf('3fa9c1d2_A1.tif'), /^Change$/));
		await vi.waitFor(() => expect(button(document.body, /^Link to S-0042$/)).toBeTruthy());
		click([...document.querySelectorAll('[role="radio"]')].find((b) => /^Test$/.test((b.textContent ?? '').trim())));
		await vi.waitFor(() => expect(button(document.querySelector('[role="dialog"]')!, /^Link$/).disabled).toBe(true));
	});

	it('Rescan my folder queues once; asking again shows the rate-limit message', async () => {
		let t = 1_000_000;
		await mount(defaultFiles(), { now: () => t });
		click(document.querySelector('[data-test="rescan"]'));
		await vi.waitFor(() => expect(document.querySelector('[data-test="notice"]')?.textContent).toContain('Rescan requested.'));
		t += 120_000;
		click(document.querySelector('[data-test="rescan"]'));
		await vi.waitFor(() => expect(document.querySelector('[data-test="notice"]')?.textContent).toContain('A scan of your folder is already queued or ran recently.'));
		expect(document.querySelector('[data-test="notice"]')?.textContent).toContain('Try again in 8 minutes.');
	});

	it('the tabs are links with aria-current, the tab and filters live in the URL, and a tab keeps the filters', async () => {
		await mount();
		const tabs = [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Inbox tabs"] a')];
		expect(tabs.map((a) => a.textContent?.replace(/\d+$/, ''))).toEqual(['New', 'Older files', 'Recently linked', 'Dismissed']);
		expect(tabs.map((a) => a.getAttribute('aria-current'))).toEqual(['page', null, null, null]);
		expect(document.querySelector('[role="tablist"], [role="tab"]')).toBeNull();
		click(document.querySelector('[data-test="tab-older"]'));
		await vi.waitFor(() => expect(names()).toEqual(['old.tif']));
		expect(router.currentRoute.value.query).toEqual({ tab: 'older' });
		expect(document.querySelector('[data-test="tab-older"]')?.getAttribute('aria-current')).toBe('page');
		const kind = document.querySelector<HTMLSelectElement>('[data-test="filter-kind"]')!;
		kind.value = 'sem_image';
		kind.dispatchEvent(new Event('change'));
		await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ tab: 'older', kind: 'sem_image' }));
		await vi.waitFor(() => expect(text()).toContain('No older files match a record.'));
		expect(document.querySelector<HTMLAnchorElement>('[data-test="tab-dismissed"]')!.getAttribute('href')).toContain('kind=sem_image');
	});

	it('says an empty tab in words, never a blank page', async () => {
		await mount([]);
		await vi.waitFor(() => expect(document.querySelector('[data-test="empty"]')?.textContent).toContain('Nothing new.'));
	});

	// ---- Add a surface scan ----

	const dialog = () => document.querySelector<HTMLElement>('[data-test="add-scan-dialog"]')!;
	const fill = async (input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
		input.value = value;
		input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
	};
	const openScanDialog = async (name = 'edge1.al3d') => {
		click(button(rowOf(name), /^Add a surface scan$/));
		await vi.waitFor(() => expect(dialog()).not.toBeNull());
	};
	const pickItem = async (code: string, text: string) => {
		await fill(dialog().querySelector<HTMLInputElement>('[data-test="scan-item-search"]')!, text);
		await vi.waitFor(() => expect(dialog().textContent).toContain(code), { timeout: 2000 });
		click(dialog().querySelector('input[type="radio"][name="scan-item"]'));
		await vi.waitFor(() => expect(button(dialog(), /^Add a surface scan to /)).toBeTruthy());
	};
	const confirm = () => dialog().querySelector<HTMLButtonElement>('[data-test="scan-confirm"]')!;
	const sentLinks = () => fake.calls.filter((c) => c.path === '/d1-inbox/link');

	it('the Add a surface scan dialog: the lab-wide warning, the four conditions with none chosen, and Confirm off until an item and a condition are set', async () => {
		await mount();
		await openScanDialog();
		const d = dialog();
		expect(d.getAttribute('aria-labelledby')).toBe('add-scan-title');
		expect(document.getElementById('add-scan-title')?.textContent).toBe('Add a surface scan: edge1.al3d');
		expect(d.querySelector('[data-test="visibility-warning"]')?.textContent).toContain('Adding a surface scan makes this file visible to every lab member');
		expect(d.querySelector('[data-test="scan-item-search"]')?.hasAttribute('autofocus')).toBe(true);
		const conditions = [...d.querySelectorAll<HTMLInputElement>('input[name="scan-condition"]')];
		expect(conditions.map((c) => c.parentElement?.textContent?.trim())).toEqual(['New', 'Worn', 'Cleaned', 'Other']);
		expect(conditions.some((c) => c.checked)).toBe(false);
		expect(d.querySelector('[role="radiogroup"][aria-required="true"]')).not.toBeNull();
		expect(confirm().disabled).toBe(true);
		// a condition alone is not enough: the item is still missing
		click(d.querySelector('[data-test="scan-condition-worn"]'));
		await vi.waitFor(() => expect(d.querySelector('[data-test="scan-problems"]')?.textContent).toContain('Choose the insert or edge'));
		expect(confirm().disabled).toBe(true);
		expect(sentLinks()).toHaveLength(0);
		expect(d.textContent).not.toMatch(/attach|\blink/i);
	});

	it('choose an insert and a condition, Confirm adds the scan: the row goes, the notice says where, and Undo brings the file back', async () => {
		await mount();
		await openScanDialog();
		await pickItem('H13A-#2', 'H13');
		expect(itemReads.find((r) => r.path === '/items/cutting_inserts')?.params.filter).toBe(JSON.stringify({ insert_code: { _icontains: 'H13' } }));
		click(dialog().querySelector('[data-test="scan-condition-worn"]'));
		await vi.waitFor(() => expect(confirm().disabled).toBe(false));
		expect(confirm().textContent).toBe('Add a surface scan to H13A-#2');
		click(confirm());
		await vi.waitFor(() => expect(names()).not.toContain('edge1.al3d'));
		expect(document.querySelector('[data-test="add-scan-dialog"]')).toBeNull();
		expect(sentLinks()[0].body).toEqual({ items: [{ candidate_id: fake.files[3].candidate_id, collection: 'surface_scans', insert_id: '00000000-0000-4000-8000-000000000201', condition: 'worn' }] });
		expect(document.querySelector('[data-test="notice"]')?.textContent).toContain('Added as a surface scan of H13A-#2. It is now visible to every lab member.');
		expect(fake.scans).toHaveLength(1);
		click(document.querySelector('[data-test="undo"]'));
		await vi.waitFor(() => expect(names()).toContain('edge1.al3d'));
		expect(fake.scans).toHaveLength(0);
		expect(fake.files[3].state).toBe('new');
	});

	it('an edge with an operation, a date, a condition note and notes: the operation is read for that edge, and all of it is sent', async () => {
		await mount();
		await openScanDialog();
		click([...dialog().querySelectorAll('[role="radio"]')].find((b) => /^Edge$/.test((b.textContent ?? '').trim())));
		await pickItem('H13A-#2-fC', 'fC');
		expect(dialog().textContent).toContain('Insert H13A-#2');
		await vi.waitFor(() => expect(itemReads.some((r) => r.path === '/items/manufacturing_operations')).toBe(true));
		expect(JSON.parse(itemReads.find((r) => r.path === '/items/manufacturing_operations')!.params.filter)).toEqual({ insert_edge_id: { _eq: '00000000-0000-4000-8000-000000000202' } });
		const op = dialog().querySelector<HTMLSelectElement>('[data-test="scan-operation"]')!;
		await vi.waitFor(() => expect(op.disabled).toBe(false));
		await fill(op, '00000000-0000-4000-8000-000000000102');
		await fill(dialog().querySelector<HTMLInputElement>('[data-test="scan-date"]')!, '2026-10-14');
		await fill(dialog().querySelector<HTMLTextAreaElement>('[data-test="scan-condition-note"]')!, ' ultrasonic bath ');
		await fill(dialog().querySelector<HTMLTextAreaElement>('[data-test="scan-notes"]')!, 'after pass 3');
		click(dialog().querySelector('[data-test="scan-condition-cleaned"]'));
		await vi.waitFor(() => expect(confirm().disabled).toBe(false));
		click(confirm());
		await vi.waitFor(() => expect(sentLinks()).toHaveLength(1));
		expect(sentLinks()[0].body).toEqual({
			items: [{ candidate_id: fake.files[3].candidate_id, collection: 'surface_scans', edge_id: '00000000-0000-4000-8000-000000000202', condition: 'cleaned', operation_id: '00000000-0000-4000-8000-000000000102', scanned_on: '2026-10-14', condition_note: 'ultrasonic bath', notes: 'after pass 3' }],
		});
		await vi.waitFor(() => expect(document.querySelector('[data-test="add-scan-dialog"]')).toBeNull());
	});

	it('switching between Insert and Edge clears the item chosen for the other', async () => {
		await mount();
		await openScanDialog();
		await pickItem('H13A-#2', 'H13');
		click([...dialog().querySelectorAll('[role="radio"]')].find((b) => /^Edge$/.test((b.textContent ?? '').trim())));
		await vi.waitFor(() => expect(button(dialog(), /^Add a surface scan$/)).toBeTruthy());
		expect(confirm().disabled).toBe(true);
	});

	it('"other" needs a note saying what the condition is (the Alicona dialog\'s rule)', async () => {
		await mount();
		await openScanDialog();
		await pickItem('H13A-#2', 'H13');
		click(dialog().querySelector('[data-test="scan-condition-other"]'));
		await vi.waitFor(() => expect(dialog().querySelector('[data-test="scan-problems"]')?.textContent).toContain('Say in the note what the condition is.'));
		expect(confirm().disabled).toBe(true);
		await fill(dialog().querySelector<HTMLTextAreaElement>('[data-test="scan-condition-note"]')!, 'chipped corner');
		await vi.waitFor(() => expect(confirm().disabled).toBe(false));
	});

	it('a file whose path names an edge starts with it chosen, and still has no condition', async () => {
		const edgeId = '00000000-0000-4000-8000-000000000202';
		await mount([foundFile({ kind: 'surface_scan', rel_path: 'Users/ab1cd/scans/H13A-2_fC.al3d', match_strength: 'edge_code', suggested_collection: 'insert_edges', suggested_record_id: edgeId, suggested_label: 'H13A-#2-fC' })]);
		await openScanDialog('H13A-2_fC.al3d');
		expect(button(dialog(), /^Add a surface scan to H13A-#2-fC$/)).toBeTruthy();
		expect(dialog().textContent).toContain("named in the file's path");
		expect([...dialog().querySelectorAll<HTMLInputElement>('input[name="scan-condition"]')].some((c) => c.checked)).toBe(false);
		expect(confirm().disabled).toBe(true);
	});

	it('a second click on Confirm while the first runs sends one request', async () => {
		await mount();
		await openScanDialog();
		await pickItem('H13A-#2', 'H13');
		click(dialog().querySelector('[data-test="scan-condition-worn"]'));
		await vi.waitFor(() => expect(confirm().disabled).toBe(false));
		click(confirm());
		click(confirm());
		await vi.waitFor(() => expect(names()).not.toContain('edge1.al3d'));
		expect(sentLinks()).toHaveLength(1);
		expect(fake.scans).toHaveLength(1);
	});

	it('a refusal shows in the dialog in the page\'s own words, keeps the dialog open and the row in the list', async () => {
		await mount(defaultFiles(), { scanAllowed: false });
		await openScanDialog();
		await pickItem('H13A-#2', 'H13');
		click(dialog().querySelector('[data-test="scan-condition-worn"]'));
		await vi.waitFor(() => expect(confirm().disabled).toBe(false));
		click(confirm());
		await vi.waitFor(() => expect(dialog().querySelector('[data-test="scan-error"]')?.textContent).toBe('You are not allowed to add surface scans.'));
		expect(dialog().querySelector('[data-test="scan-error"]')?.getAttribute('role')).toBe('alert');
		expect(names()).toContain('edge1.al3d');
		expect(fake.scans).toHaveLength(0);
	});

	it('a 400 that names a control marks it (an operation the endpoint does not read as an id)', async () => {
		OPERATIONS.push({ operation_id: 'not-an-id', pass_code: 'P9', operation_sequence: 9, operation_date: '2026-10-13', process_category: 'turning', sample_id: { sample_code: 'S-0042' } });
		try {
			await mount();
			await openScanDialog();
			await pickItem('H13A-#2', 'H13');
			const op = dialog().querySelector<HTMLSelectElement>('[data-test="scan-operation"]')!;
			await vi.waitFor(() => expect(op.disabled).toBe(false));
			await fill(op, 'not-an-id');
			click(dialog().querySelector('[data-test="scan-condition-worn"]'));
			await vi.waitFor(() => expect(confirm().disabled).toBe(false));
			click(confirm());
			await vi.waitFor(() => expect(dialog().querySelector('[data-test="scan-error"]')?.textContent).toBe('That operation is not valid. Choose another operation, or none.'));
			expect(op.getAttribute('aria-invalid')).toBe('true');
			expect(dialog().querySelector('[data-test="scan-notes"]')?.getAttribute('aria-invalid')).toBeNull();
		} finally {
			OPERATIONS.pop();
		}
	});

	it('Recently linked says "Added as a surface scan of <label>" with a route to the edge, under a batch that says so, and the batch Undo works', async () => {
		const edgeId = '00000000-0000-4000-8000-000000000202';
		await mount(defaultFiles(), { scanItems: { edges: { [edgeId]: 'H13A-#2-fC' } } });
		await openScanDialog();
		click([...dialog().querySelectorAll('[role="radio"]')].find((b) => /^Edge$/.test((b.textContent ?? '').trim())));
		await pickItem('H13A-#2-fC', 'fC');
		click(dialog().querySelector('[data-test="scan-condition-worn"]'));
		await vi.waitFor(() => expect(confirm().disabled).toBe(false));
		click(confirm());
		await vi.waitFor(() => expect(names()).not.toContain('edge1.al3d'));
		await router.replace({ path: '/inbox', query: { tab: 'linked' } });
		await vi.waitFor(() => expect(names()).toEqual(['edge1.al3d']));
		const row = rowOf('edge1.al3d');
		expect(row.querySelector('[data-test="linked-to"]')?.textContent?.replace(/\s+/g, ' ').trim()).toMatch(/^Added as a surface scan of H13A-#2-fC \(worn\) on /);
		expect(row.querySelector('[data-test="linked-to"] a')?.getAttribute('href')).toContain(`/edges/${edgeId}`);
		expect(row.textContent).not.toMatch(/attach|Linked by you/);
		expect(document.querySelector('[data-test="batch"]')?.textContent).toContain('Added as a surface scan, 1 file');
		click(document.querySelector('[data-test="undo-batch"]'));
		await vi.waitFor(() => expect(fake.files[3].state).toBe('new'));
		expect(fake.scans).toHaveLength(0);
	});

	it('an Undo the person may no longer do shows the endpoint\'s words verbatim', async () => {
		await mount(defaultFiles(), { scanUndoAllowed: false });
		await openScanDialog();
		await pickItem('H13A-#2', 'H13');
		click(dialog().querySelector('[data-test="scan-condition-worn"]'));
		await vi.waitFor(() => expect(confirm().disabled).toBe(false));
		click(confirm());
		await vi.waitFor(() => expect(document.querySelector('[data-test="undo"]')).not.toBeNull());
		click(document.querySelector('[data-test="undo"]'));
		await vi.waitFor(() => expect(document.querySelector('[data-test="notice"]')?.textContent).toContain('You can no longer delete that surface scan, so adding it cannot be undone.'));
		expect(fake.scans).toHaveLength(1);
	});
});
