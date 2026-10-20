// @vitest-environment happy-dom
// The view box page (spec 2026-10-20-inbox-file-viewer-design.md decisions 4, 8, 9, 10), against the fake d1-inbox: the detail panel, the stage with the preview and
// the viewer's View rail; "n of m" and previous / next within the filtered list the person came from (and Back going straight to the list); Close keeping the
// filters; Fit / 1:1, the scale bar and the contrast stretch, remembered per person; a file with no picture; a file that is not in the list; and the Inbox
// row's own actions, with their refusals.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, ref, type App } from 'vue';
import { RouterView, createMemoryHistory, createRouter, type Router } from 'vue-router';
import { configureLinks, resetLinks, setExplorerHostFactory, starbaseLinks } from '@d1/ui';
import { setPageFrame } from '../frame';
import InboxFilePage from './InboxFilePage.vue';
import ViewBox from './ViewBox.vue';
import { createFakeInbox, exactMatch, foundFile, type FakeInboxOptions } from './fakeInboxServer';
import type { FoundFile } from './inboxApi';
import { VIEW_KEY } from './useViewSettings';

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
const ListPage = defineComponent({ render: () => h('div', { 'data-test': 'list-page' }) });

/** Mounts the page at `at`, having come from the list (so the browser's Back has somewhere to go). */
async function mount(files: FoundFile[], at: string | ((f: FoundFile[]) => string), opts: FakeInboxOptions = {}) {
	fake = createFakeInbox({ files, ...opts });
	setExplorerHostFactory(() => ({
		api: fake.api, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u-me' }),
	}));
	configureLinks(starbaseLinks('https://d1.example'));
	setPageFrame(defineComponent({ props: { title: String }, setup: (_p, { slots }) => () => h('div', [slots.default?.()]) }));
	router = createRouter({
		history: createMemoryHistory(),
		routes: [{ path: '/inbox', component: ListPage }, { path: '/inbox/file/:candidateId', component: InboxFilePage, props: true }],
	});
	await router.push('/inbox');
	await router.push(typeof at === 'function' ? at(files) : at);
	app = createApp({ render: () => h('div', [h(RouterView)]) });
	app.use(router);
	registerStubs(app);
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
}
const mountReady = async (files: FoundFile[], at: string | ((f: FoundFile[]) => string), opts: FakeInboxOptions = {}) => {
	await mount(files, at, opts);
	await vi.waitFor(() => expect(box()).not.toBeNull());
};

const SEM = { kv: 15, pixel_size_nm: 100, image_width_px: 1000, sources: { kv: 'metadata', pixel_size_nm: 'metadata' }, flags: {} };
const A = 'Users/ab1cd/sem/3fa9c1d2_A1.tif';
const B = 'Users/ab1cd/sem/9ab3c4d5_B2.tif';
const C = 'Users/ab1cd/sem/5cd6e7f8_C3.tif';
const withThumb = (rel: string, over: Partial<FoundFile> = {}) => exactMatch({ rel_path: rel, has_thumbnail: true, extracted: SEM, ...over }, rel.split('/').pop()!.slice(0, 8));
const at = (i: number, query = '') => (fs: FoundFile[]) => `/inbox/file/${fs[i].candidate_id}${query}`;

