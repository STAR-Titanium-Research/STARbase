// @vitest-environment happy-dom
// The Inbox sheet (spec 2026-10-20-inbox-file-viewer-design.md decisions 2, 3, 7, 8, 9), against the fake d1-inbox: a click on a row's picture or name opens the
// sheet beside the list with the preview, a scale bar and the facts; the selected row is marked; ArrowUp/ArrowDown move the selection and Esc closes the sheet;
// a file with no picture still shows its facts; the View rail's Preview setting decides what a click opens and is remembered.
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
const thumbButton = (name: string) => rowOf(name).querySelector<HTMLButtonElement>('button[data-test="thumb"]')!;
const nameButton = (name: string) => rowOf(name).querySelector<HTMLButtonElement>('button[data-test="row-name"]')!;
const sheet = () => document.querySelector<HTMLElement>('[data-test="inbox-sheet"]');
const sheetName = () => document.querySelector('[data-test="sheet-name"]')?.textContent ?? null;
const key = (k: string, target: Element | Document = document) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const selectedRows = () => rows().filter((r) => r.getAttribute('aria-current') === 'true').map((r) => r.querySelector('.name')?.textContent);

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

describe('opening the sheet', () => {
	it('shows no sheet until a file is chosen, and the View rail says Sheet', async () => {
		await mount([withThumb(A)]);
		expect(sheet()).toBeNull();
		expect(document.querySelector('[data-test="view-rail"]')).not.toBeNull();
		const checked = [...document.querySelectorAll<HTMLElement>('[data-test="rail-preview"] [role="radio"]')].find((b) => b.getAttribute('aria-checked') === 'true');
		expect(checked?.textContent).toBe('Sheet');
	});

	it('a click on the picture opens the sheet with the preview, a scale bar, the facts and the actions; the row is marked', async () => {
		await mount([withThumb(A), withThumb(B)]);
		thumbButton('3fa9c1d2_A1.tif').click();
		await vi.waitFor(() => expect(sheet()).not.toBeNull());
		expect(sheetName()).toBe('3fa9c1d2_A1.tif');
		await vi.waitFor(() => expect(document.querySelector('[data-test="sheet-image"]')?.getAttribute('src')).toMatch(/^blob:/));
		// 100 nm x 1000 px = 100 µm wide: a fifth, as a round length
		expect(document.querySelector('[data-test="sheet-scalebar"]')?.textContent).toContain('20 µm');
		expect(sheet()!.querySelector('[data-field="kv"]')!.textContent).toContain('15 kV');
		expect(sheet()!.textContent).toContain('Reduced-size preview');
		for (const t of ['sheet-link', 'sheet-dismiss', 'sheet-open-box']) expect(sheet()!.querySelector(`[data-test="${t}"]`), t).not.toBeNull();
		expect(selectedRows()).toEqual(['3fa9c1d2_A1.tif']);
		// the list stays: both rows are still there, and the preview was asked for once
		expect(rows()).toHaveLength(2);
		expect(fake.pictureStats.paths.filter((p) => p.endsWith('/preview'))).toHaveLength(1);
	});

	it('a click on the name opens it too; choosing another file moves the sheet', async () => {
		await mount([withThumb(A), withThumb(B)]);
		nameButton('3fa9c1d2_A1.tif').click();
		await vi.waitFor(() => expect(sheetName()).toBe('3fa9c1d2_A1.tif'));
		nameButton('9ab3c4d5_B2.tif').click();
		await vi.waitFor(() => expect(sheetName()).toBe('9ab3c4d5_B2.tif'));
		expect(selectedRows()).toEqual(['9ab3c4d5_B2.tif']);
		expect(document.querySelectorAll('[data-test="inbox-sheet"]')).toHaveLength(1);
	});

	it('shows no scale bar when the file says no pixel size', async () => {
		await mount([withThumb(A, { extracted: { kv: 15, sources: { kv: 'metadata' }, flags: {} } })]);
		thumbButton('3fa9c1d2_A1.tif').click();
		await vi.waitFor(() => expect(document.querySelector('[data-test="sheet-image"]')).not.toBeNull());
		expect(document.querySelector('[data-test="sheet-scalebar"]')).toBeNull();
	});

	it('shimmers while the preview loads and says so, with Retry, when it fails', async () => {
		await mount([withThumb(A)], { previewDelayMs: 200 });
		thumbButton('3fa9c1d2_A1.tif').click();
		await vi.waitFor(() => expect(document.querySelector('[data-test="sheet-loading"]')).not.toBeNull());
		expect(document.querySelector('[data-test="sheet-image"]')).toBeNull();
		await vi.waitFor(() => expect(document.querySelector('[data-test="sheet-image"]')).not.toBeNull());
		app!.unmount();
		document.body.innerHTML = '';
		await mount([withThumb(B)], { previewFails: 1 });
		thumbButton('9ab3c4d5_B2.tif').click();
		await vi.waitFor(() => expect(document.querySelector('[data-test="sheet-error"]')).not.toBeNull());
		expect(sheet()!.querySelector('[data-test="sheet-open-box"]')).toBeNull();
		(document.querySelector('[data-test="sheet-retry"]') as HTMLElement).click();
		await vi.waitFor(() => expect(document.querySelector('[data-test="sheet-image"]')).not.toBeNull());
	});
});

