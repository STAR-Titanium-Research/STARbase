// @vitest-environment happy-dom
// Compare and Measure on the view box page (spec 2026-10-20-inbox-file-viewer-design.md decisions 4, 5, 6, 9), against the fake d1-inbox: Measure draws a line and
// reads it in µm, and is disabled with its reason when the file has no scale; the partner is ?with= in the address (read, and written by the picker); two panes, each
// with its label; a partner the person may not see is the lock card; the facts diff marks what differs; Link zoom and pan, Common scale; the C and M keys.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { RouterView, createMemoryHistory, createRouter, type Router } from 'vue-router';
import { configureLinks, resetLinks, setExplorerHostFactory, starbaseLinks } from '@d1/ui';
import { setPageFrame } from '../frame';
import InboxFilePage from './InboxFilePage.vue';
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
	await vi.waitFor(() => expect(box()).not.toBeNull());
}

const SEM = { kv: 15, pixel_size_nm: 100, image_width_px: 1000, working_distance_mm: 8, sources: { kv: 'metadata', pixel_size_nm: 'metadata' }, flags: {} };
const NO_SCALE = { kv: 15, sources: { kv: 'metadata' }, flags: {} };
const A = 'Users/ab1cd/sem/3fa9c1d2_A1.tif';
const B = 'Users/ab1cd/sem/9ab3c4d5_B2.tif';
const C = 'Users/zz9ef/other/5cd6e7f8_C3.tif';
const withThumb = (rel: string, over: Partial<FoundFile> = {}) => exactMatch({ rel_path: rel, has_thumbnail: true, extracted: SEM, ...over }, rel.split('/').pop()!.slice(0, 8));
const idOf = (files: FoundFile[], i: number) => files[i].candidate_id;
const at = (i: number, query = '') => (fs: FoundFile[]) => `/inbox/file/${fs[i].candidate_id}${query}`;
const atWith = (i: number, j: number) => (fs: FoundFile[]) => `/inbox/file/${fs[i].candidate_id}?with=${fs[j].candidate_id}`;

const box = () => document.querySelector<HTMLElement>('[data-test="view-box"]');
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const text = (sel: string) => q(sel)?.textContent ?? null;
const key = (k: string, target: Element | Document = document) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const radio = (section: string, label: string) => qa(`[data-test="${section}"] [role="radio"]`).find((b) => b.textContent === label)!;
const withParam = () => router.currentRoute.value.query.with;
const settings = () => JSON.parse(window.localStorage.getItem(VIEW_KEY) ?? '{}');
const flush = async () => {
	await nextTick();
	await vi.waitFor(() => expect(true).toBe(true));
};

// happy-dom has no layout and no image decoding: the picture is 256 x 192 by itself and is drawn 500 x 375
const RECT = { left: 0, top: 0, right: 500, bottom: 375, width: 500, height: 375, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
function fakeLayout() {
	Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 256 });
	Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => 192 });
	vi.spyOn(HTMLImageElement.prototype, 'getBoundingClientRect').mockReturnValue(RECT);
}
function unfakeLayout() {
	// removing the own property restores happy-dom's getters
	delete (HTMLImageElement.prototype as unknown as Record<string, unknown>).naturalWidth;
	delete (HTMLImageElement.prototype as unknown as Record<string, unknown>).naturalHeight;
}
const pointer = (target: Element, type: string, x: number, y: number) => target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }));
const drag = (target: Element, from: [number, number], to: [number, number]) => {
	pointer(target, 'pointerdown', ...from);
	pointer(target, 'pointermove', ...to);
	pointer(target, 'pointerup', ...to);
};

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

