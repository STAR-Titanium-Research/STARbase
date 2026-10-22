// @vitest-environment happy-dom
// A linked file in the sheet and on the view box page, against the fake d1-inbox: the Link card between the picture and the facts (sheet) or under the actions
// (page), Open / Undo link / Change…, the strip of the other pictures on the same record with its "+N", opening one in place or in its own page (also when the list
// does not hold it), "Compare with…" starting Compare with a sibling the page's filters do not list, and nothing for a file that is not linked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, ref, type App } from 'vue';
import { RouterView, createMemoryHistory, createRouter, type Router } from 'vue-router';
import { configureLinks, resetLinks, setExplorerHostFactory, starbaseLinks } from '@d1/ui';
import { setPageFrame } from '../frame';
import InboxFilePage from './InboxFilePage.vue';
import InboxView from './InboxView.vue';
import { createFakeInbox, exactMatch, type FakeInboxOptions } from './fakeInboxServer';
import type { FoundFile } from './inboxApi';

const Button = defineComponent({
	props: { disabled: Boolean, loading: Boolean },
	emits: ['click'],
	setup: (p, { slots, emit, attrs }) => () => h('button', { type: 'button', ...attrs, disabled: p.disabled || p.loading, onClick: () => emit('click') }, slots.default?.()),
});
const Div = defineComponent({ setup: (_p, { slots }) => () => h('div', slots.default?.()) });
function registerStubs(app: App) {
	app.component('v-button', Button);
	app.component('v-icon', defineComponent({ props: { name: String }, setup: (p) => () => h('span', { class: 'icon', 'data-icon': p.name }) }));
	app.component('v-progress-circular', defineComponent({ setup: () => () => h('span') }));
	app.component('v-dialog', defineComponent({ props: { modelValue: Boolean }, setup: (p, { slots }) => () => (p.modelValue ? h('div', { role: 'dialog' }, slots.default?.()) : null) }));
	for (const n of ['v-card', 'v-card-title', 'v-card-text', 'v-card-actions']) app.component(n, Div);
}

let app: App | null = null;
let fake: ReturnType<typeof createFakeInbox>;
let router: Router;
const Blank = defineComponent({ render: () => h('div', { 'data-test': 'blank-page' }) });

async function mount(files: FoundFile[], at: string, opts: FakeInboxOptions = {}) {
	fake = createFakeInbox({ files, ...opts });
	setExplorerHostFactory(() => ({
		api: fake.api, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u-me' }),
	}));
	configureLinks(starbaseLinks('https://d1.example'));
	setPageFrame(defineComponent({ props: { title: String }, setup: (_p, { slots }) => () => h('div', [slots.default?.()]) }));
	router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: '/inbox', component: InboxView },
			{ path: '/inbox/file/:candidateId', component: InboxFilePage, props: true },
			{ path: '/samples/:id', component: Blank },
		],
	});
	await router.push(at);
	app = createApp({ render: () => h('div', [h(RouterView)]) });
	app.use(router);
	registerStubs(app);
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
}

const SEM = { kv: 15, pixel_size_nm: 100, image_width_px: 1000, sources: { kv: 'metadata', pixel_size_nm: 'metadata' }, flags: {} };
const RECORD = 'a3fa9c1d2-0000-4000-8000-000000000000'.slice(0, 36);
const OTHER_RECORD = 'a77777777-0000-4000-8000-000000000000'.slice(0, 36);
/** A picture linked to the sample S-0042 (batch of one, by Alice), under `folder`. */
const linkedPic = (name: string, over: Partial<FoundFile> = {}, folder = 'sem'): FoundFile =>
	exactMatch(
		{
			rel_path: `Users/ab1cd/${folder}/${name}`, has_thumbnail: true, extracted: SEM, state: 'linked', link_kind: 'manual', link_batch_id: `batch-${name}`,
			linked_collection: 'physical_samples', linked_record_id: RECORD, linked_label: 'S-0042', linked_title: 'Ti-6Al-4V fatigue bar', decided_at: '2026-10-22T14:05:00.000Z',
			decided_by_name: 'Alice A', ...over,
		},
		name.slice(0, 8),
	);

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const all = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const click = (sel: string) => q<HTMLButtonElement>(sel)!.click();
const text = (sel: string) => q(sel)?.textContent ?? null;
const tiles = () => all('[data-test="sibling"]');
const tileFor = (id: string) => q<HTMLButtonElement>(`[data-sibling-id="${id}"]`)!;
const squash = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();

