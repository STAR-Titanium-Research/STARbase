// @vitest-environment happy-dom
// An index page whose rows open the edit drawer (rowTarget 'drawer': manufacturers, tools, equipment, ...) for a Lab Viewer (migration 185). The
// drawer is an editable form with Save (STARbase's host.openEditor), so a viewer's row, and ?open=<key> from the finder, open the record in Data
// Studio instead, where the read-only policy shows it read-only. A member is the control: the editor opens.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { setExplorerHostFactory } from '@d1/ui';
import { setPageFrame } from '../frame';
import IndexRoute from './IndexRoute.vue';

const PK = 'm-1';

function fakeApi() {
	return {
		get: vi.fn(async (url: string) => {
			if (url === '/items/manufacturers') return { data: { data: [{ manufacturer_id: PK, manufacturer_name: 'Acme Tools', country: 'UK' }], meta: { filter_count: 1 } } };
			return { data: { data: [] } };
		}),
		post: vi.fn(),
		patch: vi.fn(),
		delete: vi.fn(),
	};
}

const Plain = (tag: string) => defineComponent({ inheritAttrs: true, setup: (_p, { slots }) => () => h(tag, slots.default?.()) });
const Nothing = defineComponent({ setup: () => () => null });
function registerStubs(app: App) {
	for (const n of ['v-button', 'v-icon', 'v-input', 'v-notice', 'v-progress-circular', 'v-chip']) app.component(n, Plain('span'));
	for (const n of ['v-dialog', 'v-card', 'v-card-title', 'v-card-text', 'v-card-actions', 'v-drawer', 'v-form']) app.component(n, Nothing);
	app.directive('tooltip', {});
}

let app: App | null = null;
let openEditor: ReturnType<typeof vi.fn<(collection: string, id: string) => Promise<'saved' | 'cancelled'>>>;
let openDataStudio: ReturnType<typeof vi.fn<(path: string) => void>>;

async function mountIndex(viewer: boolean, query = '') {
	window.matchMedia = ((q: string) => ({ matches: q.includes('min-width: 1000px'), addEventListener() {}, removeEventListener() {} })) as any;
	openEditor = vi.fn(async (_c: string, _i: string) => 'cancelled' as const);
	openDataStudio = vi.fn((_path: string) => {});
	setExplorerHostFactory(() => ({
		api: fakeApi() as any, navigate: () => {}, openDataStudio, openEditor, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true),
		canViewAllAccess: ref(viewer), user: ref({ id: 'u-me', role: viewer ? 'r3' : 'r1' }),
	}));
	setPageFrame(defineComponent({ props: { title: String }, setup: (_p, { slots }) => () => h('div', Object.values(slots).flatMap((s) => (s ? s() : []))) }));
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/home/:slug', component: IndexRoute, props: true }] });
	await router.push(`/home/manufacturers${query}`);
	app = createApp({ render: () => h('div', [h(IndexRoute, { slug: 'manufacturers' })]) });
	app.use(router);
	registerStubs(app);
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
}

const row = () => document.querySelector<HTMLElement>('tr.row, .card, [data-row]');

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

describe('a drawer index page (manufacturers)', () => {
	it('for a Lab Viewer, a row opens the record in Data Studio and never the editor; + New is gone', async () => {
		await mountIndex(true);
		await vi.waitFor(() => expect(row()).not.toBeNull());
		expect(document.body.textContent).not.toContain('+ New');
		row()!.click();
		await nextTick();
		expect(openDataStudio).toHaveBeenCalledWith(`/content/manufacturers/${PK}`);
		expect(openEditor).not.toHaveBeenCalled();
	});

	it('for a Lab Viewer, ?open=<key> from the finder goes to Data Studio too, without the editor', async () => {
		await mountIndex(true, `?open=${PK}`);
		await vi.waitFor(() => expect(openDataStudio).toHaveBeenCalledWith(`/content/manufacturers/${PK}`));
		await nextTick();
		expect(openEditor).not.toHaveBeenCalled();
	});

	it('for a member the drawer still opens (the editor), and Data Studio is not used', async () => {
		await mountIndex(false);
		await vi.waitFor(() => expect(row()).not.toBeNull());
		expect(document.body.textContent).toContain('+ New');
		row()!.click();
		await vi.waitFor(() => expect(openEditor).toHaveBeenCalledWith('manufacturers', PK));
		expect(openDataStudio).not.toHaveBeenCalled();
	});
});