describe('Measure', () => {
	it('is disabled, with the reason as its tooltip, on a file with no pixel size, and the M key does nothing', async () => {
		await mount([withThumb(A, { extracted: NO_SCALE })], at(0));
		await vi.waitFor(() => expect(q('[data-test="box-image"]')?.getAttribute('src')).toMatch(/^blob:/));
		const sw = q<HTMLInputElement>('[data-test="toggle-measure"]')!;
		expect(sw.disabled).toBe(true);
		expect(sw.closest('label')!.getAttribute('title')).toBe('no scale known for this image');
		expect(text('[data-test="measure-why"]')).toBe('no scale known for this image');
		key('m');
		await flush();
		expect(q('[data-test="box-layer"]')).toBeNull();
	});

	it('is disabled when the file knows its pixel size but not how wide the original is', async () => {
		await mount([withThumb(A, { extracted: { pixel_size_nm: 100, sources: {}, flags: {} } })], at(0));
		await vi.waitFor(() => expect(q('[data-test="box-image"]')).not.toBeNull());
		expect(q<HTMLInputElement>('[data-test="toggle-measure"]')!.disabled).toBe(true);
	});

	it('draws a dashed line with a label in µm: the M key turns it on, a drag makes the line, the next drag replaces it', async () => {
		fakeLayout();
		await mount([withThumb(A)], at(0));
		await vi.waitFor(() => expect(q('[data-test="box-image"]')).not.toBeNull());
		expect(q<HTMLInputElement>('[data-test="toggle-measure"]')!.disabled).toBe(false);
		expect(q('[data-test="box-layer"]')).toBeNull();
		key('M');
		await vi.waitFor(() => expect(q('[data-test="box-layer"]')).not.toBeNull());
		expect(q<HTMLInputElement>('[data-test="toggle-measure"]')!.checked).toBe(true);
		const layer = q('[data-test="box-layer"]')!;
		// 250 of 500 screen px = half the picture = 128 of 256 preview px = 500 original px at 100 nm = 50 µm
		drag(layer, [100, 100], [350, 100]);
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('50 µm'));
		expect(q('[data-test="box-line"] line')).not.toBeNull();
		// a second drag replaces it: there is only ever one line
		drag(layer, [0, 0], [500, 0]);
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('100 µm'));
		expect(qa('[data-test="box-measure"]')).toHaveLength(1);
		// a click that does not move is not a line
		drag(layer, [10, 10], [10, 10]);
		await vi.waitFor(() => expect(q('[data-test="box-measure"]')).toBeNull());
		// M again turns it off
		key('m');
		await vi.waitFor(() => expect(q('[data-test="box-layer"]')).toBeNull());
	});

	it('reads the same line the same at 1:1 (the line holds as fractions of the picture)', async () => {
		fakeLayout();
		await mount([withThumb(A)], at(0));
		await vi.waitFor(() => expect(q('[data-test="box-image"]')).not.toBeNull());
		key('m');
		await vi.waitFor(() => expect(q('[data-test="box-layer"]')).not.toBeNull());
		drag(q('[data-test="box-layer"]')!, [0, 0], [250, 0]);
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('50 µm'));
		radio('rail-zoom', '1:1').click();
		await vi.waitFor(() => expect(box()!.dataset.zoom).toBe('actual'));
		expect(text('[data-test="box-measure"]')).toBe('50 µm');
	});

	it('goes when the file changes, and Clear the line clears it', async () => {
		fakeLayout();
		await mount([withThumb(A), withThumb(B)], at(0));
		await vi.waitFor(() => expect(q('[data-test="box-image"]')).not.toBeNull());
		key('m');
		await vi.waitFor(() => expect(q('[data-test="box-layer"]')).not.toBeNull());
		drag(q('[data-test="box-layer"]')!, [0, 0], [250, 0]);
		await vi.waitFor(() => expect(q('[data-test="box-measure"]')).not.toBeNull());
		q('[data-test="clear-line"]')!.click();
		await vi.waitFor(() => expect(q('[data-test="box-measure"]')).toBeNull());
		drag(q('[data-test="box-layer"]')!, [0, 0], [250, 0]);
		await vi.waitFor(() => expect(q('[data-test="box-measure"]')).not.toBeNull());
		q<HTMLButtonElement>('[data-test="box-next"]')!.click();
		await vi.waitFor(() => expect(text('[data-test="box-name"]')).toBe('9ab3c4d5_B2.tif'));
		expect(q('[data-test="box-measure"]')).toBeNull();
	});
});

