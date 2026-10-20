// @vitest-environment happy-dom
// The Inbox's pictures, behaviourally, against the fake d1-inbox: the thumbnail in a row (only for a file with has_thumbnail, only once the row is near
// the screen, a few at a time, a shimmer while it loads, the icon when it fails), and the preview dialog it opens (spinner and the blurred thumbnail
// meanwhile, Retry, the file's facts and the reduced-size line, Esc / backdrop / Close, focus back on the thumbnail, Tab kept inside) and the object
// URLs being let go.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, ref, type App } from 'vue';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { configureLinks, resetLinks, setExplorerHostFactory, starbaseLinks } from '@d1/ui';
import { setPageFrame } from '../frame';
import InboxView from './InboxView.vue';
import { createFakeInbox, exactMatch, foundFile, type FakeInboxOptions } from './fakeInboxServer';
import type { FoundFile } from './inboxApi';

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

/** An IntersectionObserver the test drives: nothing is "visible" until `show(el)`. */
const observed = new Map<Element, () => void>();
class FakeIO {
	constructor(private cb: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void) {}
	observe(el: Element) {
		observed.set(el, () => this.cb([{ isIntersecting: true, target: el }]));
	}
	unobserve(el: Element) {
		observed.delete(el);
	}
	disconnect() {}
}
const show = (el: Element) => observed.get(el)?.();

let app: App | null = null;
let fake: ReturnType<typeof createFakeInbox>;
let revoked: string[] = [];