describe('keys', () => {
	it('ArrowDown and ArrowUp move the selection and the sheet follows; they stop at the ends', async () => {
		await mount([withThumb(A), withThumb(B), withThumb(C)]);
		thumbButton('3fa9c1d2_A1.tif').click();
		await vi.waitFor(() => expect(sheetName()).toBe('3fa9c1d2_A1.tif'));
		key('ArrowDown');
		await vi.waitFor(() => expect(sheetName()).toBe('9ab3c4d5_B2.tif'));
		expect(selectedRows()).toEqual(['9ab3c4d5_B2.tif']);
		key('ArrowDown');
		await vi.waitFor(() => expect(sheetName()).toBe('5cd6e7f8_C3.tif'));
		key('ArrowDown');
		await new Promise((r) => setTimeout(r, 20));
		expect(sheetName()).toBe('5cd6e7f8_C3.tif');
		key('ArrowUp');
		key('ArrowUp');
		await vi.waitFor(() => expect(sheetName()).toBe('3fa9c1d2_A1.tif'));
		key('ArrowUp');
		await new Promise((r) => setTimeout(r, 20));
		expect(sheetName()).toBe('3fa9c1d2_A1.tif');
	});

	it('does nothing with the arrows while no sheet is open, or while typing in a field', async () => {
		await mount([withThumb(A), withThumb(B)]);
		key('ArrowDown');
		expect(sheet()).toBeNull();
		thumbButton('3fa9c1d2_A1.tif').click();
		await vi.waitFor(() => expect(sheet()).not.toBeNull());
		const input = document.createElement('input');
		document.body.appendChild(input);
		key('ArrowDown', input);
		await new Promise((r) => setTimeout(r, 20));
		expect(sheetName()).toBe('3fa9c1d2_A1.tif');
	});

	it('Esc closes the sheet and gives focus back to the row\'s name', async () => {
		await mount([withThumb(A), withThumb(B)]);
		nameButton('9ab3c4d5_B2.tif').click();
		await vi.waitFor(() => expect(sheet()).not.toBeNull());
		key('Escape');
		await vi.waitFor(() => expect(sheet()).toBeNull());
		expect(selectedRows()).toEqual([]);
		expect(document.activeElement).toBe(nameButton('9ab3c4d5_B2.tif'));
	});

	it('the Close button closes it too', async () => {
		await mount([withThumb(A)]);
		thumbButton('3fa9c1d2_A1.tif').click();
		await vi.waitFor(() => expect(sheet()).not.toBeNull());
		(document.querySelector('[data-test="sheet-close"]') as HTMLElement).click();
		await vi.waitFor(() => expect(sheet()).toBeNull());
	});
});

describe('a file with no picture', () => {
	it('still opens the sheet with its facts, no image and no Open in view box', async () => {
		const plain = foundFile({ rel_path: 'Users/ab1cd/misc/plain.tif', kind: 'sem_image', extracted: { kv: 20, sources: { kv: 'ocr' }, flags: {} } });
		await mount([withThumb(A), plain]);
		expect(rowOf('plain.tif').querySelector('button[data-test="thumb"]')).toBeNull();
		nameButton('plain.tif').click();
		await vi.waitFor(() => expect(sheetName()).toBe('plain.tif'));
		expect(sheet()!.querySelector('[data-test="sheet-image"]')).toBeNull();
		expect(sheet()!.querySelector('[data-test="sheet-nopicture"]')!.textContent).toContain('not made yet');
		expect(sheet()!.querySelector('[data-field="kv"]')!.textContent).toContain('20 kV');
		expect(sheet()!.textContent).toContain('misc');
		expect(sheet()!.querySelector('[data-test="sheet-open-box"]')).toBeNull();
		expect(sheet()!.querySelector('[data-test="sheet-link"]')).not.toBeNull();
		expect(fake.pictureStats.requests).toBe(0);
	});
});