// The shapes (decision 6): Line | Circle | Polygon. Under fakeLayout the picture is drawn 500 x 375 for a 256 x 192 preview of a 1000 px original at 100 nm per pixel,
// so one screen pixel is 0.2 µm along the width (256 / 500 x 1000 / 256 x 100 / 1000) and 0.2 µm down too (192 / 375 x 1000 / 256 x 0.1 = 0.2 µm).
describe('Measure shapes', () => {
	const layer = () => q('[data-test="box-layer"]')!;
	const click = (at: [number, number]) => {
		pointer(layer(), 'pointerdown', ...at);
		pointer(layer(), 'pointerup', ...at);
	};
	const vertices = () => qa('[data-test="box-vertex"]').length;
	const tool = (label: string) => radio('rail-tool', label);
	async function measuring(files: FoundFile[] = [withThumb(A)]) {
		fakeLayout();
		await mount(files, at(0));
		await vi.waitFor(() => expect(q('[data-test="box-image"]')).not.toBeNull());
		key('m');
		await vi.waitFor(() => expect(layer()).not.toBeNull());
	}
	// the corners of a 200 x 100 screen px rectangle: 40 x 20 µm
	const RECT_CORNERS: Array<[number, number]> = [[100, 100], [300, 100], [300, 200], [100, 200]];

	it('offers Line, Circle and Polygon under Measure, Line first, with a hint for each; the choice is kept per person', async () => {
		await measuring();
		expect(qa('[data-test="rail-tool"] [role="radio"]').map((b) => b.textContent)).toEqual(['Line', 'Circle', 'Polygon']);
		expect(tool('Line').getAttribute('aria-checked')).toBe('true');
		expect(text('[data-test="tool-hint"]')).toBe('Drag a line');
		tool('Circle').click();
		await vi.waitFor(() => expect(text('[data-test="tool-hint"]')).toBe('Drag from the centre to the edge'));
		expect(settings().measureTool).toBe('circle');
		tool('Polygon').click();
		await vi.waitFor(() => expect(text('[data-test="tool-hint"]')).toBe('Click the corners, click the first to close'));
		expect(settings().measureTool).toBe('polygon');
	});

	it('starts on the tool kept last time, and shows no tool control while Measure is off or there is no scale', async () => {
		window.localStorage.setItem(VIEW_KEY, JSON.stringify({ measureTool: 'polygon' }));
		fakeLayout();
		await mount([withThumb(A)], at(0));
		await vi.waitFor(() => expect(q('[data-test="box-image"]')).not.toBeNull());
		expect(q('[data-test="rail-tool"]')).toBeNull(); // Measure is off
		key('m');
		await vi.waitFor(() => expect(tool('Polygon').getAttribute('aria-checked')).toBe('true'));
		app?.unmount();
		document.body.innerHTML = '';
		await mount([withThumb(A, { extracted: NO_SCALE })], at(0));
		await vi.waitFor(() => expect(q('[data-test="box-image"]')).not.toBeNull());
		expect(q('[data-test="rail-tool"]')).toBeNull();
		expect(text('[data-test="measure-why"]')).toBe('no scale known for this image');
	});

	it('keys 1, 2, 3 pick Line, Circle, Polygon while Measure is on, and not in a text field or with Measure off', async () => {
		fakeLayout();
		await mount([withThumb(A)], at(0));
		await vi.waitFor(() => expect(q('[data-test="box-image"]')).not.toBeNull());
		key('2');
		await flush();
		expect(settings().measureTool).toBeUndefined(); // Measure is off: nothing changes
		key('m');
		await vi.waitFor(() => expect(q('[data-test="rail-tool"]')).not.toBeNull());
		key('2');
		await vi.waitFor(() => expect(tool('Circle').getAttribute('aria-checked')).toBe('true'));
		key('3');
		await vi.waitFor(() => expect(tool('Polygon').getAttribute('aria-checked')).toBe('true'));
		key('1', radio('rail-zoom', 'Fit')); // after a click on a rail control the key still works
		await vi.waitFor(() => expect(tool('Line').getAttribute('aria-checked')).toBe('true'));
		const typing = document.createElement('input');
		document.body.appendChild(typing);
		key('3', typing);
		await flush();
		expect(tool('Line').getAttribute('aria-checked')).toBe('true');
		expect(settings().measureTool).toBe('line');
	});

	it('circle: drag from the centre to the edge reads the diameter and the area; the same at 1:1', async () => {
		await measuring();
		tool('Circle').click();
		await vi.waitFor(() => expect(tool('Circle').getAttribute('aria-checked')).toBe('true'));
		// radius 100 screen px = 20 µm: diameter 40 µm, area pi x 20 squared = 1,257 µm²
		drag(layer(), [250, 187], [350, 187]);
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('Ø 40 µm · area 1,257 µm²'));
		expect(q('[data-test="box-line"]')!.dataset.shape).toBe('circle');
		expect(q('[data-test="box-line"] circle')).not.toBeNull();
		expect(qa('[data-test="box-vertex"]')).toHaveLength(2); // the centre and the point on the rim
		radio('rail-zoom', '1:1').click();
		await vi.waitFor(() => expect(box()!.dataset.zoom).toBe('actual'));
		expect(text('[data-test="box-measure"]')).toBe('Ø 40 µm · area 1,257 µm²');
		// a press that does not move is not a circle
		drag(layer(), [10, 10], [10, 10]);
		await vi.waitFor(() => expect(q('[data-test="box-measure"]')).toBeNull());
	});

	it('polygon: click the corners, a click on the first corner closes it; area and perimeter; the next shape replaces it', async () => {
		await measuring();
		tool('Polygon').click();
		await vi.waitFor(() => expect(tool('Polygon').getAttribute('aria-checked')).toBe('true'));
		for (const c of RECT_CORNERS) click(c);
		await vi.waitFor(() => expect(vertices()).toBe(4));
		expect(q('[data-test="box-line"]')!.dataset.shape).toBe('polygon');
		expect(q('[data-test="box-line"] polyline')).not.toBeNull(); // still open: no words yet
		expect(q('[data-test="box-measure"]')).toBeNull();
		click([102, 101]); // within a few pixels of the first corner
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('area 800 µm² · perimeter 120 µm'));
		expect(q('[data-test="box-line"] polygon')).not.toBeNull();
		expect(q('[data-test="box-line"] polyline')).toBeNull();
		expect(vertices()).toBe(4);
		// the next polygon replaces it: its corners show, the old words stay until it is done
		click([10, 10]);
		await vi.waitFor(() => expect(vertices()).toBe(1));
		expect(qa('[data-test="box-measure"]')).toHaveLength(0);
	});

	it('polygon: Enter closes it, a double-click closes it, and two corners are not enough', async () => {
		await measuring();
		key('3');
		await vi.waitFor(() => expect(tool('Polygon').getAttribute('aria-checked')).toBe('true'));
		click(RECT_CORNERS[0]);
		click(RECT_CORNERS[1]);
		key('Enter', document.body);
		await flush();
		expect(vertices()).toBe(2); // fewer than 3 corners: nothing closes
		pointer(layer(), 'dblclick', ...RECT_CORNERS[1]);
		await flush();
		expect(q('[data-test="box-measure"]')).toBeNull();
		click(RECT_CORNERS[2]);
		click(RECT_CORNERS[3]);
		key('Enter', document.body);
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('area 800 µm² · perimeter 120 µm'));
		// a double-click: the two presses on the same spot make one corner, the double-click closes
		click([10, 10]);
		click([60, 10]);
		click([60, 60]);
		click([60, 60]);
		pointer(layer(), 'dblclick', 60, 60);
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('area 50 µm² · perimeter 34.14 µm')); // a right-angled triangle with 50 px (10 µm) legs
	});

	it('polygon: the second press of a double-click (detail 2) adds no corner and starts no new polygon; the double-click closes', async () => {
		await measuring();
		key('3');
		await vi.waitFor(() => expect(tool('Polygon').getAttribute('aria-checked')).toBe('true'));
		const press = (at: [number, number], detail: number) => layer().dispatchEvent(new MouseEvent('pointerdown', { clientX: at[0], clientY: at[1], detail, bubbles: true, cancelable: true }));
		// a double-click away from the first corner: one corner, then the dblclick closes (no duplicate corner)
		press([10, 10], 1);
		press([60, 10], 1);
		press([60, 60], 1);
		press([66, 66], 2); // a few pixels off, so only the detail says it is the second press
		await flush();
		expect(vertices()).toBe(3);
		pointer(layer(), 'dblclick', 60, 60);
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('area 50 µm² · perimeter 34.14 µm'));
		expect(vertices()).toBe(3);
		// a double-click on the first corner of a new polygon: the first press closes it, the second does not begin another
		for (const c of RECT_CORNERS) press(c, 1);
		press([101, 101], 1); // closes
		press([101, 101], 2); // the second press of the double-click
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('area 800 µm² · perimeter 120 µm'));
		expect(vertices()).toBe(4); // the finished polygon only: no one-corner draft
		expect(q('[data-test="box-line"] polygon')).not.toBeNull();
	});

	it('Clear shows whenever a shape is on the picture, also with Measure off, and removes it', async () => {
		await measuring();
		key('1');
		await vi.waitFor(() => expect(tool('Line').getAttribute('aria-checked')).toBe('true'));
		drag(layer(), [0, 0], [250, 0]);
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('50 µm'));
		key('m');
		await vi.waitFor(() => expect(q('[data-test="box-layer"]')).toBeNull());
		expect(text('[data-test="box-measure"]')).toBe('50 µm'); // the shape stays drawn
		expect(q('[data-test="clear-line"]')).not.toBeNull();
		q('[data-test="clear-line"]')!.click();
		await vi.waitFor(() => expect(q('[data-test="box-measure"]')).toBeNull());
		expect(q('[data-test="clear-line"]')).toBeNull();
	});

	it('polygon: Backspace takes the last corner off; an area is the same whichever way round the corners were clicked', async () => {
		await measuring();
		key('3');
		await vi.waitFor(() => expect(tool('Polygon').getAttribute('aria-checked')).toBe('true'));
		for (const c of [...RECT_CORNERS, [400, 300] as [number, number]]) click(c);
		await vi.waitFor(() => expect(vertices()).toBe(5));
		key('Backspace', document.body);
		await vi.waitFor(() => expect(vertices()).toBe(4));
		key('Enter', document.body);
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('area 800 µm² · perimeter 120 µm'));
		// the corners the other way round
		for (const c of [...RECT_CORNERS].reverse()) click(c);
		key('Enter', document.body);
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('area 800 µm² · perimeter 120 µm'));
		// back to nothing: Backspace on the only corner drops the polygon
		click([10, 10]);
		await vi.waitFor(() => expect(vertices()).toBe(1));
		key('Backspace', document.body);
		await vi.waitFor(() => expect(vertices()).toBe(4)); // the finished polygon is back
	});

	it('polygon whose sides cross says "check the outline"', async () => {
		await measuring();
		key('3');
		await vi.waitFor(() => expect(tool('Polygon').getAttribute('aria-checked')).toBe('true'));
		for (const c of [[100, 100], [300, 200], [300, 100], [100, 250]] as Array<[number, number]>) click(c);
		key('Enter', document.body);
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toMatch(/ · check the outline$/));
	});

	it('Esc drops the shape being drawn and keeps the page; with nothing being drawn it still closes the view box', async () => {
		await measuring();
		const here = router.currentRoute.value.fullPath;
		drag(layer(), [0, 0], [250, 0]);
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('50 µm'));
		// a new line is being dragged: Esc puts the finished one back
		pointer(layer(), 'pointerdown', 0, 100);
		pointer(layer(), 'pointermove', 500, 100);
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('100 µm'));
		key('Escape', document.body);
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('50 µm'));
		pointer(layer(), 'pointerup', 500, 100); // the pointer coming up after Esc draws nothing
		await flush();
		expect(text('[data-test="box-measure"]')).toBe('50 µm');
		expect(router.currentRoute.value.fullPath).toBe(here);
		// a polygon half-drawn: Esc drops its corners
		key('3');
		await vi.waitFor(() => expect(tool('Polygon').getAttribute('aria-checked')).toBe('true'));
		click([100, 100]);
		click([200, 100]);
		await vi.waitFor(() => expect(vertices()).toBe(2));
		expect(q('[data-test="box-measure"]')).toBeNull(); // the corners are shown in place of the line while they are being drawn
		key('Escape', document.body);
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('50 µm'));
		expect(router.currentRoute.value.fullPath).toBe(here);
		// nothing being drawn now: Esc is the page's and goes back to the list
		key('Escape', document.body);
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/inbox'));
	});

	it('changing the tool drops a shape half drawn, and the finished shape stays until a new one is drawn', async () => {
		await measuring();
		key('3');
		await vi.waitFor(() => expect(tool('Polygon').getAttribute('aria-checked')).toBe('true'));
		click([100, 100]);
		click([200, 100]);
		await vi.waitFor(() => expect(vertices()).toBe(2));
		key('1');
		await vi.waitFor(() => expect(vertices()).toBe(0));
		drag(layer(), [0, 0], [250, 0]);
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('50 µm'));
		key('2');
		await vi.waitFor(() => expect(tool('Circle').getAttribute('aria-checked')).toBe('true'));
		expect(text('[data-test="box-measure"]')).toBe('50 µm'); // still the line
		drag(layer(), [250, 187], [350, 187]);
		await vi.waitFor(() => expect(text('[data-test="box-measure"]')).toBe('Ø 40 µm · area 1,257 µm²'));
		expect(qa('[data-test="box-measure"]')).toHaveLength(1); // one shape at a time
		q('[data-test="clear-line"]')!.click();
		await vi.waitFor(() => expect(q('[data-test="box-measure"]')).toBeNull());
		expect(vertices()).toBe(0);
	});

	it('Compare: pressing in pane B drops the unfinished polygon in pane A, and the other way round', async () => {
		fakeLayout();
		await mount([withThumb(A), withThumb(B)], atWith(0, 1));
		await vi.waitFor(() => expect(q('[data-test="b-image"]')).not.toBeNull());
		key('m');
		key('3');
		await vi.waitFor(() => expect(q('[data-test="b-layer"]')).not.toBeNull());
		const vtx = (side: string) => qa(`[data-test="${side}-vertex"]`).length;
		const click = (side: string, at: [number, number]) => {
			pointer(q(`[data-test="${side}-layer"]`)!, 'pointerdown', ...at);
			pointer(q(`[data-test="${side}-layer"]`)!, 'pointerup', ...at);
		};
		click('a', [10, 10]);
		click('a', [60, 10]);
		await vi.waitFor(() => expect(vtx('a')).toBe(2));
		click('b', [10, 10]);
		await vi.waitFor(() => expect(vtx('b')).toBe(1));
		expect(vtx('a')).toBe(0); // A's half-drawn polygon is gone
		click('a', [200, 200]);
		await vi.waitFor(() => expect(vtx('a')).toBe(1));
		expect(vtx('b')).toBe(0); // and B's
	});

	it('Compare: each pane keeps its own shape', async () => {
		fakeLayout();
		await mount([withThumb(A), withThumb(B)], atWith(0, 1));
		await vi.waitFor(() => expect(q('[data-test="b-image"]')).not.toBeNull());
		key('m');
		key('2');
		await vi.waitFor(() => expect(q('[data-test="b-layer"]')).not.toBeNull());
		drag(q('[data-test="b-layer"]')!, [250, 187], [350, 187]);
		await vi.waitFor(() => expect(text('[data-test="b-measure"]')).toBe('Ø 40 µm · area 1,257 µm²'));
		expect(q('[data-test="a-measure"]')).toBeNull();
		expect(q('[data-test="a-line"]')).toBeNull();
		drag(q('[data-test="a-layer"]')!, [250, 187], [300, 187]);
		await vi.waitFor(() => expect(text('[data-test="a-measure"]')).toBe('Ø 20 µm · area 314 µm²'));
		expect(q('[data-test="b-measure"]')).toBeNull(); // one shape at a time across the panes
	});
});