/** The record picker answers one sample (the dialog searches through /items as the signed-in user); everything else is the fake endpoint. */
function answerItems(): void {
	const get = fake.api.get.bind(fake.api);
	fake.api.get = ((path: string, config?: any) =>
		path.startsWith('/items/') ? Promise.resolve({ data: { data: [{ sample_id: 's-picked', sample_code: 'S-0099', nickname: 'Chosen bar' }] } }) : get(path, config)) as typeof fake.api.get;
}
const linkButton = () => all('[role="dialog"] button').find((b) => /^Link to S-0099/.test(b.textContent ?? ''));
/** Types in the dialog's search, picks the one result and presses its Link button. */
async function chooseRecord(): Promise<void> {
	await vi.waitFor(() => expect(q('[role="dialog"]')).not.toBeNull());
	const input = q<HTMLInputElement>('[data-test="link-search"]')!;
	input.value = 'S-0099';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	const radio = () => all<HTMLInputElement>('input[name="inbox-record"]').find((i) => i.closest('label')?.textContent?.includes('S-0099'));
	await vi.waitFor(() => expect(radio()).toBeTruthy(), { timeout: 2000 });
	radio()!.click();
	await vi.waitFor(() => expect(linkButton(), q('[role="dialog"]')?.textContent ?? 'no dialog').toBeTruthy());
	linkButton()!.click();
}

beforeEach(() => {
	document.body.innerHTML = '';
	window.localStorage.clear();
});
afterEach(() => {
	app?.unmount();
	app = null;
	resetLinks();
	setExplorerHostFactory(null);
	vi.restoreAllMocks();
	window.localStorage.clear();
});

