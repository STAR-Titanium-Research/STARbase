// @vitest-environment happy-dom
// The Measurements list on the view box page (spec 2026-10-20-inbox-file-viewer-design.md decision 6), against the fake d1-inbox: a drawn shape is a draft until Save (the
// rail's button, or Enter), then it is a row "1 Line 50 µm" that can be selected (highlighted on the picture), renamed in place, deleted (after a question) and copied as
// CSV; saved shapes are drawn dimmer than the live one while Measure is on; a person who may only read cannot save; a shape drawn in Compare's second pane is not saved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { RouterView, createMemoryHistory, createRouter, type Router } from 'vue-router';
import { configureLinks, resetLinks, setExplorerHostFactory, starbaseLinks } from '@d1/ui';
import { setPageFrame } from '../frame';
import InboxFilePage from './InboxFilePage.vue';
import { readFileSync } from 'node:fs';
import { createFakeInbox, exactMatch, type FakeInboxOptions } from './fakeInboxServer';
import type { FoundFile, SavedMeasurement } from './inboxApi';

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
	await vi.waitFor(() => expect(q('[data-test="view-box"]')).not.toBeNull());
}

// 1000 px wide original at 100 nm per pixel: 1 original pixel = 0.1 µm. The preview is 256 x 192 by itself and is drawn 500 x 375 (happy-dom has no layout).
const SEM = { kv: 15, pixel_size_nm: 100, image_width_px: 1000, sources: { kv: 'metadata', pixel_size_nm: 'metadata' }, flags: {} };
const NO_SCALE = { kv: 15, sources: { kv: 'metadata' }, flags: {} };
const A = 'Users/ab1cd/sem/3fa9c1d2_A1.tif';
const B = 'Users/ab1cd/sem/9ab3c4d5_B2.tif';
const withThumb = (rel: string, over: Partial<FoundFile> = {}) => exactMatch({ rel_path: rel, has_thumbnail: true, extracted: SEM, ...over }, rel.split('/').pop()!.slice(0, 8));
const at = (i: number, query = '') => (fs: FoundFile[]) => `/inbox/file/${fs[i].candidate_id}${query}`;
const atWith = (i: number, j: number) => (fs: FoundFile[]) => `/inbox/file/${fs[i].candidate_id}?with=${fs[j].candidate_id}`;

const RECT = { left: 0, top: 0, right: 500, bottom: 375, width: 500, height: 375, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
function fakeLayout() {
	Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 256 });
	Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => 192 });
	vi.spyOn(HTMLImageElement.prototype, 'getBoundingClientRect').mockReturnValue(RECT);
}
function unfakeLayout() {
	delete (HTMLImageElement.prototype as unknown as Record<string, unknown>).naturalWidth;
	delete (HTMLImageElement.prototype as unknown as Record<string, unknown>).naturalHeight;
}
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const text = (sel: string) => q(sel)?.textContent ?? null;
const key = (k: string, target: Element | Document = document, init: KeyboardEventInit = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const pointer = (target: Element, type: string, x: number, y: number) => target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }));
const drag = (target: Element, from: [number, number], to: [number, number]) => {
	pointer(target, 'pointerdown', ...from);
	pointer(target, 'pointermove', ...to);
	pointer(target, 'pointerup', ...to);
};
const flush = async () => {
	await nextTick();
	await vi.waitFor(() => expect(true).toBe(true));
};
const rows = () => qa('[data-test="measurement-select"]').map((b) => b.getAttribute('aria-label'));
const saveBtn = () => q<HTMLButtonElement>('[data-test="save-shape"]');
const stored = () => [...fake.measurements.values()].flat();

