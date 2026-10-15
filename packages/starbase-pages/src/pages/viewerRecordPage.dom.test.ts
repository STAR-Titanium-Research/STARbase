// @vitest-environment happy-dom
// A record page for a Lab Viewer (migration 185): it reads everything and changes nothing, so the page offers no Edit, even when Directus's
// item-permissions endpoint says yes (the test makes it say yes: a real viewer's answer is no, and a test that leaned on that answer would pass
// without the viewer rule). The same page for a member is the control: Edit is there.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { setExplorerHostFactory } from '@d1/ui';
import { setPageFrame } from '../frame';
import SamplePage from './SamplePage.vue';
import ToolingPage from './tooling/ToolingPage.vue';

const SAMPLE = '00000000-0000-4000-8000-000000000001';
const BOX = '00000000-0000-4000-8000-0000000000b1';

// the 3D stage is WebGL: not part of what is tested here
vi.mock('./tooling/stage/ToolingStage.vue', () => ({ default: { render: () => null } }));

function fakeApi() {
	return {
		get: vi.fn(async (url: string) => {
			if (url === `/items/physical_samples/${SAMPLE}`) return { data: { data: { sample_id: SAMPLE, sample_code: 'SM-001', nickname: 'Bar A', form: 'bar' } } };
			if (url === `/items/tool_boxes/${BOX}`) {
				return { data: { data: { tool_box_id: BOX, tool_box_code: 'TB-1', description: 'Box', insert_type_id: { insert_type_id: 'it1', type_code: 'CNMG' } } } };
			}
			if (url.startsWith('/permissions/me/')) return { data: { data: { update: { access: true }, delete: { access: true }, share: { access: true } } } };
			if (url.startsWith('/d1-trace/')) {
				return { data: { sample: { sample_id: SAMPLE, sample_code: 'SM-001', form: 'bar' }, stock_origins: [], ancestors: [], descendants: [], events: [], hidden: { stock_origins: 0, ancestors: 0, events: 0, descendants: 0 }, truncated: {} } };
			}
			return { data: { data: [] } };
		}),
		post: vi.fn(),
		patch: vi.fn(),
		delete: vi.fn(),
	};
}

const Plain = (tag: string) => defineComponent({ inheritAttrs: true, props: { title: String }, setup: (p, { slots }) => () => h(tag, { 'aria-label': p.title, title: p.title }, slots.default?.()) });
const Nothing = defineComponent({ setup: () => () => null });
function registerStubs(app: App) {
	for (const n of ['v-button', 'v-icon', 'v-input', 'v-notice', 'v-progress-circular', 'v-chip']) app.component(n, Plain('button'));
	for (const n of ['v-dialog', 'v-card', 'v-card-title', 'v-card-text', 'v-card-actions', 'v-drawer', 'v-form']) app.component(n, Nothing);
	app.directive('tooltip', {});
}

let app: App | null = null;
let api: ReturnType<typeof fakeApi>;

async function mountPage(viewer: boolean, page: any, props: Record<string, unknown>) {
	window.matchMedia = ((q: string) => ({ matches: q.includes('min-width: 1000px'), addEventListener() {}, removeEventListener() {} })) as any;
	api = fakeApi();
	setExplorerHostFactory(() => ({
		api: api as any, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true),
		canViewAllAccess: ref(viewer), user: ref({ id: 'u-me', role: viewer ? 'r3' : 'r1' }),
	}));
	// the frame draws every slot, so the page's action row is on screen
	setPageFrame(defineComponent({ props: { title: String }, setup: (_p, { slots }) => () => h('div', Object.values(slots).flatMap((s) => (s ? s() : []))) }));
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: Nothing }, { path: '/:pathMatch(.*)*', component: Nothing }] });
	await router.push('/');
	app = createApp({ render: () => h(page, props) });
	app.use(router);
	registerStubs(app);
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	await vi.waitFor(() => expect(document.querySelector('[aria-label="Data Studio"]')).not.toBeNull());
	await nextTick();
}

const editButtons = () => [...document.querySelectorAll('[aria-label="Edit"]')];

