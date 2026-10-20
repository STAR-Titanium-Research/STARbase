// @vitest-environment happy-dom
// The Inbox's pictures, behaviourally, against the fake d1-inbox: the thumbnail in a row (only for a file with has_thumbnail, only once the row is near
// the screen, a few at a time, a shimmer while it loads, the icon when it fails) and the object URLs being let go. The full preview now lives on the view
// box page (ViewBox, inboxFilePage.dom.test.ts).
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
const thumbPaths = () => fake.pictureStats.paths.filter((p) => p.endsWith('/thumb'));

const withThumb = (rel: string, over: Partial<FoundFile> = {}) => exactMatch({ rel_path: rel, has_thumbnail: true, ...over });

beforeEach(() => {
	document.body.innerHTML = '';
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