describe('the sheet of a linked file', () => {
	const open = async (files: FoundFile[], which: string, at = '/inbox?tab=linked') => {
		await mount(files, at);
		await vi.waitFor(() => expect(all('[data-test="inbox-row"]').length).toBeGreaterThan(0));
		const row = all('[data-test="inbox-row"]').find((r) => r.textContent?.includes(which))!;
		row.querySelector<HTMLButtonElement>('button[data-test="thumb"]')!.click();
		await vi.waitFor(() => expect(q('[data-test="inbox-sheet"]')).not.toBeNull());
	};

	it('shows the Link card between the picture and the facts, with the record, its title, who and when', async () => {
		const a = linkedPic('aaaa1111_A.tif');
		await open([a, linkedPic('bbbb2222_B.tif')], 'aaaa1111_A.tif');
		const sheet = q('[data-test="inbox-sheet"]')!;
		const order = [...sheet.children].map((c) => c.getAttribute('data-test') ?? c.className);
		expect(order.indexOf('link-card')).toBeGreaterThan(order.indexOf('sheet-stage'));
		expect(sheet.querySelector('[data-field="kv"]')!.compareDocumentPosition(sheet.querySelector('[data-test="link-card"]')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
		expect(squash(text('[data-test="link-head"]'))).toBe('Linked to S-0042');
		expect(text('[data-test="link-meta"]')).toBe('Ti-6Al-4V fatigue bar · by Alice A · manually · 22 Oct 2026');
		expect(q('[data-test="link-open"]')!.textContent).toBe('Open sample');
	});

	it('shows nothing of the kind for a file that is not linked', async () => {
		await mount([exactMatch({ rel_path: 'Users/ab1cd/sem/3fa9c1d2_A1.tif', has_thumbnail: true, extracted: SEM })], '/inbox');
		await vi.waitFor(() => expect(all('[data-test="inbox-row"]')).toHaveLength(1));
		q<HTMLButtonElement>('button[data-test="thumb"]')!.click();
		await vi.waitFor(() => expect(q('[data-test="inbox-sheet"]')).not.toBeNull());
		expect(q('[data-test="link-card"]')).toBeNull();
		expect(q('[data-test="siblings"]')).toBeNull();
		expect(fake.calls.some((c) => c.path === '/d1-inbox/siblings')).toBe(false);
	});

	it('Open sample goes to the sample\'s page', async () => {
		await open([linkedPic('aaaa1111_A.tif')], 'aaaa1111_A.tif');
		click('[data-test="link-open"]');
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`/samples/${RECORD}`));
	});

	it('draws the other pictures of the record (not itself, not another record\'s) with the count, and "+N" past six', async () => {
		const self = linkedPic('aaaa1111_A.tif');
		const sibs = Array.from({ length: 8 }, (_, i) => linkedPic(`bbbb000${i}_B.tif`));
		const elsewhere = linkedPic('cccc3333_C.tif', { linked_record_id: OTHER_RECORD, linked_label: 'S-0099' });
		await open([self, ...sibs, elsewhere], 'aaaa1111_A.tif');
		await vi.waitFor(() => expect(tiles()).toHaveLength(6));
		expect(squash(text('[data-test="siblings-head"]'))).toBe('Linked to S-0042 · 9 images');
		expect(text('[data-test="siblings-more"]')).toBe('+2');
		expect(tiles().some((t) => t.dataset.siblingId === self.candidate_id || t.dataset.siblingId === elsewhere.candidate_id)).toBe(false);
		expect(fake.calls.find((c) => c.path === '/d1-inbox/siblings')?.params).toMatchObject({ file: self.candidate_id, limit: 6 });
	});

	it('a picture the list holds opens in the sheet, in place', async () => {
		const self = linkedPic('aaaa1111_A.tif');
		const other = linkedPic('bbbb2222_B.tif');
		await open([self, other], 'aaaa1111_A.tif');
		await vi.waitFor(() => expect(tiles()).toHaveLength(1));
		tileFor(other.candidate_id).click();
		await vi.waitFor(() => expect(text('[data-test="sheet-name"]')).toBe('bbbb2222_B.tif'));
		expect(router.currentRoute.value.path).toBe('/inbox');
	});

	it('a picture the list does not hold (past its first page) opens in its own page, found under Recently linked', async () => {
		const self = linkedPic('aaaa1111_A.tif');
		const filler = Array.from({ length: 52 }, (_, i) => linkedPic(`fill${String(i).padStart(4, '0')}_F.tif`, { linked_record_id: OTHER_RECORD, linked_label: 'S-0099' }));
		const far = linkedPic('zzzz9999_Z.tif');
		await open([self, ...filler, far], 'aaaa1111_A.tif');
		await vi.waitFor(() => expect(tiles()).toHaveLength(1));
		expect(all('[data-test="inbox-row"]').some((r) => r.textContent?.includes('zzzz9999_Z.tif'))).toBe(false);
		tileFor(far.candidate_id).click();
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`/inbox/file/${far.candidate_id}`));
		expect(router.currentRoute.value.query).toEqual({ tab: 'linked' });
	});

	it('"Compare with…" then a picture opens the page with that picture beside this one', async () => {
		const self = linkedPic('aaaa1111_A.tif');
		const other = linkedPic('bbbb2222_B.tif');
		await open([self, other], 'aaaa1111_A.tif');
		await vi.waitFor(() => expect(tiles()).toHaveLength(1));
		click('[data-test="siblings-compare"]');
		tileFor(other.candidate_id).click();
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`/inbox/file/${self.candidate_id}`));
		expect(router.currentRoute.value.query).toEqual({ tab: 'linked', with: other.candidate_id });
	});

	it('Undo link asks first, undoes the batch, and the file leaves Recently linked', async () => {
		const self = linkedPic('aaaa1111_A.tif');
		const other = linkedPic('bbbb2222_B.tif');
		const batch = self.link_batch_id;
		await open([self, other], 'aaaa1111_A.tif');
		click('[data-test="link-undo"]');
		await vi.waitFor(() => expect(q('[data-test="link-confirm"]')).not.toBeNull());
		expect(fake.calls.some((c) => c.path === '/d1-inbox/undo')).toBe(false);
		click('[data-test="link-undo-yes"]');
		await vi.waitFor(() => expect(fake.calls.find((c) => c.path === '/d1-inbox/undo')?.body).toEqual({ link_batch_id: batch }));
		await vi.waitFor(() => expect(all('[data-test="inbox-row"]')).toHaveLength(1));
		expect(all('[data-test="inbox-row"]')[0].textContent).toContain('bbbb2222_B.tif');
		// the selection went to the neighbour that is left
		await vi.waitFor(() => expect(text('[data-test="sheet-name"]')).toBe('bbbb2222_B.tif'));
	});

	it('a batch of several says so in the confirm and cannot be changed', async () => {
		const together = ['aaaa1111_A.tif', 'bbbb2222_B.tif', 'cccc3333_C.tif'].map((n) => linkedPic(n, { link_batch_id: 'one-batch', link_kind: 'bulk' }));
		await open(together, 'aaaa1111_A.tif');
		expect(q<HTMLButtonElement>('[data-test="link-change"]')!.disabled).toBe(true);
		expect(text('[data-test="link-change-why"]')).toContain('linked together with 2 others');
		click('[data-test="link-undo"]');
		await vi.waitFor(() => expect(text('[data-test="link-confirm"]')).toContain('all 3 files linked together'));
	});

	it('Change… opens the Link dialog; choosing a record is ONE relink request, and the sheet stays on the file', async () => {
		const self = linkedPic('aaaa1111_A.tif');
		const other = linkedPic('bbbb2222_B.tif');
		await open([self, other], 'aaaa1111_A.tif');
		answerItems();
		click('[data-test="link-change"]');
		await chooseRecord();
		await vi.waitFor(() => expect(q('[role="dialog"]')).toBeNull());
		expect(fake.calls.filter((c) => c.method === 'post').map((c) => c.path)).toEqual(['/d1-inbox/relink']);
		expect(fake.calls.find((c) => c.path === '/d1-inbox/relink')?.body).toEqual({ candidate_id: self.candidate_id, collection: 'physical_samples', record_id: 's-picked' });
		await vi.waitFor(() => expect(squash(text('[data-test="link-head"]'))).toBe('Linked to Chosen record'));
		expect(text('[data-test="sheet-name"]')).toBe('aaaa1111_A.tif');
	});

	it('a Change that is refused leaves the file linked where it was: the dialog stays open with the reason, and nothing else was sent', async () => {
		const self = linkedPic('aaaa1111_A.tif');
		const other = linkedPic('bbbb2222_B.tif');
		await open([self, other], 'aaaa1111_A.tif', '/inbox?tab=linked');
		answerItems();
		const post = fake.api.post.bind(fake.api);
		fake.api.post = ((path: string, body?: any) =>
			path === '/d1-inbox/relink' ? Promise.reject(Object.assign(new Error('403'), { response: { status: 403, data: { errors: [{ message: 'You can only link a file to a record you can edit.', extensions: { code: 'FORBIDDEN' } }] } } })) : post(path, body)) as typeof fake.api.post;
		click('[data-test="link-change"]');
		await chooseRecord();
		await vi.waitFor(() => expect(text('[data-test="link-error"]')).toBe('You can only link a file to a record you can edit.'));
		expect(q('[role="dialog"]')).not.toBeNull();
		expect(fake.calls.filter((c) => c.method === 'post').map((c) => c.path)).toEqual([]);
		expect(all('[data-test="inbox-row"]')).toHaveLength(2);
		expect(text('[data-test="sheet-name"]')).toBe('aaaa1111_A.tif');
		expect(squash(text('[data-test="link-head"]'))).not.toContain('Chosen record');
	});
});