describe('Compare', () => {
	it('is Off by default: one picture, no second pane, no diff, and the rail offers Side by side', async () => {
		await mount([withThumb(A), withThumb(B)], at(0));
		expect(q('[data-test="compare-stage"]')).toBeNull();
		expect(q('[data-test="facts-diff"]')).toBeNull();
		expect(radio('rail-compare', 'Off').getAttribute('aria-checked')).toBe('true');
		expect(radio('rail-compare', 'Side by side')).toBeDefined();
		expect(q('[data-test="compare-picker"]')).toBeNull();
	});

	it('?with= shows both pictures side by side, each with its label, even when the stored setting is Off', async () => {
		const files = [withThumb(A), withThumb(B, { extracted: { ...SEM, kv: 20 } })];
		await mount(files, atWith(0, 1));
		await vi.waitFor(() => expect(q('[data-test="compare-stage"]')).not.toBeNull());
		expect(text('[data-test="a-name"]')).toBe('3fa9c1d2_A1.tif');
		await vi.waitFor(() => expect(text('[data-test="b-name"]')).toBe('9ab3c4d5_B2.tif'));
		await vi.waitFor(() => expect(q('[data-test="a-image"]')?.getAttribute('src')).toMatch(/^blob:/));
		await vi.waitFor(() => expect(q('[data-test="b-image"]')?.getAttribute('src')).toMatch(/^blob:/));
		expect(text('[data-test="compare-a"]')).toContain('A');
		expect(text('[data-test="compare-b"]')).toContain('B');
		// each pane has its scale bar
		expect(q('[data-test="a-scalebar"]')).not.toBeNull();
		expect(q('[data-test="b-scalebar"]')).not.toBeNull();
		expect(radio('rail-compare', 'Side by side').getAttribute('aria-checked')).toBe('true');
		// the stored setting was not changed by arriving
		expect(settings().compare ?? 'off').toBe('off');
	});

	it('the facts diff sits under the stage and tints the rows that differ', async () => {
		const files = [withThumb(A), withThumb(B, { extracted: { ...SEM, kv: 20 } })];
		await mount(files, atWith(0, 1));
		await vi.waitFor(() => expect(q('[data-test="facts-diff"]')).not.toBeNull());
		const row = (k: string) => q(`[data-test="facts-diff"] tr[data-row="${k}"]`)!;
		expect(row('kv').getAttribute('data-differs')).toBe('true');
		expect(row('kv').querySelector('[data-col="a"]')!.textContent).toBe('15 kV');
		expect(row('kv').querySelector('[data-col="b"]')!.textContent).toBe('20 kV');
		expect(row('pixel_size_nm').getAttribute('data-differs')).toBe('false');
		expect(text('[data-test="facts-diff"] caption')).toMatch(/differ/);
	});

	it('a partner the person may not see is the lock card: no picture, no name, no facts', async () => {
		const files = [withThumb(A)];
		await mount(files, (fs) => `/inbox/file/${fs[0].candidate_id}?with=00000000-0000-4000-8000-00000000dead`);
		await vi.waitFor(() => expect(q('[data-test="compare-locked"]')).not.toBeNull());
		expect(text('[data-test="compare-locked"]')).toContain("A file from another person's folder");
		expect(q('[data-test="compare-locked"] [data-icon="lock"]')).not.toBeNull();
		expect(q('[data-test="b-image"]')).toBeNull();
		expect(q('[data-test="b-name"]')).toBeNull();
		expect(q('[data-test="facts-diff"]')).toBeNull();
		expect(text('[data-test="compare-b"]')).not.toContain('00000000');
		// the picker shows the lock too, and only Clear
		expect(text('[data-test="picker-locked"]')).toContain("A file from another person's folder");
		expect(q('[data-test="picker-locked"] [data-test="picker-clear"]')).not.toBeNull();
	});

	it('asks for the partner in the list again when it is below what the page read for the open file, and shows it', async () => {
		// 205 files: the open file is the first, the partner the last (past the first page of 200)
		const many = Array.from({ length: 205 }, (_v, i) => withThumb(`Users/ab1cd/sem/${String(i).padStart(8, '0')}_S${i}.tif`));
		await mount(many, (fs) => `/inbox/file/${fs[0].candidate_id}?with=${fs[204].candidate_id}`);
		await vi.waitFor(() => expect(text('[data-test="b-name"]')).toBe('00000204_S204.tif'));
		expect(q('[data-test="compare-locked"]')).toBeNull();
	});

	it('the picker offers the files in the open file\'s folder first, then the rest of the list, never the open file or a document', async () => {
		const files = [withThumb(A), withThumb(B), withThumb(C), foundFile({ kind: 'document', rel_path: 'Users/ab1cd/sem/notes.pdf' })];
		await mount(files, at(0, '?with=' + 'none'));
		await vi.waitFor(() => expect(q('[data-test="compare-picker"]')).not.toBeNull());
		const opts = qa('[data-test="picker-option"]');
		expect(opts.map((o) => o.querySelector('.nm')!.textContent)).toEqual(['9ab3c4d5_B2.tif', '5cd6e7f8_C3.tif']);
		expect(qa('[data-test="compare-picker"] .grp').map((g) => g.textContent)).toEqual(['Same folder1', 'Rest of the list1']);
		expect(opts.map((o) => o.getAttribute('data-id'))).not.toContain(idOf(files, 0));
		// the search narrows by name or path
		const search = q<HTMLInputElement>('[data-test="picker-search"]')!;
		search.value = 'zz9';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		await vi.waitFor(() => expect(qa('[data-test="picker-option"]')).toHaveLength(1));
		expect(text('[data-test="picker-option"] .nm')).toBe('5cd6e7f8_C3.tif');
		search.value = 'nothing like it';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		await vi.waitFor(() => expect(text('[data-test="picker-none"]')).toBe('No file in this list matches.'));
	});

	it('choosing a file in the picker writes it as ?with= (replacing the address) and shows it; Clear removes it', async () => {
		const files = [withThumb(A), withThumb(B), withThumb(C)];
		await mount(files, at(0));
		radio('rail-compare', 'Side by side').click();
		await vi.waitFor(() => expect(q('[data-test="compare-stage"]')).not.toBeNull());
		expect(settings().compare).toBe('side');
		expect(withParam()).toBeUndefined();
		expect(q('[data-test="compare-empty"]')).not.toBeNull();
		qa('[data-test="picker-option"]').find((o) => o.getAttribute('data-id') === idOf(files, 2))!.click();
		await vi.waitFor(() => expect(withParam()).toBe(idOf(files, 2)));
		await vi.waitFor(() => expect(text('[data-test="b-name"]')).toBe('5cd6e7f8_C3.tif'));
		expect(text('[data-test="picker-selected"]')).toContain('5cd6e7f8_C3.tif');
		// replace, not push: one Back leaves the page
		router.back();
		await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/inbox'));
	});

	it('Clear the second file drops ?with= and leaves an empty second pane', async () => {
		const files = [withThumb(A), withThumb(B)];
		await mount(files, atWith(0, 1));
		await vi.waitFor(() => expect(text('[data-test="b-name"]')).toBe('9ab3c4d5_B2.tif'));
		q('[data-test="picker-selected"] [data-test="picker-clear"]')!.click();
		await vi.waitFor(() => expect(withParam()).toBeUndefined());
		await vi.waitFor(() => expect(q('[data-test="compare-empty"]')).not.toBeNull());
		expect(q('[data-test="facts-diff"]')).toBeNull();
	});

	it('Off removes ?with= and the second pane; the C key toggles Compare; the choice is remembered', async () => {
		const files = [withThumb(A), withThumb(B)];
		await mount(files, atWith(0, 1));
		await vi.waitFor(() => expect(q('[data-test="compare-stage"]')).not.toBeNull());
		key('c');
		await vi.waitFor(() => expect(q('[data-test="compare-stage"]')).toBeNull());
		expect(withParam()).toBeUndefined();
		expect(settings().compare).toBe('off');
		key('C');
		await vi.waitFor(() => expect(q('[data-test="compare-stage"]')).not.toBeNull());
		expect(settings().compare).toBe('side');
		radio('rail-compare', 'Off').click();
		await vi.waitFor(() => expect(q('[data-test="compare-stage"]')).toBeNull());
	});

	it('the C and M keys are left alone while typing in the picker\'s search box', async () => {
		await mount([withThumb(A), withThumb(B)], atWith(0, 1));
		await vi.waitFor(() => expect(q('[data-test="picker-search"]')).not.toBeNull());
		key('c', q('[data-test="picker-search"]')!);
		key('m', q('[data-test="picker-search"]')!);
		await flush();
		expect(q('[data-test="compare-stage"]')).not.toBeNull();
		expect(q('[data-test="box-layer"]')).toBeNull();
	});

	it('keeps the partner while moving to the next file', async () => {
		const files = [withThumb(A), withThumb(B), withThumb(C)];
		await mount(files, atWith(0, 2));
		await vi.waitFor(() => expect(text('[data-test="b-name"]')).toBe('5cd6e7f8_C3.tif'));
		q<HTMLButtonElement>('[data-test="box-next"]')!.click();
		await vi.waitFor(() => expect(text('[data-test="a-name"]')).toBe('9ab3c4d5_B2.tif'));
		expect(withParam()).toBe(idOf(files, 2));
		expect(text('[data-test="b-name"]')).toBe('5cd6e7f8_C3.tif');
	});
});