beforeEach(() => {
	document.body.innerHTML = '';
});
afterEach(() => {
	app?.unmount();
	app = null;
	setExplorerHostFactory(null);
	setPageFrame(null);
	document.body.innerHTML = '';
});

describe('the Sample page for a Lab Viewer', () => {
	it('offers no Edit (and never asks Directus whether it may), but still offers Who has access and Data Studio', async () => {
		await mountPage(true, SamplePage, { id: SAMPLE });
		expect(editButtons()).toHaveLength(0);
		expect(api.get.mock.calls.some(([url]) => String(url).startsWith('/permissions/me/'))).toBe(false);
		expect(document.querySelector('[aria-label="Who has access"]')).not.toBeNull();
		expect(document.querySelector('[aria-label="Data Studio"]')).not.toBeNull();
	});

	it('the same page for a member is the control: Edit is offered', async () => {
		await mountPage(false, SamplePage, { id: SAMPLE });
		await vi.waitFor(() => expect(editButtons()).toHaveLength(1));
		expect(api.get.mock.calls.some(([url]) => String(url).startsWith('/permissions/me/'))).toBe(true);
	});
});

describe('the Tooling page for a Lab Viewer', () => {
	it('offers no Edit on a tool box (and never asks Directus), where a member gets it', async () => {
		await mountPage(true, ToolingPage, { kind: 'tool-boxes', id: BOX });
		await vi.waitFor(() => expect(document.querySelector('[aria-label="Data Studio"]')).not.toBeNull());
		await nextTick();
		expect(editButtons()).toHaveLength(0);
		expect(api.get.mock.calls.some(([url]) => String(url).startsWith('/permissions/me/'))).toBe(false);
		document.body.innerHTML = '';
		app?.unmount();
		await mountPage(false, ToolingPage, { kind: 'tool-boxes', id: BOX });
		await vi.waitFor(() => expect(editButtons()).toHaveLength(1));
	});
});

describe('RecordActions (the action row of all five record pages) for a Lab Viewer', () => {
	it('hides Edit whatever the page passes in canUpdate, and keeps the reads', async () => {
		const { default: RecordActions } = await import('./RecordActions.vue');
		for (const [viewer, canUpdate, expected] of [[true, true, 0], [true, null, 0], [true, undefined, 0], [false, true, 1], [false, null, 1], [false, false, 0]] as const) {
			document.body.innerHTML = '';
			window.matchMedia = ((q: string) => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any;
			setExplorerHostFactory(() => ({
				api: fakeApi() as any, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true),
				canViewAllAccess: ref(viewer), user: ref(null),
			}));
			const small = createApp({ render: () => h(RecordActions, { canUpdate, studioTo: '/content/x/1' }) });
			registerStubs(small);
			const el = document.createElement('div');
			document.body.appendChild(el);
			small.mount(el);
			await nextTick();
			expect(editButtons(), `viewer ${viewer}, canUpdate ${canUpdate}`).toHaveLength(expected);
			expect(document.querySelector('[aria-label="Who has access"]')).not.toBeNull();
			small.unmount();
		}
	});
});

describe('Home quick actions for a Lab Viewer', () => {
	it('offers Print labels and Scan, and neither Register a sample nor Log an operation; a member gets all four', async () => {
		const { default: QuickActions } = await import('../home/QuickActions.vue');
		for (const [viewer, expected] of [[true, ['Print labels', 'Scan a label']], [false, ['Register a sample', 'Log an operation', 'Print labels', 'Scan a label']]] as const) {
			document.body.innerHTML = '';
			setExplorerHostFactory(() => ({
				api: fakeApi() as any, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true),
				canViewAllAccess: ref(viewer), user: ref(null),
			}));
			const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: Nothing }] });
			const small = createApp({ render: () => h(QuickActions) });
			small.use(router);
			registerStubs(small);
			const el = document.createElement('div');
			document.body.appendChild(el);
			small.mount(el);
			await nextTick();
			const labels = [...document.querySelectorAll('.action')].map((b) => (b.textContent ?? '').trim());
			expect(labels, `viewer ${viewer}`).toEqual(expected);
			small.unmount();
		}
	});
});