describe('the view box page of a linked file', () => {
	const self = () => linkedPic('aaaa1111_A.tif');
	const inFolder = (id: string) => `/inbox/file/${id}?tab=linked&folder=sem`;

	it('has the Link card and the strip in the left panel, above the facts, and "Linked to" under On this page', async () => {
		const a = self();
		const b = linkedPic('bbbb2222_B.tif');
		await mount([a, b], inFolder(a.candidate_id));
		await vi.waitFor(() => expect(q('[data-test="file-rail"]')).not.toBeNull());
		const rail = q('[data-test="rail-linked"]')!;
		expect(rail.closest('[data-test="file-rail"]')).not.toBeNull();
		expect(squash(rail.querySelector('[data-test="link-head"]')!.textContent)).toBe('Linked to S-0042');
		await vi.waitFor(() => expect(tiles()).toHaveLength(1));
		expect(squash(text('[data-test="siblings-head"]'))).toBe('Linked to S-0042 · 2 images');
		expect([...document.querySelectorAll('.d1-page-contents .entry .title')].map((e) => e.textContent)).toEqual(['Picture', 'Linked to', 'Imaging settings', 'Where it is']);
		expect(all('[data-test="link-card"]')).toHaveLength(1);
	});

	it('shows nothing of the kind for a file that is not linked', async () => {
		const f = exactMatch({ rel_path: 'Users/ab1cd/sem/3fa9c1d2_A1.tif', has_thumbnail: true, extracted: SEM });
		await mount([f], `/inbox/file/${f.candidate_id}`);
		await vi.waitFor(() => expect(q('[data-test="file-rail"]')).not.toBeNull());
		expect(q('[data-test="link-card"]')).toBeNull();
		expect(q('[data-test="siblings"]')).toBeNull();
		expect([...document.querySelectorAll('.d1-page-contents .entry .title')].map((e) => e.textContent)).toEqual(['Picture', 'Imaging settings', 'Where it is']);
	});

	it('Open sample goes to the sample\'s page', async () => {
		const a = self();
		await mount([a], inFolder(a.candidate_id));
		await vi.waitFor(() => expect(q('[data-test="link-open"]')).not.toBeNull());
		click('[data-test="link-open"]');
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`/samples/${RECORD}`));
	});

	it('a picture of the same record that the page\'s filters do not list opens all the same (the address drops the filters)', async () => {
		const a = self();
		const elsewhere = linkedPic('bbbb2222_B.tif', {}, 'afm');
		await mount([a, elsewhere], inFolder(a.candidate_id));
		await vi.waitFor(() => expect(tiles()).toHaveLength(1));
		tileFor(elsewhere.candidate_id).click();
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`/inbox/file/${elsewhere.candidate_id}`));
		expect(router.currentRoute.value.query).toEqual({ tab: 'linked' });
		await vi.waitFor(() => expect(text('[data-test="box-name"]')).toBe('bbbb2222_B.tif'));
		expect(q('[data-test="not-visible"]')).toBeNull();
	});

	it('"Compare with…" then a sibling the filters do not list puts it beside this file (not the lock card)', async () => {
		const a = self();
		const elsewhere = linkedPic('bbbb2222_B.tif', {}, 'afm');
		await mount([a, elsewhere], inFolder(a.candidate_id));
		await vi.waitFor(() => expect(tiles()).toHaveLength(1));
		click('[data-test="siblings-compare"]');
		tileFor(elsewhere.candidate_id).click();
		await vi.waitFor(() => expect(router.currentRoute.value.query.with).toBe(elsewhere.candidate_id));
		await vi.waitFor(() => expect(text('[data-test="b-name"]')).toBe('bbbb2222_B.tif'));
		expect(text('[data-test="a-name"]')).toBe('aaaa1111_A.tif');
		expect(q('[data-test="compare-locked"]')).toBeNull();
	});

	it('a partner named in the address that is a sibling is found on a fresh load too', async () => {
		const a = self();
		const elsewhere = linkedPic('bbbb2222_B.tif', {}, 'afm');
		await mount([a, elsewhere], `${inFolder(a.candidate_id)}&with=${elsewhere.candidate_id}`);
		await vi.waitFor(() => expect(text('[data-test="b-name"]')).toBe('bbbb2222_B.tif'));
		expect(q('[data-test="compare-locked"]')).toBeNull();
	});

	it('Undo link undoes the batch and moves on, as Dismiss does', async () => {
		const a = self();
		const b = linkedPic('bbbb2222_B.tif');
		const batch = a.link_batch_id;
		await mount([a, b], inFolder(a.candidate_id));
		await vi.waitFor(() => expect(q('[data-test="link-undo"]')).not.toBeNull());
		click('[data-test="link-undo"]');
		await vi.waitFor(() => expect(q('[data-test="link-confirm"]')).not.toBeNull());
		click('[data-test="link-undo-yes"]');
		await vi.waitFor(() => expect(fake.calls.find((c) => c.path === '/d1-inbox/undo')?.body).toEqual({ link_batch_id: batch }));
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`/inbox/file/${b.candidate_id}`));
		expect(text('[data-test="notice"]')).toContain('Undone');
	});

	it('a Change that is refused: the page stays on the file, still linked where it was, and the dialog says why', async () => {
		const a = self();
		const b = linkedPic('bbbb2222_B.tif');
		await mount([a, b], inFolder(a.candidate_id));
		await vi.waitFor(() => expect(q('[data-test="link-change"]')).not.toBeNull());
		answerItems();
		const post = fake.api.post.bind(fake.api);
		fake.api.post = ((path: string, body?: any) =>
			path === '/d1-inbox/relink' ? Promise.reject(Object.assign(new Error('403'), { response: { status: 403, data: { errors: [{ message: 'You can only link a file to a record you can edit.', extensions: { code: 'FORBIDDEN' } }] } } })) : post(path, body)) as typeof fake.api.post;
		click('[data-test="link-change"]');
		await chooseRecord();
		await vi.waitFor(() => expect(text('[data-test="link-error"]')).toBe('You can only link a file to a record you can edit.'));
		expect(router.currentRoute.value.path).toBe('/inbox/file/' + a.candidate_id);
		expect(text('[data-test="box-name"]')).toBe('aaaa1111_A.tif');
		expect(q('[data-test="link-undo"]')).not.toBeNull();
	});

	it('an open Undo confirm does not carry over to the next file the page shows', async () => {
		const a = self();
		const b = linkedPic('bbbb2222_B.tif');
		await mount([a, b], inFolder(a.candidate_id));
		await vi.waitFor(() => expect(q('[data-test="link-undo"]')).not.toBeNull());
		click('[data-test="link-undo"]');
		await vi.waitFor(() => expect(q('[data-test="link-confirm"]')).not.toBeNull());
		await router.push(inFolder(b.candidate_id));
		await vi.waitFor(() => expect(text('[data-test="box-name"]')).toBe('bbbb2222_B.tif'));
		expect(q('[data-test="link-confirm"]')).toBeNull();
		expect(q<HTMLButtonElement>('[data-test="link-undo"]')!.disabled).toBe(false);
	});

	it('Change… on a batch of one: the dialog opens, and the page reads the file again once it is on the other record (it stays here)', async () => {
		const a = self();
		await mount([a], inFolder(a.candidate_id));
		await vi.waitFor(() => expect(q('[data-test="link-change"]')).not.toBeNull());
		answerItems();
		click('[data-test="link-change"]');
		await chooseRecord();
		await vi.waitFor(() => expect(q('[role="dialog"]')).toBeNull());
		expect(fake.calls.filter((c) => c.method === 'post').map((c) => c.path)).toEqual(['/d1-inbox/relink']);
		await vi.waitFor(() => expect(squash(text('[data-test="link-head"]'))).toBe('Linked to Chosen record'));
		expect(router.currentRoute.value.path).toBe(`/inbox/file/${a.candidate_id}`);
	});
});