const box = () => document.querySelector<HTMLElement>('[data-test="view-box"]');
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const text = (sel: string) => q(sel)?.textContent ?? null;
const nameShown = () => text('[data-test="box-name"]');
const key = (k: string, target: Element | Document = document, init: KeyboardEventInit = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const currentId = () => router.currentRoute.value.params.candidateId;
const radio = (label: string) => [...document.querySelectorAll<HTMLElement>('[data-test="rail-zoom"] [role="radio"]')].find((b) => b.textContent === label)!;

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

describe('the page', () => {
	it('shows the detail panel, the stage and the View rail for the file', async () => {
		const files = [withThumb(A, { extracted: { ...SEM, instrument: 'JEOL' } })];
		await mountReady(files, at(0));
		// left: the RecordRail look: kind pill, "Found file", the name in mono, the folder, the icon actions, the facts, the imaging settings, On this page
		const rail = q('[data-test="file-rail"]')!;
		expect(rail.querySelector('.kind')?.textContent).toContain('Possible SEM image');
		expect(text('[data-test="rail-found"]')).toBe('Found file');
		expect(rail.querySelector('h1.code')?.textContent).toBe('3fa9c1d2_A1.tif');
		expect(rail.querySelector('.title')?.textContent).toBe('Users/ab1cd/sem');
		for (const t of ['rail-link', 'rail-dismiss', 'rail-copy']) expect(rail.querySelector(`[data-test="${t}"]`), t).not.toBeNull();
		expect(rail.querySelector('[data-field="kv"]')!.textContent).toContain('15 kV');
		expect([...rail.querySelectorAll('.d1-page-contents .entry .title')].map((e) => e.textContent)).toEqual(['Picture', 'Imaging settings', 'Where it is']);
		// centre: the stage, with the preview and a scale bar (100 nm x 1000 px = 100 µm wide: a fifth, as a round length)
		expect(nameShown()).toBe('3fa9c1d2_A1.tif');
		await vi.waitFor(() => expect(q('[data-test="box-image"]')?.getAttribute('src')).toMatch(/^blob:/));
		expect(text('[data-test="box-scalebar"]')).toContain('20 µm');
		expect(text('[data-test="box-note"]')).toBe('Reduced-size preview. The original stays on the share.');
		expect(q('#where')?.textContent).toContain('Users/ab1cd/sem/3fa9c1d2_A1.tif');
		// right: the viewer's View rail: View, Overlay (with Measure) and Compare
		expect(q('[data-test="box-rail"]')).not.toBeNull();
		expect(radio('Fit').getAttribute('aria-checked')).toBe('true');
		expect(q('[data-test="toggle-scalebar"]')).not.toBeNull();
		expect(q('[data-test="toggle-contrast"]')).not.toBeNull();
		// Measure is there (this file says its scale) and Compare is Off: no second pane
		expect(q<HTMLInputElement>('[data-test="toggle-measure"]')!.disabled).toBe(false);
		expect(q('[data-test="compare-stage"]')).toBeNull();
	});

	it('shows "n of m" and previous / next within the list, and moving replaces the address so Back goes to the list', async () => {
		const files = [withThumb(A), withThumb(B), withThumb(C)];
		await mountReady(files, at(1));
		expect(text('[data-test="box-position"]')).toBe('2 of 3');
		const next = q<HTMLButtonElement>('[data-test="box-next"]')!;
		next.click();
		await vi.waitFor(() => expect(currentId()).toBe(files[2].candidate_id));
		await vi.waitFor(() => expect(nameShown()).toBe('5cd6e7f8_C3.tif'));
		expect(text('[data-test="box-position"]')).toBe('3 of 3');
		expect(q<HTMLButtonElement>('[data-test="box-next"]')!.disabled).toBe(true);
		q<HTMLButtonElement>('[data-test="box-prev"]')!.click();
		await vi.waitFor(() => expect(currentId()).toBe(files[1].candidate_id));
		// the arrow keys do the same
		key('ArrowLeft');
		await vi.waitFor(() => expect(currentId()).toBe(files[0].candidate_id));
		expect(q<HTMLButtonElement>('[data-test="box-prev"]')!.disabled).toBe(true);
		key('ArrowLeft'); // nothing before it: nothing happens
		expect(currentId()).toBe(files[0].candidate_id);
		key('ArrowRight');
		await vi.waitFor(() => expect(currentId()).toBe(files[1].candidate_id));
		// three moves and the address was replaced each time: one Back is the list
		router.back();
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/inbox'));
	});

	it('ArrowDown and ArrowUp step like ArrowRight and ArrowLeft, and a text field keeps them', async () => {
		const files = [withThumb(A), withThumb(B), withThumb(C)];
		await mountReady(files, at(1));
		key('ArrowDown');
		await vi.waitFor(() => expect(currentId()).toBe(files[2].candidate_id));
		key('ArrowDown'); // nothing after it
		expect(currentId()).toBe(files[2].candidate_id);
		key('ArrowUp');
		await vi.waitFor(() => expect(currentId()).toBe(files[1].candidate_id));
		const input = document.createElement('input');
		input.type = 'text';
		document.body.appendChild(input);
		key('ArrowUp', input);
		key('ArrowLeft', input);
		await new Promise((r) => setTimeout(r, 20));
		expect(currentId()).toBe(files[1].candidate_id);
	});

	describe('a long list', () => {
		const long = (n: number) => Array.from({ length: n }, (_, i) => foundFile({ kind: 'sem_image', extracted: SEM, rel_path: `Users/ab1cd/sem/img${String(i).padStart(5, '0')}.tif` }));
		const pageAt = (offset: number) => fake.calls.filter((c) => c.path === '/d1-inbox/files' && Number(c.params?.offset) === offset);

		it('Next goes on past the pages read so far: the page after the last row read is fetched, and "n of m" is of the whole list', async () => {
			const files = long(450);
			await mountReady(files, at(198));
			expect(text('[data-test="box-position"]')).toBe('199 of 450');
			key('ArrowRight'); // 199: the last row the first page held
			await vi.waitFor(() => expect(currentId()).toBe(files[199].candidate_id));
			expect(text('[data-test="box-position"]')).toBe('200 of 450');
			expect(q<HTMLButtonElement>('[data-test="box-next"]')!.disabled).toBe(false);
			// asked at once, before the page behind it is in: it waits for that page, then steps on
			key('ArrowRight');
			await vi.waitFor(() => expect(currentId()).toBe(files[200].candidate_id));
			expect(text('[data-test="box-position"]')).toBe('201 of 450');
			expect(pageAt(200).length).toBeGreaterThan(0);
			// and back again, through the rows now in hand
			key('ArrowLeft');
			await vi.waitFor(() => expect(currentId()).toBe(files[199].candidate_id));
		});

		it('the Next button does the same, and the end of the list is the end', async () => {
			const files = long(201);
			await mountReady(files, at(199));
			await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-test="box-next"]')).not.toBeNull());
			q<HTMLButtonElement>('[data-test="box-next"]')!.click();
			await vi.waitFor(() => expect(currentId()).toBe(files[200].candidate_id));
			expect(text('[data-test="box-position"]')).toBe('201 of 201');
			expect(q<HTMLButtonElement>('[data-test="box-next"]')!.disabled).toBe(true);
		});

		it('stops at the 2000-row cap: no Next past the last row the page reads', async () => {
			const files = long(2100);
			await mountReady(files, at(1998));
			key('ArrowRight');
			await vi.waitFor(() => expect(currentId()).toBe(files[1999].candidate_id));
			expect(text('[data-test="box-position"]')).toBe('2000 of 2100');
			expect(q<HTMLButtonElement>('[data-test="box-next"]')!.disabled).toBe(true);
			key('ArrowRight');
			await new Promise((r) => setTimeout(r, 30));
			expect(currentId()).toBe(files[1999].candidate_id);
			expect(pageAt(2000)).toHaveLength(0);
		});
	});

	it('reads the list with the filters in its address: the same files in the same order, "n of m" of that list', async () => {
		const files = [withThumb(A, { kind: 'surface_scan' }), withThumb(B), withThumb(C)];
		await mountReady(files, at(2, '?kind=sem_image'));
		expect(text('[data-test="box-position"]')).toBe('2 of 2');
		expect(q<HTMLButtonElement>('[data-test="box-next"]')!.disabled).toBe(true);
		q<HTMLButtonElement>('[data-test="box-prev"]')!.click();
		await vi.waitFor(() => expect(currentId()).toBe(files[1].candidate_id));
		expect(router.currentRoute.value.query).toEqual({ kind: 'sem_image' }); // the filters ride along
	});

	it('Close goes back to the list with the same filters, and so does Esc', async () => {
		const files = [withThumb(A)];
		await mountReady(files, at(0, '?strength=short_id&folder=sem'));
		const close = q<HTMLAnchorElement>('[data-test="box-close"]')!;
		expect(close.getAttribute('href')).toBe('/inbox?folder=sem&strength=short_id');
		close.click();
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/inbox'));
		expect(router.currentRoute.value.query).toEqual({ folder: 'sem', strength: 'short_id' });
		await router.push(at(0, '?folder=sem')(files));
		await vi.waitFor(() => expect(box()).not.toBeNull());
		key('Escape');
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/inbox'));
		expect(router.currentRoute.value.query).toEqual({ folder: 'sem' });
	});
});

