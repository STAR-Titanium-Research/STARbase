import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, h, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { ExplorerHost } from '../host';
import { setExplorerHostFactory } from '../host';
import { configureLinks, resetLinks, starbaseLinks } from '../links';
import { useExplorerNav } from '../nav/useExplorerNav';
import CardGrid from './CardGrid.vue';
import IndexPage from './IndexPage.vue';
import { indexDefBySlug } from './indexConfig';

// IndexPage rendered on the server against a fake host: the normal page, and picker mode over it.
const VIcon = defineComponent({ props: { name: String }, setup: (p) => () => h('i', { class: 'v-icon' }, p.name) });
const RouterLink = defineComponent({ props: { to: [String, Object] }, setup: (p, { slots }) => () => h('a', { href: String(p.to) }, slots.default?.()) });

const ROWS = [
	{ sample_id: 's1', sample_code: 'S-1', nickname: 'Rod', current_status: 'active', form: 'cylinder' },
	{ sample_id: 's2', sample_code: 'S-2', nickname: 'Disc', current_status: 'active', form: 'disc' },
	{ sample_id: 's3', sample_code: 'S-3', nickname: null, current_status: 'consumed', form: 'block' },
];

const calls: string[] = [];
function fakeHost(): ExplorerHost {
	const get = vi.fn(async (path: string, config?: { params?: Record<string, any> }) => {
		calls.push(path);
		if (path === '/items/physical_samples' && !config?.params?.groupBy) return { data: { data: ROWS, meta: { filter_count: 3 } } };
		if (path === '/items/tools' && !config?.params?.groupBy) return { data: { data: [{ tool_id: 't1', tool_code: 'T-1', tool_name: 'Drill' }], meta: { filter_count: 1 } } };
		return { data: { data: [] } };
	});
	return { api: { get }, navigate: vi.fn(), openDataStudio: vi.fn(), isAdmin: ref(false), adminKnown: ref(true), user: ref(null) } as unknown as ExplorerHost;
}

async function render(props: Record<string, unknown>, opts: { router?: boolean } = {}): Promise<string> {
	const host = fakeHost();
	setExplorerHostFactory(() => host);
	// The page waits for the sidebar's collections and views before it reads rows; a watcher never fires in a server render, so settle that first.
	await useExplorerNav(host).refresh();
	const app = createSSRApp(IndexPage, { def: indexDefBySlug('samples')!, ...props });
	app.component('v-icon', VIcon);
	app.component('router-link', RouterLink);
	// The rows arrive from an async load that starts in setup: wait for it before each component renders.
	app.mixin({ serverPrefetch: () => new Promise((r) => setTimeout(r, 15)) });
	if (opts.router !== false) {
		const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/home/:slug', component: { render: () => null } }] });
		await router.push('/home/samples');
		await router.isReady();
		app.use(router);
	}
	return renderToString(app);
}
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

beforeEach(() => configureLinks(starbaseLinks('')));
afterEach(() => {
	resetLinks();
	calls.length = 0;
	setExplorerHostFactory(null);
});

describe('IndexPage, normal mode (unchanged)', () => {
	it('has the crumbs, the header buttons, the With-selected menu and links in the first column', async () => {
		const html = await render({});
		expect(html).toContain('d1-crumbs');
		expect(text(html)).toContain('Open in Data Studio');
		expect(text(html)).toContain('+ New');
		expect(text(html)).toContain('With selected');
		expect(text(html)).not.toContain('Print labels for selected');
		expect(html).toMatch(/<a class="cell-link"[^>]*href="[^"]*s1/);
		expect(html).not.toContain('data-pick-key');
		expect(html).not.toContain('picking');
		expect(text(html)).not.toMatch(/Add (\d+ )?samples?/);
	});

	it('ticks on every list, not only those with a select action', async () => {
		expect(await render({})).toContain('Tick every row on this page');
		expect(await render({ def: indexDefBySlug('tools')! })).toContain('Tick every row on this page');
	});

	it('replaces the single print button with the With-selected menu, disabled while nothing is ticked', async () => {
		const html = await render({});
		const button = html.match(/<button[^>]*aria-haspopup="menu"[^>]*>/)?.[0] ?? '';
		expect(button).toContain('aria-disabled="true"');
		expect(button).toContain('aria-expanded="false"');
		// the entries appear when the menu opens (a DOM test); the model decides which, and the print entry is the first for samples
		expect(html).not.toContain('role="menuitem"');
	});

	it('has a menu on the lists that offer something and none on the others', async () => {
		expect(await render({ def: indexDefBySlug('operations')! })).toContain('aria-haspopup="menu"');
		expect(await render({ def: indexDefBySlug('tools')! })).not.toContain('aria-haspopup="menu"');
	});

	it('leaves the dialog and toasts out until an action starts', async () => {
		const html = await render({});
		expect(html).not.toContain('role="dialog"');
		expect(html).not.toContain('bulk-toast');
	});
});

