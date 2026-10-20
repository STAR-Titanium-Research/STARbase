// @vitest-environment happy-dom
// Compare in the Inbox list (spec 2026-10-20-inbox-file-viewer-design.md decisions 3 and 5), against the fake d1-inbox: the View rail's "Compare two files" gives
// the pictures a tick box (at most two); opening one of a ticked pair, or "Compare them", goes to the view box with ?with=; the option is remembered; with it off,
// nothing about the rows changes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, ref, type App } from 'vue';
import { RouterView, createMemoryHistory, createRouter, type Router } from 'vue-router';
import { configureLinks, resetLinks, setExplorerHostFactory, starbaseLinks } from '@d1/ui';
import { setPageFrame } from '../frame';
import InboxView from './InboxView.vue';
import { createFakeInbox, exactMatch, foundFile, type FakeInboxOptions } from './fakeInboxServer';
import type { FoundFile } from './inboxApi';
import { VIEW_KEY } from './useViewSettings';

const Button = defineComponent({
	props: { disabled: Boolean, loading: Boolean },
	emits: ['click'],
	setup: (p, { slots, emit, attrs }) => () => h('button', { type: 'button', disabled: p.disabled || p.loading, 'data-test': attrs['data-test'], onClick: () => emit('click') }, slots.default?.()),
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
const BoxPage = defineComponent({ render: () => h('div', { 'data-test': 'box-page' }) });

async function mount(files: FoundFile[], opts: FakeInboxOptions = {}, at = '/inbox') {
	fake = createFakeInbox({ files, ...opts });
	setExplorerHostFactory(() => ({
		api: fake.api, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u-me' }),
	}));
	configureLinks(starbaseLinks('https://d1.example'));
	setPageFrame(defineComponent({ props: { title: String }, setup: (_p, { slots }) => () => h('div', [slots.default?.()]) }));
	router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/inbox', component: InboxView }, { path: '/inbox/file/:candidateId', component: BoxPage }] });
	await router.push(at);
	app = createApp({ render: () => h('div', [h(RouterView)]) });
	app.use(router);
	registerStubs(app);
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	await vi.waitFor(() => expect(document.querySelectorAll('[data-test="inbox-row"]').length).toBe(files.filter((f) => f.kind !== 'document').length));
}

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-test="inbox-row"]')];
const rowOf = (name: string) => rows().find((r) => r.textContent?.includes(name))!;
const tick = (name: string) => rowOf(name).querySelector<HTMLInputElement>('[data-test="row-tick"]');
const nameButton = (name: string) => rowOf(name).querySelector<HTMLButtonElement>('button[data-test="row-name"]')!;
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const toggle = () => q<HTMLInputElement>('[data-test="toggle-compare"]')!;
const key = (k: string, target: Element | Document = document) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const click = (el: HTMLInputElement) => el.click();
const settings = () => JSON.parse(window.localStorage.getItem(VIEW_KEY) ?? '{}');

const SEM = { kv: 15, pixel_size_nm: 100, image_width_px: 1000, sources: { kv: 'metadata', pixel_size_nm: 'metadata' }, flags: {} };
const A = 'Users/ab1cd/sem/3fa9c1d2_A1.tif';
const B = 'Users/ab1cd/sem/9ab3c4d5_B2.tif';
const C = 'Users/ab1cd/sem/5cd6e7f8_C3.tif';
const withThumb = (rel: string, over: Partial<FoundFile> = {}) => exactMatch({ rel_path: rel, has_thumbnail: true, extracted: SEM, ...over }, rel.split('/').pop()!.slice(0, 8));

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

describe('Compare two files in the list', () => {
	it('is off by default: no tick boxes, no compare bar', async () => {
		await mount([withThumb(A), withThumb(B)]);
		expect(toggle().checked).toBe(false);
		expect(q('[data-test="row-tick"]')).toBeNull();
		expect(q('[data-test="compare-bar"]')).toBeNull();
	});

	it('turning it on gives the pictures a tick box (not the documents) and remembers the choice', async () => {
		await mount([withThumb(A), withThumb(B), foundFile({ kind: 'document', rel_path: 'Users/ab1cd/notes.pdf' })]);
		toggle().click();
		await vi.waitFor(() => expect(document.querySelectorAll('[data-test="row-tick"]')).toHaveLength(2));
		expect(q('[data-test="compare-bar"]')).not.toBeNull();
		expect(settings().compareList).toBe(true);
		expect(tick('3fa9c1d2_A1.tif')!.getAttribute('aria-label')).toBe('Compare 3fa9c1d2_A1.tif');
	});

	it('is remembered across a reload', async () => {
		window.localStorage.setItem(VIEW_KEY, JSON.stringify({ compareList: true }));
		await mount([withThumb(A), withThumb(B)]);
		expect(toggle().checked).toBe(true);
		expect(document.querySelectorAll('[data-test="row-tick"]')).toHaveLength(2);
	});

	it('allows at most two ticks: the others are disabled until one is un-ticked', async () => {
		window.localStorage.setItem(VIEW_KEY, JSON.stringify({ compareList: true }));
		await mount([withThumb(A), withThumb(B), withThumb(C)]);
		const open = () => q<HTMLButtonElement>('[data-test="compare-open"]')!;
		expect(open().disabled).toBe(true);
		click(tick('3fa9c1d2_A1.tif')!);
		await vi.waitFor(() => expect(q('[data-test="compare-note"]')!.textContent).toBe('1 of 2 files ticked.'));
		expect(open().disabled).toBe(true);
		click(tick('9ab3c4d5_B2.tif')!);
		await vi.waitFor(() => expect(open().disabled).toBe(false));
		expect(tick('5cd6e7f8_C3.tif')!.disabled).toBe(true);
		expect(tick('3fa9c1d2_A1.tif')!.disabled).toBe(false);
		click(tick('3fa9c1d2_A1.tif')!);
		await vi.waitFor(() => expect(tick('5cd6e7f8_C3.tif')!.disabled).toBe(false));
		expect(open().disabled).toBe(true);
	});

	it('"Compare them" opens the view box on the first ticked file with the second as ?with=', async () => {
		window.localStorage.setItem(VIEW_KEY, JSON.stringify({ compareList: true }));
		const files = [withThumb(A), withThumb(B), withThumb(C)];
		await mount(files);
		click(tick('9ab3c4d5_B2.tif')!);
		click(tick('5cd6e7f8_C3.tif')!);
		await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-test="compare-open"]')!.disabled).toBe(false));
		q<HTMLButtonElement>('[data-test="compare-open"]')!.click();
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`/inbox/file/${files[1].candidate_id}`));
		expect(router.currentRoute.value.query.with).toBe(files[2].candidate_id);
	});

	it('opening a file of a ticked pair from the sheet carries the partner', async () => {
		window.localStorage.setItem(VIEW_KEY, JSON.stringify({ compareList: true }));
		const files = [withThumb(A), withThumb(B), withThumb(C)];
		await mount(files);
		click(tick('3fa9c1d2_A1.tif')!);
		click(tick('5cd6e7f8_C3.tif')!);
		// the sheet's Open in view box
		nameButton('3fa9c1d2_A1.tif').click();
		await vi.waitFor(() => expect(q('[data-test="sheet-open-box"]')).not.toBeNull());
		q<HTMLButtonElement>('[data-test="sheet-open-box"]')!.click();
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`/inbox/file/${files[0].candidate_id}`));
		expect(router.currentRoute.value.query.with).toBe(files[2].candidate_id);
	});

	it('with Preview = View box, a click on a ticked file opens the pair; on another file, alone', async () => {
		window.localStorage.setItem(VIEW_KEY, JSON.stringify({ compareList: true, preview: 'box' }));
		const files = [withThumb(A), withThumb(B), withThumb(C)];
		await mount(files);
		click(tick('3fa9c1d2_A1.tif')!);
		click(tick('9ab3c4d5_B2.tif')!);
		nameButton('5cd6e7f8_C3.tif').click();
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`/inbox/file/${files[2].candidate_id}`));
		expect(router.currentRoute.value.query.with).toBeUndefined();
		await router.push('/inbox');
		await vi.waitFor(() => expect(rows()).toHaveLength(3));
		click(tick('3fa9c1d2_A1.tif')!);
		click(tick('9ab3c4d5_B2.tif')!);
		nameButton('9ab3c4d5_B2.tif').click();
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`/inbox/file/${files[1].candidate_id}`));
		expect(router.currentRoute.value.query.with).toBe(files[0].candidate_id);
	});

	it('turning it off drops the ticks and the boxes, and a click opens the file alone', async () => {
		window.localStorage.setItem(VIEW_KEY, JSON.stringify({ compareList: true, preview: 'box' }));
		const files = [withThumb(A), withThumb(B)];
		await mount(files);
		click(tick('3fa9c1d2_A1.tif')!);
		click(tick('9ab3c4d5_B2.tif')!);
		toggle().click();
		await vi.waitFor(() => expect(q('[data-test="row-tick"]')).toBeNull());
		expect(q('[data-test="compare-bar"]')).toBeNull();
		nameButton('3fa9c1d2_A1.tif').click();
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`/inbox/file/${files[0].candidate_id}`));
		expect(router.currentRoute.value.query.with).toBeUndefined();
	});

	it('keeps the existing behaviour: the sheet still opens on a click and the arrow keys move it, with ticks on', async () => {
		window.localStorage.setItem(VIEW_KEY, JSON.stringify({ compareList: true }));
		await mount([withThumb(A), withThumb(B)]);
		nameButton('3fa9c1d2_A1.tif').click();
		await vi.waitFor(() => expect(q('[data-test="sheet-name"]')?.textContent).toBe('3fa9c1d2_A1.tif'));
		key('ArrowDown');
		await vi.waitFor(() => expect(q('[data-test="sheet-name"]')?.textContent).toBe('9ab3c4d5_B2.tif'));
	});
});