/** Mounts the first file with Measure on and the layout faked; waits for the (empty or seeded) list. */
async function measuring(files: FoundFile[] = [withThumb(A)], opts: FakeInboxOptions = {}, where: (f: FoundFile[]) => string = at(0)) {
	fakeLayout();
	await mount(files, where, opts);
	await vi.waitFor(() => expect(q('[data-test="box-image"]')).not.toBeNull());
	key('m');
	await vi.waitFor(() => expect(q('[data-test="box-layer"]')).not.toBeNull());
	await vi.waitFor(() => expect(q('[data-test="measurements"]')).not.toBeNull());
	await vi.waitFor(() => expect(q('[data-test="measurements-loading"]')).toBeNull());
}
const layer = () => q('[data-test="box-layer"]')!;
// 250 of 500 screen px = half the picture... here: 100 -> 350 is 250 screen px = 128 preview px = 500 original px = 50 µm; at y = 100 of 375: 0.2667 x 1000 x 0.75 = 200 original px
const drawLine = (from: [number, number] = [100, 100], to: [number, number] = [350, 100]) => drag(layer(), from, to);
const seed = (over: Partial<SavedMeasurement> = {}): SavedMeasurement => ({
	measurement_id: 'a0000001-0000-4000-8000-000000000000', kind: 'line', points: [{ x: 0, y: 0 }, { x: 2120, y: 0 }], label: '', created_at: '2026-10-22T09:00:00.000Z',
	author_name: 'Ann Lee', can_edit: true, ...over,
});
const withSeed = (file: FoundFile, list: SavedMeasurement[]): FakeInboxOptions => ({ measurements: { [file.candidate_id]: list } });

beforeEach(() => {
	document.body.innerHTML = '';
	window.localStorage.clear();
});
afterEach(() => {
	app?.unmount();
	app = null;
	resetLinks();
	setExplorerHostFactory(null);
	unfakeLayout();
	vi.restoreAllMocks();
	window.localStorage.clear();
});

describe('the list', () => {
	it('shows what was saved on the file as "1 Line 212 µm", "2 Circle Ø 88 µm", "3 Polygon 12,400 µm²", in saving order', async () => {
		const file = withThumb(A);
		const list = [
			seed({ measurement_id: 'a0000003-0000-4000-8000-000000000000', kind: 'polygon', created_at: '2026-10-22T09:00:03.000Z', points: [{ x: 0, y: 0 }, { x: 1240, y: 0 }, { x: 1240, y: 1000 }, { x: 0, y: 1000 }] }),
			seed(),
			seed({ measurement_id: 'a0000002-0000-4000-8000-000000000000', kind: 'circle', created_at: '2026-10-22T09:00:02.000Z', points: [{ x: 0, y: 0 }, { x: 440, y: 0 }] }),
		];
		await measuring([file], withSeed(file, list));
		await vi.waitFor(() => expect(rows()).toEqual(['1 Line 212 µm', '2 Circle Ø 88 µm', '3 Polygon 12,400 µm²']));
		expect(fake.calls.filter((c) => c.path.endsWith('/measurements')).map((c) => c.method)).toEqual(['get']);
	});

	it('says there is nothing saved yet, and shows the section only for a picture with a scale', async () => {
		await measuring();
		expect(text('[data-test="measurements-empty"]')).toMatch(/Nothing saved yet/);
		unfakeLayout();
		app?.unmount();
		document.body.innerHTML = '';
		await mount([withThumb(A, { extracted: NO_SCALE })], at(0));
		await vi.waitFor(() => expect(q('[data-test="box-image"]')).not.toBeNull());
		expect(q('[data-test="rail-measurements"]')).toBeNull();
		expect(q<HTMLInputElement>('[data-test="toggle-measure"]')!.disabled).toBe(true);
	});

	it('does not read the list for a file with no picture', async () => {
		await mount([withThumb(A, { has_thumbnail: false })], at(0));
		await flush();
		expect(fake.calls.some((c) => c.path.endsWith('/measurements'))).toBe(false);
	});

	it('says why the list could not be read and tries again; the picture goes on working', async () => {
		const file = withThumb(A);
		await mount([file], at(0), { measureFails: true });
		await vi.waitFor(() => expect(q('[data-test="box-image"]')).not.toBeNull());
		key('m');
		await vi.waitFor(() => expect(text('[data-test="measurements-error"]')).toBe('Something went wrong on the server.'));
		expect(q('[data-test="box-layer"]')).not.toBeNull();
		const before = fake.calls.length;
		q('[data-test="measurements-retry"]')!.click();
		await vi.waitFor(() => expect(fake.calls.length).toBeGreaterThan(before));
	});
});