describe('IndexPage, picker mode', () => {
	it('draws the list with a checkbox per row, select all on the page, and the Add button', async () => {
		const html = await render({ pick: true }, { router: false });
		expect(text(html)).toContain('S-1');
		expect(text(html)).toContain('S-3');
		expect(html).toContain('Tick every row on this page');
		expect([...html.matchAll(/aria-label="Tick this row"/g)]).toHaveLength(3);
		const button = html.match(/<button[^>]*class="btn pri"[^>]*>\s*Add samples\s*<\/button>/);
		expect(button?.[0]).toContain('disabled');
	});

	it('works without a router (the page it is opened over has its own) and keeps the URL out of it', async () => {
		await expect(render({ pick: true }, { router: false })).resolves.toContain('S-1');
		expect(calls).toContain('/items/physical_samples');
	});

	it('marks every row with its key for measuring, and never links to a record', async () => {
		const html = await render({ pick: true }, { router: false });
		expect([...html.matchAll(/data-pick-key="([^"]+)"/g)].map((m) => m[1])).toEqual(['s1', 's2', 's3']);
		expect(html).not.toContain('class="cell-link"');
		expect(html).not.toContain('<a ');
		expect(html).toContain('class="cell-text"');
	});

	it('leaves out what navigates away: crumbs, Pin, Data Studio, New, Print labels, Plots, Process map', async () => {
		const html = await render({ pick: true }, { router: false });
		expect(html).not.toContain('d1-crumbs');
		expect(text(html)).not.toContain('Open in Data Studio');
		expect(text(html)).not.toContain('+ New');
		expect(text(html)).not.toContain('Print labels');
		expect(html).not.toContain('aria-haspopup="menu"');
		expect(text(html)).not.toContain('Plots');
		expect(text(html)).not.toContain('Process map');
		expect(html).toContain('picking');
	});

	it('keeps search, saved views, filters and the view switches', async () => {
		const html = await render({ pick: true }, { router: false });
		expect(html).toContain('aria-label="Search samples"');
		expect(html).toContain('aria-label="View"');
		expect(html).toContain('aria-label="Row density"');
	});

	it('rows already taken are drawn but cannot be ticked', async () => {
		const html = await render({ pick: true, pickTaken: ['s2'] }, { router: false });
		const rows = html.split('<tr').filter((r) => r.includes('data-pick-key'));
		expect(rows).toHaveLength(3);
		expect(rows[1]).toContain('taken');
		expect(rows[1]).toContain('aria-label="Already added"');
		expect(rows[1]).toContain('disabled');
		expect(text(rows[1])).toContain('already added');
		expect(rows[0]).not.toContain('disabled');
	});

	it('names the button with the given nouns', async () => {
		const html = await render({ pick: true, pickNouns: { one: 'specimen', many: 'specimens' } }, { router: false });
		expect(text(html)).toContain('Add specimens');
	});
});

describe('CardGrid in picker mode', () => {
	const renderCards = (props: Record<string, unknown>) => renderToString(createSSRApp(CardGrid, { def: indexDefBySlug('samples')!, rows: ROWS, loading: false, rowKey: (r: Record<string, unknown>) => String(r.sample_id), hrefFor: () => null, ...props }));

	it('marks each card with its row key, so the page can measure it', async () => {
		const html = await renderCards({ pick: true });
		expect([...html.matchAll(/<li[^>]*data-pick-key="([^"]+)"/g)].map((m) => m[1])).toEqual(['s1', 's2', 's3']);
	});
	it('leaves the cards unmarked otherwise', async () => {
		expect(await renderCards({})).not.toContain('data-pick-key');
	});
});