async function mount(files: FoundFile[], opts: FakeInboxOptions = {}) {
	fake = createFakeInbox({ files, ...opts });
	setExplorerHostFactory(() => ({
		api: fake.api, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u-me' }),
	}));
	configureLinks(starbaseLinks('https://d1.example'));
	setPageFrame(defineComponent({ props: { title: String }, setup: (_p, { slots }) => () => h('div', [slots.default?.()]) }));
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/inbox', component: InboxView }] });
	await router.push('/inbox');
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
const thumbButton = (name: string) => rowOf(name).querySelector<HTMLButtonElement>('button[data-test="thumb"]');
const dialog = () => document.querySelector<HTMLElement>('[data-test="preview-dialog"]');
const key = (k: string, init: KeyboardEventInit = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const thumbPaths = () => fake.pictureStats.paths.filter((p) => p.endsWith('/thumb'));

const withThumb = (rel: string, over: Partial<FoundFile> = {}) => exactMatch({ rel_path: rel, has_thumbnail: true, ...over });

beforeEach(() => {
	document.body.innerHTML = '';
	// these tests are about the full preview window, which is what a click opens when the View rail's Preview is "View box" (the default is the sheet)
	window.localStorage.setItem('d1.list.inbox', JSON.stringify({ preview: 'box' }));
	observed.clear();
	revoked = [];
	vi.stubGlobal('IntersectionObserver', FakeIO);
	const real = URL.revokeObjectURL.bind(URL);
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => {
		revoked.push(u);
		real(u);
	});
});
afterEach(() => {
	window.localStorage.clear();
	app?.unmount();
	app = null;
	resetLinks();
	setExplorerHostFactory(null);
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('the thumbnail in a row', () => {
	it('is a button named "View <file name>" only for a file with has_thumbnail; every other row keeps the kind icon', async () => {
		await mount([withThumb('Users/ab1cd/sem/3fa9c1d2_A1.tif'), foundFile({ rel_path: 'Users/ab1cd/misc/plain.tif' }), exactMatch({ kind: 'surface_scan', rel_path: 'Users/ab1cd/scans/edge1.al3d' }, '77aa88bb', 'S-9')]);
		const btn = thumbButton('3fa9c1d2_A1.tif')!;
		expect(btn.getAttribute('aria-label')).toBe('View 3fa9c1d2_A1.tif');
		expect(btn.tagName).toBe('BUTTON');
		expect(rowOf('plain.tif').querySelector('button[data-test="thumb"]')).toBeNull();
		expect(rowOf('plain.tif').querySelector('.thumb .icon')?.getAttribute('data-icon')).toBe('image');
		expect(rowOf('edge1.al3d').querySelector('.thumb .icon')?.getAttribute('data-icon')).toBe('view_in_ar');
	});

	it('asks for nothing until the row is near the screen, then shows a shimmer while it loads and the picture when it is in', async () => {
		await mount([withThumb('Users/ab1cd/sem/3fa9c1d2_A1.tif'), withThumb('Users/ab1cd/sem/9ab3c4d5_B2.tif')], { pictureDelayMs: 300 });
		await new Promise((r) => setTimeout(r, 40));
		expect(fake.pictureStats.requests).toBe(0);
		expect(thumbButton('3fa9c1d2_A1.tif')!.querySelector('.shimmer')).not.toBeNull();
		show(thumbButton('3fa9c1d2_A1.tif')!);
		await vi.waitFor(() => expect(thumbButton('3fa9c1d2_A1.tif')!.dataset.state).toBe('loading'));
		expect(thumbButton('3fa9c1d2_A1.tif')!.querySelector('.shimmer')).not.toBeNull();
		expect(thumbButton('3fa9c1d2_A1.tif')!.getAttribute('aria-busy')).toBe('true');
		await vi.waitFor(() => expect(thumbButton('3fa9c1d2_A1.tif')!.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/));
		expect(thumbButton('3fa9c1d2_A1.tif')!.querySelector('.shimmer')).toBeNull();
		// the row that never came into view was never asked for
		expect(thumbPaths()).toEqual([`/d1-inbox/files/${fake.files[0].candidate_id}/thumb`]);
		expect(thumbButton('9ab3c4d5_B2.tif')!.querySelector('img')).toBeNull();
	});

	it('loads at most four at a time however many rows come into view', async () => {
		const files = Array.from({ length: 10 }, (_, i) => withThumb(`Users/ab1cd/sem/f${i}_A.tif`));
		await mount(files, { pictureDelayMs: 15 });
		for (const f of files) show(thumbButton(f.rel_path.split('/').pop()!)!);
		await vi.waitFor(() => expect(rows().filter((r) => r.querySelector('img')).length).toBe(10), { timeout: 3000 });
		expect(fake.pictureStats.thumbs).toBe(10);
		expect(fake.pictureStats.maxOpen).toBeGreaterThan(1);
		expect(fake.pictureStats.maxOpen).toBeLessThanOrEqual(4);
	});

	it('loads every picture at once rather than never when the browser has no IntersectionObserver', async () => {
		vi.stubGlobal('IntersectionObserver', undefined);
		await mount([withThumb('Users/ab1cd/sem/3fa9c1d2_A1.tif'), withThumb('Users/ab1cd/sem/9ab3c4d5_B2.tif')]);
		await vi.waitFor(() => expect(rows().filter((r) => r.querySelector('img')).length).toBe(2));
	});

	it('quietly shows the kind icon again when the picture fails: no button, no message', async () => {
		await mount([withThumb('Users/ab1cd/sem/3fa9c1d2_A1.tif')], { thumbFails: true });
		show(thumbButton('3fa9c1d2_A1.tif')!);
		await vi.waitFor(() => expect(rowOf('3fa9c1d2_A1.tif').querySelector('button[data-test="thumb"]')).toBeNull());
		expect(rowOf('3fa9c1d2_A1.tif').querySelector('.thumb .icon')?.getAttribute('data-icon')).toBe('image');
		expect(document.querySelector('[role="alert"]')).toBeNull();
		expect(document.querySelector('[data-test="notice"]')).toBeNull();
	});

	it('keeps the button while its preview is open when the picture fails under a click, and hands focus to the row\'s first action when it closes', async () => {
		await mount([withThumb('Users/ab1cd/sem/3fa9c1d2_A1.tif')], { thumbFails: true, pictureDelayMs: 120 });
		const btn = thumbButton('3fa9c1d2_A1.tif')!;
		show(btn);
		await vi.waitFor(() => expect(btn.dataset.state).toBe('loading'));
		btn.focus();
		btn.click(); // while it still shimmers
		await vi.waitFor(() => expect(dialog()).not.toBeNull());
		await vi.waitFor(() => expect(btn.dataset.state).toBe('failed'));
		// the failed thumbnail does not pull the button out from under the open preview
		expect(thumbButton('3fa9c1d2_A1.tif')).toBe(btn);
		expect(btn.querySelector('.shimmer')).toBeNull();
		await vi.waitFor(() => expect(dialog()!.dataset.state).toBe('ready'));
		key('Escape');
		await vi.waitFor(() => expect(dialog()).toBeNull());
		// now it is the icon again, and focus is on a button of the row, not on <body>
		await vi.waitFor(() => expect(rowOf('3fa9c1d2_A1.tif').querySelector('button[data-test="thumb"]')).toBeNull());
		await vi.waitFor(() => expect(document.activeElement).toBe(rowOf('3fa9c1d2_A1.tif').querySelector('.buttons button')));
	});

	it('hands focus to the first action when the thumbnail that has focus fails to load', async () => {
		await mount([withThumb('Users/ab1cd/sem/3fa9c1d2_A1.tif')], { thumbFails: true, pictureDelayMs: 120 });
		const btn = thumbButton('3fa9c1d2_A1.tif')!;
		show(btn);
		await vi.waitFor(() => expect(btn.dataset.state).toBe('loading'));
		btn.focus();
		expect(document.activeElement).toBe(btn);
		await vi.waitFor(() => expect(rowOf('3fa9c1d2_A1.tif').querySelector('button[data-test="thumb"]')).toBeNull());
		await vi.waitFor(() => expect(document.activeElement).toBe(rowOf('3fa9c1d2_A1.tif').querySelector('.buttons button')));
	});

	it('a picture request that stalls fails after 30 s: the row shows its icon and the queue slot is free for the next', async () => {
		await mount([withThumb('Users/ab1cd/sem/3fa9c1d2_A1.tif')], { pictureHangs: true });
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			show(thumbButton('3fa9c1d2_A1.tif')!);
			await vi.advanceTimersByTimeAsync(29_000);
			expect(thumbButton('3fa9c1d2_A1.tif')!.dataset.state).toBe('loading');
			await vi.advanceTimersByTimeAsync(1_500);
			await vi.waitFor(() => expect(rowOf('3fa9c1d2_A1.tif').querySelector('button[data-test="thumb"]')).toBeNull());
			expect(rowOf('3fa9c1d2_A1.tif').querySelector('.thumb .icon')?.getAttribute('data-icon')).toBe('image');
		} finally {
			vi.useRealTimers();
		}
	});

	it('lets the object URLs go when the rows go', async () => {
		vi.stubGlobal('IntersectionObserver', undefined);
		await mount([withThumb('Users/ab1cd/sem/3fa9c1d2_A1.tif'), withThumb('Users/ab1cd/sem/9ab3c4d5_B2.tif')]);
		await vi.waitFor(() => expect(rows().filter((r) => r.querySelector('img')).length).toBe(2));
		const urls = rows().map((r) => r.querySelector('img')!.getAttribute('src'));
		expect(revoked).toEqual([]);
		app!.unmount();
		app = null;
		expect([...revoked].sort()).toEqual([...urls].sort());
	});

	it('never asks for a picture of a file without has_thumbnail, a document included', async () => {
		await mount([foundFile({ rel_path: 'Users/ab1cd/misc/plain.tif' }), foundFile({ kind: 'document', rel_path: 'Users/ab1cd/notes.pdf' })]);
		await new Promise((r) => setTimeout(r, 30));
		expect(fake.pictureStats.requests).toBe(0);
	});
});

describe('the preview dialog', () => {
	const open = async (opts: FakeInboxOptions = {}, over: Partial<FoundFile> = {}) => {
		await mount([withThumb('Users/ab1cd/sem/9ab3c4d5_B2.tif', { extracted: { kv: 15, magnification: 5000, scale_bar: '2 µm', instrument: 'JEOL' }, ...over })], opts);
		const btn = thumbButton('9ab3c4d5_B2.tif')!;
		show(btn);
		await vi.waitFor(() => expect(btn.querySelector('img')).not.toBeNull());
		btn.focus();
		btn.click();
		await vi.waitFor(() => expect(dialog()).not.toBeNull());
		return btn;
	};
	const settled = () => vi.waitFor(() => expect(dialog()!.dataset.state).toBe('ready'));

	it('opens on a click with the name, the folder, what was read and the reduced-size line, and shows the preview once it is in', async () => {
		await open();
		const d = dialog()!;
		expect(d.getAttribute('role')).toBe('dialog');
		expect(d.getAttribute('aria-modal')).toBe('true');
		expect(document.getElementById(d.getAttribute('aria-labelledby')!)?.textContent).toBe('9ab3c4d5_B2.tif');
		expect(d.textContent).toContain('Users/ab1cd/sem');
		expect(d.textContent).toContain('15 kV · ×5,000 · 2 µm · JEOL');
		expect(d.querySelector('[data-test="preview-note"]')?.textContent).toBe('Reduced-size preview. The original stays on the share.');
		await settled();
		expect(d.querySelector('[data-test="preview-image"]')?.getAttribute('alt')).toBe('Preview of 9ab3c4d5_B2.tif');
		expect(d.querySelector('[data-test="preview-image"]')?.getAttribute('src')).toMatch(/^blob:/);
		expect(fake.pictureStats.paths.filter((p) => p.endsWith('/preview'))).toHaveLength(1);
		expect(d.querySelector('[data-test="preview-loading"]')).toBeNull();
	});

	it('shows a spinner and the thumbnail (enlarged, behind the spinner) while the preview loads, with no error', async () => {
		const btn = await open({ previewDelayMs: 400 });
		const d = dialog()!;
		expect(d.dataset.state).toBe('loading');
		expect(d.querySelector('[data-test="preview-loading"]')?.textContent).toContain('Loading preview');
		expect(d.querySelector('[data-test="preview-loading"]')?.getAttribute('aria-hidden')).toBe('true');
		await vi.waitFor(() => expect(d.querySelector('[data-test="preview-status"]')?.textContent).toBe('Loading preview…'));
		expect(d.querySelector('[data-test="preview-thumb"]')?.getAttribute('src')).toBe(btn.querySelector('img')!.getAttribute('src'));
		expect(d.querySelector('[data-test="preview-image"]')).toBeNull();
		expect(d.querySelector('[data-test="preview-error"]')).toBeNull();
		await settled();
		expect(d.querySelector('[data-test="preview-thumb"]')).toBeNull();
		expect(d.querySelector('[data-test="preview-loading"]')).toBeNull();
	});

	it('Esc closes it, and focus goes back to the thumbnail', async () => {
		const btn = await open();
		key('Escape');
		await vi.waitFor(() => expect(dialog()).toBeNull());
		await vi.waitFor(() => expect(document.activeElement).toBe(btn));
	});

	it('a click on the backdrop closes it; a click inside does not', async () => {
		const btn = await open();
		dialog()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 10));
		expect(dialog()).not.toBeNull();
		const outside = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		document.querySelector('[data-test="preview-backdrop"]')!.dispatchEvent(outside);
		// the browser's own mousedown would take focus away from where the dialog gives it back
		expect(outside.defaultPrevented).toBe(true);
		await vi.waitFor(() => expect(dialog()).toBeNull());
		await vi.waitFor(() => expect(document.activeElement).toBe(btn));
	});

	it('the Close button closes it and starts with focus; the preview URL is let go, the thumbnail\'s stays with the row', async () => {
		const btn = await open();
		await settled();
		const preview = dialog()!.querySelector('[data-test="preview-image"]')!.getAttribute('src')!;
		const thumb = btn.querySelector('img')!.getAttribute('src')!;
		const close = dialog()!.querySelector<HTMLButtonElement>('[data-test="preview-close"]')!;
		expect(document.activeElement).toBe(close);
		close.click();
		await vi.waitFor(() => expect(dialog()).toBeNull());
		expect(revoked).toContain(preview);
		expect(revoked).not.toContain(thumb);
		await vi.waitFor(() => expect(document.activeElement).toBe(btn));
	});

	it('keeps Tab and Shift+Tab inside the dialog', async () => {
		await open();
		await settled();
		const close = dialog()!.querySelector<HTMLButtonElement>('[data-test="preview-close"]')!;
		close.focus();
		const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		document.dispatchEvent(tab);
		// the only control is Close: Tab has nowhere else to go, and the page behind does not get the focus
		expect(tab.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(close);
		const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
		document.dispatchEvent(back);
		expect(back.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(close);
		// focus that strayed outside is pulled back in
		(document.querySelector('[data-test="inbox-row"] button') as HTMLElement).focus();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
		expect(dialog()!.contains(document.activeElement)).toBe(true);
	});

	it('Retry hands the focus to Close when it goes away, so it does not fall to the page', async () => {
		await open({ previewFails: 1 });
		await vi.waitFor(() => expect(dialog()!.querySelector('[data-test="preview-retry"]')).not.toBeNull());
		const retry = dialog()!.querySelector<HTMLButtonElement>('[data-test="preview-retry"]')!;
		retry.focus();
		retry.click();
		await vi.waitFor(() => expect(dialog()!.querySelector('[data-test="preview-retry"]')).toBeNull());
		expect(document.activeElement).toBe(dialog()!.querySelector('[data-test="preview-close"]'));
		await settled();
		expect(document.activeElement).toBe(dialog()!.querySelector('[data-test="preview-close"]'));
	});

	it('announces loading through one live region that stays in the page, and swaps its text', async () => {
		await open({ previewDelayMs: 150 });
		const status = dialog()!.querySelector('[data-test="preview-status"]')!;
		expect(status.getAttribute('role')).toBe('status');
		expect(dialog()!.querySelectorAll('[role="status"]')).toHaveLength(1);
		await vi.waitFor(() => expect(status.textContent).toBe('Loading preview…'));
		await settled();
		expect(dialog()!.querySelector('[data-test="preview-status"]')).toBe(status);
		await vi.waitFor(() => expect(status.textContent).toBe('Preview ready.'));
	});

	it('a preview that stalls fails after 30 s with Retry, like any other failure', async () => {
		await mount([withThumb('Users/ab1cd/sem/9ab3c4d5_B2.tif')]);
		const btn = thumbButton('9ab3c4d5_B2.tif')!;
		show(btn);
		await vi.waitFor(() => expect(btn.querySelector('img')).not.toBeNull());
		fake.hang(true);
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			btn.click();
			await vi.waitFor(() => expect(dialog()).not.toBeNull());
			await vi.advanceTimersByTimeAsync(29_000);
			expect(dialog()!.dataset.state).toBe('loading');
			await vi.advanceTimersByTimeAsync(1_500);
			await vi.waitFor(() => expect(dialog()!.querySelector('[data-test="preview-error"]')).not.toBeNull());
			expect(dialog()!.querySelector('[data-test="preview-retry"]')).not.toBeNull();
			expect(dialog()!.querySelector('[data-test="preview-status"]')?.textContent).toBe('');
		} finally {
			vi.useRealTimers();
		}
	});

	it('a failed preview says so with Retry, keeps Tab inside across both buttons, and Retry loads it', async () => {
		await open({ previewFails: 1 });
		await vi.waitFor(() => expect(dialog()!.querySelector('[data-test="preview-error"]')).not.toBeNull());
		const d = dialog()!;
		expect(d.querySelector('[data-test="preview-error"]')?.textContent).toContain('The preview could not be loaded.');
		expect(d.querySelector('[data-test="preview-loading"]')).toBeNull();
		expect(d.querySelector('[data-test="preview-note"]')).not.toBeNull();
		const retry = d.querySelector<HTMLButtonElement>('[data-test="preview-retry"]')!;
		const close = d.querySelector<HTMLButtonElement>('[data-test="preview-close"]')!;
		close.focus();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
		expect(document.activeElement).toBe(retry);
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
		expect(document.activeElement).toBe(close);
		retry.click();
		await settled();
		expect(dialog()!.querySelector('[data-test="preview-image"]')?.getAttribute('src')).toMatch(/^blob:/);
		expect(dialog()!.querySelector('[data-test="preview-error"]')).toBeNull();
		expect(fake.pictureStats.paths.filter((p) => p.endsWith('/preview'))).toHaveLength(2);
	});
});