describe('Save', () => {
	it('a drawn shape is a draft: it is on the picture with its size, nothing is kept and the list is empty until Save', async () => {
		await measuring();
		drawLine();
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('50 µm'));
		await vi.waitFor(() => expect(saveBtn()).not.toBeNull());
		expect(rows()).toEqual([]);
		expect(stored()).toHaveLength(0);
		expect(fake.calls.some((c) => c.method === 'post')).toBe(false);
	});

	it('Save keeps it: unit-free (corners in original pixels), as a row, the draft goes, the saved shape stays on the picture, selected', async () => {
		await measuring();
		drawLine();
		await vi.waitFor(() => expect(saveBtn()).not.toBeNull());
		saveBtn()!.click();
		await vi.waitFor(() => expect(rows()).toEqual(['1 Line 50 µm']));
		expect(stored()).toHaveLength(1);
		const body = fake.calls.find((c) => c.method === 'post')!.body as { kind: string; points: Array<{ x: number; y: number }>; label?: string };
		expect(body.kind).toBe('line');
		expect(body.points.map((p) => [Math.round(p.x), Math.round(p.y)])).toEqual([[200, 200], [700, 200]]);
		expect(Object.keys(body).some((k) => /um|micro/i.test(k))).toBe(false);
		// the draft is gone, the saved shape is drawn, and is the selected one (full strength)
		expect(q('[data-test="box-line"]')).toBeNull();
		expect(q('[data-test="box-measure"]')).toBeNull();
		expect(saveBtn()).toBeNull();
		const shapes = qa('[data-test="box-kept-shape"]');
		expect(shapes).toHaveLength(1);
		expect(shapes[0].dataset.shape).toBe('line');
		expect(shapes[0].dataset.selected).toBe('true');
		expect(text('[data-test="box-kept-tag"]')).toBe('1 · 50 µm');
	});

	it('Enter saves the shape just drawn; a second shape is the next row; Enter with nothing drawn does nothing', async () => {
		await measuring();
		key('Enter');
		await flush();
		expect(fake.calls.some((c) => c.method === 'post')).toBe(false);
		drawLine();
		await vi.waitFor(() => expect(saveBtn()).not.toBeNull());
		key('Enter');
		await vi.waitFor(() => expect(rows()).toEqual(['1 Line 50 µm']));
		drawLine([0, 200], [500, 200]);
		await vi.waitFor(() => expect(saveBtn()).not.toBeNull());
		key('Enter');
		await vi.waitFor(() => expect(rows()).toEqual(['1 Line 50 µm', '2 Line 100 µm']));
	});

	it('a polygon: Enter closes it, and the next Enter saves it', async () => {
		await measuring();
		key('3');
		await vi.waitFor(() => expect(q('[data-test="tool-hint"]')?.textContent).toMatch(/corners/));
		for (const c of [[100, 100], [300, 100], [300, 200], [100, 200]]) {
			pointer(layer(), 'pointerdown', c[0], c[1]);
			pointer(layer(), 'pointerup', c[0], c[1]);
		}
		key('Enter');
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('area 800 µm² · perimeter 120 µm'));
		expect(stored()).toHaveLength(0); // that Enter closed it; it did not also save it
		key('Enter');
		await vi.waitFor(() => expect(rows()).toEqual(['1 Polygon 800 µm²']));
		expect((fake.calls.find((c) => c.method === 'post')!.body as { kind: string }).kind).toBe('polygon');
	});

	it('Enter on a button, a link or a field is theirs: it does not also save', async () => {
		await measuring();
		drawLine();
		await vi.waitFor(() => expect(saveBtn()).not.toBeNull());
		key('Enter', q('[data-test="toggle-contrast"]')!);
		key('Enter', q('[data-test="clear-line"]')!);
		key('Enter', q('[data-test="rail-collapse"]')!);
		await flush();
		expect(stored()).toHaveLength(0);
		expect(fake.calls.some((c) => c.method === 'post')).toBe(false);
		key('Enter', q('[data-test="box-layer"]')!);
		await vi.waitFor(() => expect(stored()).toHaveLength(1));
	});

	it('does not save twice when Enter is held (a repeat), or while a save is under way', async () => {
		await measuring();
		drawLine();
		await vi.waitFor(() => expect(saveBtn()).not.toBeNull());
		key('Enter', document, { repeat: true });
		await flush();
		expect(stored()).toHaveLength(0);
		key('Enter');
		key('Enter');
		await vi.waitFor(() => expect(rows()).toHaveLength(1));
		await flush();
		expect(fake.calls.filter((c) => c.method === 'post')).toHaveLength(1);
	});

	it('Clear drops the draft without saving it; Esc does too, and saved shapes stay', async () => {
		const file = withThumb(A);
		await measuring([file], withSeed(file, [seed()]));
		await vi.waitFor(() => expect(rows()).toHaveLength(1));
		drawLine();
		await vi.waitFor(() => expect(saveBtn()).not.toBeNull());
		q('[data-test="clear-line"]')!.click();
		await vi.waitFor(() => expect(q('[data-test="box-measure"]')).toBeNull());
		expect(saveBtn()).toBeNull();
		expect(stored()).toHaveLength(1);
		expect(qa('[data-test="box-kept-shape"]')).toHaveLength(1);
	});

	it('a save the server refuses says why in the rail, keeps the draft and the list', async () => {
		await measuring();
		drawLine();
		await vi.waitFor(() => expect(saveBtn()).not.toBeNull());
		for (let i = 0; i < 200; i++) fake.measurements.set(`x${i}`, []); // (other files: no effect)
		const id = router.currentRoute.value.params.candidateId as string;
		fake.measurements.set(id, Array.from({ length: 200 }, (_, i) => seed({ measurement_id: `b${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`, created_at: `2026-10-22T09:00:00.${String(i).padStart(3, '0')}Z` })));
		saveBtn()!.click();
		await vi.waitFor(() => expect(text('[data-test="measurements-problem"]')).toMatch(/at most 200/));
		expect(q('[data-test="box-line"]')).not.toBeNull(); // the draft is still there to try again
		expect(saveBtn()).not.toBeNull();
	});
});