describe('Link zoom and pan, and Common scale', () => {
	it('Link zoom and pan and Common scale are on by default; Fit / 1:1 apply to both panes', async () => {
		await mount([withThumb(A), withThumb(B)], atWith(0, 1));
		await vi.waitFor(() => expect(q('[data-test="a-pane"]')).not.toBeNull());
		expect(q<HTMLInputElement>('[data-test="toggle-link"]')!.checked).toBe(true);
		expect(q<HTMLInputElement>('[data-test="toggle-common"]')!.checked).toBe(true);
		expect(q('[data-test="compare-stage"]')!.dataset.commonScale).toBe('true');
		radio('rail-zoom', '1:1').click();
		await vi.waitFor(() => expect(q('[data-test="a-pane"]')!.dataset.zoom).toBe('actual'));
		expect(q('[data-test="b-pane"]')!.dataset.zoom).toBe('actual');
		// there is one zoom for both panes: no per-pane zoom buttons
		expect(q('[data-test="a-zoom"]')).toBeNull();
	});

	it('unlinked, the panes still share the rail Fit / 1:1 (there are no per-pane zoom buttons); the choice is remembered', async () => {
		await mount([withThumb(A, { extracted: NO_SCALE }), withThumb(B)], atWith(0, 1)); // no shared scale
		await vi.waitFor(() => expect(q('[data-test="b-pane"]')).not.toBeNull());
		q<HTMLInputElement>('[data-test="toggle-link"]')!.click();
		await vi.waitFor(() => expect(settings().linkZoom).toBe(false));
		expect(q('[data-test="a-zoom"]')).toBeNull();
		expect(q('[data-test="b-zoom"]')).toBeNull();
		radio('rail-zoom', '1:1').click();
		await vi.waitFor(() => expect(q('[data-test="b-pane"]')!.dataset.zoom).toBe('actual'));
		expect(q('[data-test="a-pane"]')!.dataset.zoom).toBe('actual');
	});

	it('Common scale is disabled, with a reason, when either file lacks its pixel size', async () => {
		await mount([withThumb(A), withThumb(B, { extracted: NO_SCALE })], atWith(0, 1));
		await vi.waitFor(() => expect(q('[data-test="toggle-common"]')).not.toBeNull());
		const sw = q<HTMLInputElement>('[data-test="toggle-common"]')!;
		expect(sw.disabled).toBe(true);
		expect(sw.checked).toBe(false);
		expect(sw.closest('label')!.getAttribute('title')).toBe('needs the pixel size and width of both files');
		expect(text('[data-test="common-why"]')).toContain('needs the pixel size and width of both files');
		expect(q('[data-test="compare-stage"]')!.dataset.commonScale).toBe('false');
	});

	it('Common scale off: the setting is remembered and the panes stop sharing a scale', async () => {
		await mount([withThumb(A), withThumb(B)], atWith(0, 1));
		await vi.waitFor(() => expect(q('[data-test="toggle-common"]')).not.toBeNull());
		q<HTMLInputElement>('[data-test="toggle-common"]')!.click();
		await vi.waitFor(() => expect(q('[data-test="compare-stage"]')!.dataset.commonScale).toBe('false'));
		expect(settings().commonScale).toBe(false);
	});

	it('the measure line is drawn only in the pane it was dragged in', async () => {
		fakeLayout();
		await mount([withThumb(A), withThumb(B)], atWith(0, 1));
		await vi.waitFor(() => expect(q('[data-test="b-image"]')).not.toBeNull());
		key('m');
		await vi.waitFor(() => expect(q('[data-test="b-layer"]')).not.toBeNull());
		drag(q('[data-test="b-layer"]')!, [0, 0], [250, 0]);
		await vi.waitFor(() => expect(text('[data-test="b-measure"]')).toBe('50 µm'));
		expect(q('[data-test="b-line"]')).not.toBeNull();
		expect(q('[data-test="a-line"]')).toBeNull();
		expect(q('[data-test="a-echo"]')).toBeNull();
		expect(q('[data-test="a-measure"]')).toBeNull();
	});

	it('Measure is off in a pane whose file has no scale, but works in the other', async () => {
		fakeLayout();
		await mount([withThumb(A, { extracted: NO_SCALE }), withThumb(B)], atWith(0, 1));
		await vi.waitFor(() => expect(q('[data-test="b-image"]')).not.toBeNull());
		expect(q<HTMLInputElement>('[data-test="toggle-measure"]')!.disabled).toBe(false); // B has a scale
		key('m');
		await vi.waitFor(() => expect(q('[data-test="b-layer"]')).not.toBeNull());
		// A's layer is there but takes no pointer: a drag on it draws nothing
		drag(q('[data-test="a-layer"]')!, [0, 0], [250, 0]);
		await flush();
		expect(q('[data-test="a-measure"]')).toBeNull();
		drag(q('[data-test="b-layer"]')!, [0, 0], [250, 0]);
		await vi.waitFor(() => expect(text('[data-test="b-measure"]')).toBe('50 µm'));
	});
});