describe('a file that is not there', () => {
	it('says "not found or not visible" for an id the list does not hold, with no stage, no prev / next and no "n of m"', async () => {
		await mount([withThumb(A)], '/inbox/file/c0000000-0000-4000-8000-00000000dead');
		await vi.waitFor(() => expect(q('.d1-not-visible')).not.toBeNull());
		expect(text('.d1-not-visible')).toContain('Not found or not visible to you');
		for (const t of ['view-box', 'box-position', 'box-prev', 'box-next', 'box-rail', 'file-rail']) expect(q(`[data-test="${t}"]`), t).toBeNull();
	});

	it('does the same for a real file the list filters leave out: it never guesses a position', async () => {
		const files = [withThumb(A, { kind: 'surface_scan' }), withThumb(B)];
		await mount(files, at(0, '?kind=sem_image'));
		await vi.waitFor(() => expect(q('.d1-not-visible')).not.toBeNull());
		expect(q('[data-test="box-position"]')).toBeNull();
	});

	it('says so when the list cannot be read', async () => {
		await mount([withThumb(A)], at(0), {});
		await vi.waitFor(() => expect(box()).not.toBeNull());
		app!.unmount();
		document.body.innerHTML = '';
		const failing = createFakeInbox({ files: [withThumb(A)] });
		failing.api.get = (async () => {
			throw Object.assign(new Error('x'), { response: { status: 500, data: { errors: [{ message: 'The server is down.' }] } } });
		}) as any;
		setExplorerHostFactory(() => ({ api: failing.api, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u' }) }));
		app = createApp({ render: () => h('div', [h(RouterView)]) });
		app.use(router);
		registerStubs(app);
		const el = document.createElement('div');
		document.body.appendChild(el);
		app.mount(el);
		await vi.waitFor(() => expect(document.body.textContent).toContain('The server is down.'));
		expect(box()).toBeNull();
	});
});

describe('a file with no picture', () => {
	it('shows its facts and "No preview yet", never a broken image, and a rail with nothing to adjust', async () => {
		const files = [exactMatch({ rel_path: B, has_thumbnail: false, extracted: { kv: 15, sources: { kv: 'metadata' }, flags: {} } }, '9ab3c4d5')];
		await mountReady(files, at(0));
		expect(text('[data-test="box-nopicture"]')).toContain('No preview yet');
		expect(text('[data-test="box-nopicture"]')).toContain('The preview is not made yet.');
		expect(q('[data-test="box-image"]')).toBeNull();
		expect(q('img')).toBeNull();
		expect(fake.pictureStats.requests).toBe(0);
		expect(q('[data-test="rail-nothing"]')).not.toBeNull();
		expect(q('[data-test="rail-zoom"]')).toBeNull();
		expect(q('[data-field="kv"]')!.textContent).toContain('15 kV');
		expect(text('[data-test="box-position"]')).toBe('1 of 1');
	});

	it('says what kind of file a document is, and finds it in the Other files part of the list', async () => {
		const doc = foundFile({ kind: 'document', rel_path: 'Users/ab1cd/notes.pdf' });
		await mountReady([withThumb(A), doc], at(1));
		expect(text('[data-test="box-nopicture"]')).toContain('This kind of file has no preview.');
		expect(text('[data-test="box-position"]')).toBe('1 of 1');
		expect(text('[data-test="rail-found"]')).toBe('Found file');
	});

	it('a preview that fails says so and Retry loads it', async () => {
		await mountReady([withThumb(A)], at(0), { previewFails: 1 });
		await vi.waitFor(() => expect(q('[data-test="box-error"]')).not.toBeNull());
		expect(text('[data-test="box-error"]')).toContain('The preview could not be loaded.');
		q('[data-test="box-retry"]')!.click();
		await vi.waitFor(() => expect(q('[data-test="box-image"]')?.getAttribute('src')).toMatch(/^blob:/));
		expect(fake.pictureStats.paths.filter((p) => p.endsWith('/preview'))).toHaveLength(2);
	});

	it('a preview that stalls fails after 30 s with Retry, like any other failure', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			await mountReady([withThumb(A)], at(0), { pictureHangs: true });
			await vi.advanceTimersByTimeAsync(29_000);
			expect(q('[data-test="box-loading"]')).not.toBeNull();
			await vi.advanceTimersByTimeAsync(1_500);
			await vi.waitFor(() => expect(q('[data-test="box-error"]')).not.toBeNull());
			expect(q('[data-test="box-retry"]')).not.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('Fit, 1:1, the scale bar and the contrast stretch', () => {
	it('1:1 draws the preview at the original width, F goes back to Fit, and the choice is remembered', async () => {
		await mountReady([withThumb(A)], at(0));
		await vi.waitFor(() => expect(q('[data-test="box-image"]')).not.toBeNull());
		expect(box()!.dataset.zoom).toBe('fit');
		expect(q('[data-test="box-image"]')!.style.width).toBe('');
		radio('1:1').click();
		await vi.waitFor(() => expect(box()!.dataset.zoom).toBe('actual'));
		expect(q('[data-test="box-image"]')!.style.width).toBe('1000px');
		expect(JSON.parse(window.localStorage.getItem(VIEW_KEY)!).zoom).toBe('actual');
		// at 1:1 the bar is held to about 150 screen pixels: 100 µm over 1000 px, so a round 10 µm
		expect(text('[data-test="box-scalebar"]')).toContain('10 µm');
		key('F');
		await vi.waitFor(() => expect(box()!.dataset.zoom).toBe('fit'));
		expect(q('[data-test="box-image"]')!.style.width).toBe('');
		expect(JSON.parse(window.localStorage.getItem(VIEW_KEY)!).zoom).toBe('fit');
	});

	it('starts from the stored choices', async () => {
		window.localStorage.setItem(VIEW_KEY, JSON.stringify({ zoom: 'actual', scaleBar: false, contrast: true }));
		await mountReady([withThumb(A)], at(0));
		await vi.waitFor(() => expect(q('[data-test="box-image"]')).not.toBeNull());
		expect(box()!.dataset.zoom).toBe('actual');
		expect(q('[data-test="box-scalebar"]')).toBeNull();
		expect(q('[data-test="box-image"]')!.style.filter).toContain('contrast');
		expect(q<HTMLInputElement>('[data-test="toggle-contrast"]')!.checked).toBe(true);
		expect(q<HTMLInputElement>('[data-test="toggle-scalebar"]')!.checked).toBe(false);
	});

	it('the Scale bar switch hides and shows the bar, Contrast stretch changes only the drawing, and both are remembered', async () => {
		await mountReady([withThumb(A)], at(0));
		await vi.waitFor(() => expect(q('[data-test="box-scalebar"]')).not.toBeNull());
		const bar = q<HTMLInputElement>('[data-test="toggle-scalebar"]')!;
		bar.checked = false;
		bar.dispatchEvent(new Event('change', { bubbles: true }));
		await vi.waitFor(() => expect(q('[data-test="box-scalebar"]')).toBeNull());
		const contrast = q<HTMLInputElement>('[data-test="toggle-contrast"]')!;
		expect(q('[data-test="box-image"]')!.style.filter).toBe('');
		contrast.checked = true;
		contrast.dispatchEvent(new Event('change', { bubbles: true }));
		await vi.waitFor(() => expect(q('[data-test="box-image"]')!.style.filter).toContain('contrast'));
		expect(JSON.parse(window.localStorage.getItem(VIEW_KEY)!)).toMatchObject({ scaleBar: false, contrast: true });
		expect(fake.calls.filter((c) => c.method !== 'get')).toEqual([]); // nothing was written to the server
	});

	it('offers a Scale bar switch only for a file that says its scale', async () => {
		await mountReady([withThumb(A, { extracted: { kv: 15, sources: { kv: 'metadata' }, flags: {} } })], at(0));
		await vi.waitFor(() => expect(q('[data-test="rail-overlay"]')).not.toBeNull());
		expect(q('[data-test="toggle-scalebar"]')).toBeNull();
		expect(q('[data-test="box-scalebar"]')).toBeNull();
		expect(q('[data-test="toggle-contrast"]')).not.toBeNull();
	});

	it('the arrow keys leave a focused radio group alone', async () => {
		const files = [withThumb(A), withThumb(B)];
		await mountReady(files, at(0));
		key('ArrowRight', radio('Fit'));
		key('ArrowDown', radio('Fit'));
		expect(currentId()).toBe(files[0].candidate_id);
	});

	it('F, M and C still work with focus on a segmented control or a rail checkbox (where a click leaves it), but not in a text field', async () => {
		await mountReady([withThumb(A), withThumb(B)], at(0));
		await vi.waitFor(() => expect(q('[data-test="box-image"]')).not.toBeNull());
		radio('1:1').click();
		await vi.waitFor(() => expect(box()!.dataset.zoom).toBe('actual'));
		const typing = document.createElement('input');
		typing.type = 'text';
		document.body.appendChild(typing);
		key('f', typing);
		await new Promise((r) => setTimeout(r, 20));
		expect(box()!.dataset.zoom).toBe('actual');
		// dispatched on the focused control itself, so it bubbles up the way a real key does
		key('f', radio('1:1'));
		await vi.waitFor(() => expect(box()!.dataset.zoom).toBe('fit'));
		const contrast = q<HTMLInputElement>('[data-test="toggle-contrast"]')!;
		key('M', contrast);
		await vi.waitFor(() => expect(q<HTMLInputElement>('[data-test="toggle-measure"]')!.checked).toBe(true));
		key('c', radio('Fit'));
		await vi.waitFor(() => expect(q('[data-test="compare-stage"]')).not.toBeNull());
		key('C', contrast);
		await vi.waitFor(() => expect(q('[data-test="compare-stage"]')).toBeNull());
	});

	it('the rail folds to its tab and the fold is remembered apart from the list\'s', async () => {
		await mountReady([withThumb(A)], at(0));
		q('[data-test="rail-collapse"]')!.click();
		await vi.waitFor(() => expect(q('[data-test="box-rail"]')).toBeNull());
		expect(JSON.parse(window.localStorage.getItem(VIEW_KEY)!)).toMatchObject({ boxRailOpen: false, railOpen: true });
		expect(text('[data-test="rail-expand"]')).toContain('Fit');
	});
});

describe('the Inbox row\'s actions', () => {
	it('Dismiss is the row\'s dismiss, and the page goes on to the next file', async () => {
		const files = [withThumb(A), withThumb(B)];
		await mountReady(files, at(0));
		q('[data-test="rail-dismiss"]')!.click();
		await vi.waitFor(() => expect(currentId()).toBe(files[1].candidate_id));
		expect(fake.calls.some((c) => c.method === 'post' && c.path === '/d1-inbox/dismiss')).toBe(true);
		expect(text('[data-test="notice"]')).toContain('Dismissed 1 found file');
		await vi.waitFor(() => expect(nameShown()).toBe('9ab3c4d5_B2.tif'));
		expect(text('[data-test="box-position"]')).toBe('1 of 1');
		// the last file: back to the list
		q('[data-test="rail-dismiss"]')!.click();
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/inbox'));
	});

	it('Link links the suggested record, with its Undo; a document opens the link dialog instead', async () => {
		const files = [withThumb(A), withThumb(B)];
		await mountReady(files, at(0));
		q('[data-test="rail-link"]')!.click();
		await vi.waitFor(() => expect(currentId()).toBe(files[1].candidate_id));
		expect(fake.calls.some((c) => c.method === 'post' && c.path === '/d1-inbox/link')).toBe(true);
		expect(q('[data-test="undo"]')).not.toBeNull();
		app!.unmount();
		document.body.innerHTML = '';
		const doc = foundFile({ kind: 'document', rel_path: 'Users/ab1cd/notes.pdf' });
		await mountReady([doc], at(0));
		q('[data-test="rail-link"]')!.click();
		await vi.waitFor(() => expect(q('[data-test="link-search"]')).not.toBeNull());
	});

	it('a refusal stays on the page, in the notice, and the file stays (the server decides who may change)', async () => {
		const files = [withThumb(A), withThumb(B)];
		await mountReady(files, at(0), { editable: () => false });
		q('[data-test="rail-link"]')!.click();
		await vi.waitFor(() => expect(text('[data-test="notice"]')).toContain('You can only link a file to a record you can edit.'));
		expect(currentId()).toBe(files[0].candidate_id);
		expect(nameShown()).toBe('3fa9c1d2_A1.tif');
		expect(q<HTMLButtonElement>('[data-test="rail-link"]')!.disabled).toBe(false);
	});

	it('offers neither Link nor Dismiss on Recently linked, and Restore on Dismissed', async () => {
		const linked = withThumb(A, { state: 'linked', link_kind: 'manual', decided_at: '2026-10-12T09:00:00.000Z', linked_label: 'S-0042' });
		await mountReady([linked], at(0, '?tab=linked'));
		expect(q('[data-test="rail-link"]')).toBeNull();
		expect(q('[data-test="rail-dismiss"]')).toBeNull();
		expect(q('[data-test="rail-restore"]')).toBeNull();
		expect(text('#where')).toContain('S-0042');
		app!.unmount();
		document.body.innerHTML = '';
		const dismissed = withThumb(B, { state: 'dismissed', decided_at: '2026-10-12T09:00:00.000Z' });
		await mountReady([dismissed], at(0, '?tab=dismissed'));
		expect(q('[data-test="rail-link"]')).toBeNull();
		q('[data-test="rail-restore"]')!.click();
		await vi.waitFor(() => expect(fake.calls.some((c) => c.path === '/d1-inbox/restore')).toBe(true));
	});

	it('Copy path puts the share path on the clipboard', async () => {
		const writeText = vi.fn(async () => {});
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
		await mountReady([withThumb(A)], at(0));
		q('[data-test="rail-copy"]')!.click();
		await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(A));
		await vi.waitFor(() => expect(q('[data-test="rail-copy"]')!.getAttribute('aria-label')).toBe('Path copied'));
		vi.unstubAllGlobals();
	});
});

describe('the stage on its own', () => {
	it('has no "n of m" and no prev / next when it is not told where the file is', async () => {
		const file = withThumb(A);
		const el = document.createElement('div');
		document.body.appendChild(el);
		fake = createFakeInbox({ files: [file] });
		setExplorerHostFactory(() => ({ api: fake.api, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u' }) }));
		configureLinks(starbaseLinks('https://d1.example'));
		const r = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: ListPage }] });
		await r.push('/inbox');
		app = createApp({ render: () => h(ViewBox, { file, position: null, closeTo: '/inbox', zoom: 'fit', scaleBar: true, contrast: false }) });
		app.use(r);
		registerStubs(app);
		app.mount(el);
		await vi.waitFor(() => expect(q('[data-test="box-image"]')).not.toBeNull());
		for (const t of ['box-position', 'box-prev', 'box-next']) expect(q(`[data-test="${t}"]`), t).toBeNull();
		expect(q('[data-test="box-close"]')).not.toBeNull();
	});
});