describe('a person who may only read', () => {
	it('sees the shapes but has no Save and is told why; the rows they did not make have no pencil or bin', async () => {
		const file = withThumb(A);
		await measuring([file], { ...withSeed(file, [seed({ can_edit: false })]), measureReadOnly: true });
		await vi.waitFor(() => expect(rows()).toEqual(['1 Line 212 µm']));
		expect(q('[data-test="measurement-rename"]')).toBeNull();
		expect(q('[data-test="measurement-delete"]')).toBeNull();
		drawLine();
		await vi.waitFor(() => expect(text('[data-test="save-why"]')).toBe('Only the owner of the file can save measurements on it.'));
		expect(saveBtn()).toBeNull();
		key('Enter');
		await flush();
		expect(fake.calls.some((c) => c.method === 'post')).toBe(false);
		expect(q('[data-test="box-measure"]')).not.toBeNull(); // the draft still reads
	});
});

describe('selecting, renaming, deleting, copying', () => {
	const three = (file: FoundFile) => withSeed(file, [
		seed(),
		seed({ measurement_id: 'a0000002-0000-4000-8000-000000000000', kind: 'circle', created_at: '2026-10-22T09:00:02.000Z', points: [{ x: 0, y: 0 }, { x: 440, y: 0 }], label: 'pore, big' }),
		seed({ measurement_id: 'a0000003-0000-4000-8000-000000000000', created_at: '2026-10-22T09:00:03.000Z', can_edit: false, points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] }),
	]);

	it('a row highlights its shape on the picture; the shapes are dimmer than the live one; another click lets go; the selection goes with the file', async () => {
		const file = withThumb(A);
		await measuring([file], three(file));
		await vi.waitFor(() => expect(rows()).toHaveLength(3));
		const shapes = () => qa('[data-test="box-kept-shape"]');
		expect(shapes().map((s) => s.dataset.selected)).toEqual(['false', 'false', 'false']);
		expect(shapes().map((s) => s.dataset.shape)).toEqual(['line', 'circle', 'line']);
		expect(qa('[data-test="box-kept-tag"]').map((t) => t.textContent)).toEqual(['1', '2', '3']);
		qa('[data-test="measurement-select"]')[1].click();
		await vi.waitFor(() => expect(shapes().map((s) => s.dataset.selected)).toEqual(['false', 'true', 'false']));
		expect(qa('[data-test="measurement-select"]')[1].getAttribute('aria-pressed')).toBe('true');
		expect(text('[data-test="box-kept-tag"][data-id="a0000002-0000-4000-8000-000000000000"]')).toBe('2 · Ø 88 µm');
		qa('[data-test="measurement-select"]')[0].click();
		await vi.waitFor(() => expect(shapes().map((s) => s.dataset.selected)).toEqual(['true', 'false', 'false']));
		qa('[data-test="measurement-select"]')[0].click();
		await vi.waitFor(() => expect(shapes().map((s) => s.dataset.selected)).toEqual(['false', 'false', 'false']));
		// a live draft is drawn too, on top of them
		drawLine();
		await vi.waitFor(() => expect(q('[data-test="box-line"]')).not.toBeNull());
		expect(shapes()).toHaveLength(3);
	});

	it('saved shapes are drawn only while Measure is on', async () => {
		const file = withThumb(A);
		await measuring([file], three(file));
		await vi.waitFor(() => expect(qa('[data-test="box-kept-shape"]')).toHaveLength(3));
		key('m');
		await vi.waitFor(() => expect(q('[data-test="box-layer"]')).toBeNull());
		expect(qa('[data-test="box-kept-shape"]')).toHaveLength(0);
		expect(rows()).toHaveLength(3); // the list is still there
	});

	it('the pencil renames in place: Enter keeps it (the row and the server), Esc drops the change, an empty name goes back to the kind', async () => {
		const file = withThumb(A);
		await measuring([file], three(file));
		await vi.waitFor(() => expect(rows()).toHaveLength(3));
		qa('[data-test="measurement-rename"]')[0].click();
		await vi.waitFor(() => expect(q('[data-test="rename-input"]')).not.toBeNull());
		const input = q<HTMLInputElement>('[data-test="rename-input"]')!;
		expect(input.value).toBe('');
		input.value = '  grain A ';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		key('Enter', input);
		await vi.waitFor(() => expect(rows()[0]).toBe('1 grain A 212 µm'));
		expect(stored().find((m) => m.measurement_id === 'a0000001-0000-4000-8000-000000000000')!.label).toBe('grain A');
		expect(fake.calls.find((c) => c.method === 'patch')!.body).toEqual({ label: 'grain A' });
		// Esc: the page stays (Esc in a field is the field's), nothing is sent
		const patches = () => fake.calls.filter((c) => c.method === 'patch').length;
		qa('[data-test="measurement-rename"]')[0].click();
		await vi.waitFor(() => expect(q('[data-test="rename-input"]')).not.toBeNull());
		const again = q<HTMLInputElement>('[data-test="rename-input"]')!;
		expect(again.value).toBe('grain A');
		again.value = 'nope';
		again.dispatchEvent(new Event('input', { bubbles: true }));
		key('Escape', again);
		await vi.waitFor(() => expect(q('[data-test="rename-input"]')).toBeNull());
		expect(rows()[0]).toBe('1 grain A 212 µm');
		expect(patches()).toBe(1);
		expect(router.currentRoute.value.path).toMatch(/\/inbox\/file\//);
		// an empty name is no name
		qa('[data-test="measurement-rename"]')[0].click();
		await vi.waitFor(() => expect(q('[data-test="rename-input"]')).not.toBeNull());
		const blank = q<HTMLInputElement>('[data-test="rename-input"]')!;
		blank.value = '   ';
		blank.dispatchEvent(new Event('input', { bubbles: true }));
		key('Enter', blank);
		await vi.waitFor(() => expect(rows()[0]).toBe('1 Line 212 µm'));
		// no change is no request
		qa('[data-test="measurement-rename"]')[0].click();
		await vi.waitFor(() => expect(q('[data-test="rename-input"]')).not.toBeNull());
		key('Enter', q('[data-test="rename-input"]')!);
		await flush();
		expect(patches()).toBe(2);
	});

	it('a shape the person may not change has no pencil or bin; the others do', async () => {
		const file = withThumb(A);
		await measuring([file], three(file));
		await vi.waitFor(() => expect(rows()).toHaveLength(3));
		expect(qa('[data-test="measurement-rename"]')).toHaveLength(2);
		expect(qa('[data-test="measurement-delete"]')).toHaveLength(2);
		expect(qa('[data-test="measurement-select"]')[2].getAttribute('title')).toBe('Saved by Ann Lee');
	});

	it('the bin asks first: Keep leaves it, Delete removes it from the list, the picture and the server; the numbers close up', async () => {
		const file = withThumb(A);
		await measuring([file], three(file));
		await vi.waitFor(() => expect(rows()).toHaveLength(3));
		qa('[data-test="measurement-delete"]')[0].click();
		await vi.waitFor(() => expect(q('[data-test="measurement-confirm"]')).not.toBeNull());
		expect(text('[data-test="measurement-confirm"]')).toMatch(/Delete "1 Line 212 µm"\?/);
		q('[data-test="measurement-delete-no"]')!.click();
		await vi.waitFor(() => expect(q('[data-test="measurement-confirm"]')).toBeNull());
		expect(rows()).toHaveLength(3);
		expect(fake.calls.some((c) => c.method === 'delete')).toBe(false);
		qa('[data-test="measurement-delete"]')[0].click();
		await vi.waitFor(() => expect(q('[data-test="measurement-delete-yes"]')).not.toBeNull());
		q('[data-test="measurement-delete-yes"]')!.click();
		await vi.waitFor(() => expect(rows()).toEqual(['1 pore, big Ø 88 µm', '2 Line 100 µm']));
		expect(stored().map((m) => m.measurement_id)).not.toContain('a0000001-0000-4000-8000-000000000000');
		expect(qa('[data-test="box-kept-shape"]')).toHaveLength(2);
	});

	it('Copy CSV puts the list on the clipboard: a header, a row per shape, plain numbers, the label quoted; the button says Copied for a moment', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
		const file = withThumb(A);
		await measuring([file], three(file));
		await vi.waitFor(() => expect(rows()).toHaveLength(3));
		q('[data-test="copy-csv"]')!.click();
		await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText.mock.calls[0][0]).toBe([
			'n,label,kind,length_um,diameter_um,perimeter_um,area_um2',
			'1,,line,212,,,',
			'2,"pore, big",circle,,88,276.46,6082.12',
			'3,,line,100,,,',
			'',
		].join('\n'));
		await vi.waitFor(() => expect(text('[data-test="copy-csv"]')).toBe('Copied'));
	});

	it('a clipboard that refuses is said in the page\'s notice, not thrown', async () => {
		Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
		const file = withThumb(A);
		await measuring([file], three(file));
		await vi.waitFor(() => expect(rows()).toHaveLength(3));
		q('[data-test="copy-csv"]')!.click();
		await vi.waitFor(() => expect(text('[data-test="notice"]')).toMatch(/Could not copy the measurements/));
		expect(text('[data-test="copy-csv"]')).toBe('Copy CSV');
	});

	it('each file has its own list: moving on shows the next file\'s shapes, and none of the last file\'s', async () => {
		const a = withThumb(A);
		const b = withThumb(B);
		fakeLayout();
		await mount([a, b], at(0), { measurements: { [a.candidate_id]: [seed()], [b.candidate_id]: [seed({ measurement_id: 'a0000009-0000-4000-8000-000000000000', kind: 'circle', points: [{ x: 0, y: 0 }, { x: 440, y: 0 }] }), seed({ measurement_id: 'a0000008-0000-4000-8000-000000000000', created_at: '2026-10-22T09:30:00.000Z', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] })] } });
		await vi.waitFor(() => expect(q('[data-test="box-image"]')).not.toBeNull());
		key('m');
		await vi.waitFor(() => expect(rows()).toEqual(['1 Line 212 µm']));
		qa('[data-test="measurement-select"]')[0].click();
		await vi.waitFor(() => expect(qa('[data-test="box-kept-shape"]')[0]?.dataset.selected).toBe('true'));
		expect(qa('[data-test="box-kept-tag"]')[0]?.dataset.selected).toBe('true'); // the number pill follows its outline
		expect(qa('[data-test="box-kept-tag"]')[0]?.classList.contains('sel')).toBe(true);
		q('[data-test="box-next"]')!.click();
		await vi.waitFor(() => expect(rows()).toEqual(['1 Circle Ø 88 µm', '2 Line 1 µm']));
		expect(qa('[data-test="box-kept-shape"]').map((s) => s.dataset.selected)).toEqual(['false', 'false']);
	});
});