describe('the actions', () => {
	it('Dismiss in the sheet dismisses the file, and the sheet goes with it', async () => {
		await mount([withThumb(A), withThumb(B)]);
		thumbButton('3fa9c1d2_A1.tif').click();
		await vi.waitFor(() => expect(sheet()).not.toBeNull());
		(sheet()!.querySelector('[data-test="sheet-dismiss"]') as HTMLElement).click();
		await vi.waitFor(() => expect(fake.calls.some((c) => c.path === '/d1-inbox/dismiss')).toBe(true));
		await vi.waitFor(() => expect(sheet()).toBeNull());
		expect(rows()).toHaveLength(1);
	});

	it('Link to… opens the link dialog for that file', async () => {
		await mount([withThumb(A)]);
		thumbButton('3fa9c1d2_A1.tif').click();
		await vi.waitFor(() => expect(sheet()).not.toBeNull());
		(sheet()!.querySelector('[data-test="sheet-link"]') as HTMLElement).click();
		await vi.waitFor(() => expect(document.querySelector('[data-test="link-search"]')).not.toBeNull());
	});

	it('Open in view box goes to the page of the file, carrying the filters', async () => {
		const f = withThumb(A);
		await mount([f], {}, '/inbox?strength=short_id&folder=sem');
		thumbButton('3fa9c1d2_A1.tif').click();
		await vi.waitFor(() => expect(document.querySelector('[data-test="sheet-image"]')).not.toBeNull());
		(sheet()!.querySelector('[data-test="sheet-open-box"]') as HTMLElement).click();
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`/inbox/file/${f.candidate_id}`));
		expect(router.currentRoute.value.query).toEqual({ folder: 'sem', strength: 'short_id' });
		expect(document.querySelector('[data-test="preview-dialog"]')).toBeNull();
	});

	it('Enter opens the page of the selected file; on another control it keeps its own meaning', async () => {
		const f = withThumb(A);
		await mount([f, withThumb('Users/ab1cd/sem/9ab3c4d5_B2.tif')]);
		thumbButton('3fa9c1d2_A1.tif').click();
		await vi.waitFor(() => expect(sheet()).not.toBeNull());
		// Enter on a button of some other row (Link, Dismiss, ...) is that button's, not ours
		const other = rowOf('9ab3c4d5_B2.tif').querySelector<HTMLElement>('.buttons button')!;
		key('Enter', other);
		expect(router.currentRoute.value.path).toBe('/inbox');
		key('Enter');
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`/inbox/file/${f.candidate_id}`));
	});
});

describe('the View rail', () => {
	it('Preview = View box opens the page of the file on a click on its picture or name, with no sheet; the choice is remembered', async () => {
		const f = withThumb(A);
		await mount([f]);
		const box = [...document.querySelectorAll<HTMLElement>('[data-test="rail-preview"] [role="radio"]')].find((b) => b.textContent === 'View box')!;
		box.click();
		await vi.waitFor(() => expect(JSON.parse(window.localStorage.getItem(VIEW_KEY)!).preview).toBe('box'));
		await vi.waitFor(() => expect(rowOf('3fa9c1d2_A1.tif').querySelector('.name')!.getAttribute('data-test')).toBe('row-name'));
		thumbButton('3fa9c1d2_A1.tif').click();
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`/inbox/file/${f.candidate_id}`));
		expect(sheet()).toBeNull();
	});

	it('starts from the stored choice after a reload', async () => {
		window.localStorage.setItem(VIEW_KEY, JSON.stringify({ preview: 'box', railOpen: false }));
		await mount([withThumb(A)]);
		expect(document.querySelector('[data-test="view-rail"]')).toBeNull();
		expect(document.querySelector('[data-test="rail-expand"]')!.textContent).toContain('View box');
		(document.querySelector('[data-test="rail-expand"]') as HTMLElement).click();
		await vi.waitFor(() => expect(document.querySelector('[data-test="view-rail"]')).not.toBeNull());
		expect(JSON.parse(window.localStorage.getItem(VIEW_KEY)!).railOpen).toBe(true);
	});

	it('switching to View box closes an open sheet', async () => {
		await mount([withThumb(A)]);
		thumbButton('3fa9c1d2_A1.tif').click();
		await vi.waitFor(() => expect(sheet()).not.toBeNull());
		[...document.querySelectorAll<HTMLElement>('[data-test="rail-preview"] [role="radio"]')].find((b) => b.textContent === 'View box')!.click();
		await vi.waitFor(() => expect(sheet()).toBeNull());
	});

	it('works when storage is blocked', async () => {
		const real = Object.getOwnPropertyDescriptor(window, 'localStorage');
		Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new Error('blocked'); } });
		try {
			await mount([withThumb(A)]);
			thumbButton('3fa9c1d2_A1.tif').click();
			await vi.waitFor(() => expect(sheet()).not.toBeNull());
		} finally {
			if (real) Object.defineProperty(window, 'localStorage', real);
		}
	});
});