describe('saved shape pills', () => {
	it('are dimmed like their outlines and the selected one is at full strength (the .sel treatment, tokens only)', () => {
		const source = readFileSync('src/inbox/ViewPane.vue', 'utf8');
		const css = source.slice(source.indexOf('<style'));
		expect(css).toMatch(/\.kept g \{ opacity: 0\.55; \}/);
		expect(css).toMatch(/\.pill\.tag \{ opacity: 0\.55; \}/);
		expect(css).toMatch(/\.pill\.tag\.sel \{ opacity: 1; \}/);
	});
});

describe('Compare', () => {
	it('shapes are saved on the open file (A): the saved ones are drawn in pane A only, and a shape drawn in pane B cannot be saved, with the reason', async () => {
		const a = withThumb(A);
		const b = withThumb(B);
		fakeLayout();
		await mount([a, b], atWith(0, 1), withSeed(a, [seed()]));
		await vi.waitFor(() => expect(q('[data-test="a-image"]')).not.toBeNull());
		await vi.waitFor(() => expect(q('[data-test="b-image"]')).not.toBeNull());
		key('m');
		await vi.waitFor(() => expect(q('[data-test="a-layer"]')).not.toBeNull());
		await vi.waitFor(() => expect(rows()).toEqual(['1 Line 212 µm']));
		expect(qa('[data-test="a-kept-shape"]')).toHaveLength(1);
		expect(qa('[data-test="b-kept-shape"]')).toHaveLength(0);
		drag(q('[data-test="b-layer"]')!, [100, 100], [350, 100]);
		await vi.waitFor(() => expect(text('[data-test="save-why"]')).toBe('Shapes are saved on the open file (A), not on the second one.'));
		expect(saveBtn()).toBeNull();
		key('Enter');
		await flush();
		expect(fake.calls.some((c) => c.method === 'post')).toBe(false);
		// a shape drawn in pane A saves
		drag(q('[data-test="a-layer"]')!, [100, 100], [350, 100]);
		await vi.waitFor(() => expect(saveBtn()).not.toBeNull());
		saveBtn()!.click();
		await vi.waitFor(() => expect(rows()).toEqual(['1 Line 212 µm', '2 Line 50 µm']));
	});
});
