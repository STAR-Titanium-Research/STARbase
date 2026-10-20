// @vitest-environment happy-dom
// The index page in a DOM: the View rail beside the table (open or collapsed by the page's width, what each
// setting does to the list and to the request) and the toolbar above the table.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import type { App } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Router } from 'vue-router';
import type { ExplorerHost } from '../host';
import { setExplorerHostFactory } from '../host';
import { configureLinks, resetLinks, starbaseLinks } from '../links';
import { useExplorerNav } from '../nav/useExplorerNav';
import IndexPage from './IndexPage.vue';
import { indexDefBySlug } from './indexConfig';

const ROWS = [
	{ sample_id: 's1', sample_code: 'S-1', nickname: 'Rod', current_status: 'active', form: 'cylinder', project_id: { project_code: 'P-A' } },
	{ sample_id: 's2', sample_code: 'S-2', nickname: 'Disc', current_status: 'active', form: 'disc', project_id: { project_code: 'P-A' } },
	{ sample_id: 's3', sample_code: 'S-3', nickname: null, current_status: 'consumed', form: 'block', project_id: null },
];

let app: App | null = null;
let host: HTMLElement;
let router: Router;
let itemCalls: Record<string, any>[] = [];

const settle = async () => {
	for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
	await nextTick();
};

async function mount(width = 1600, path = '/home/samples', props: Record<string, unknown> = {}) {
	window.innerWidth = width;
	itemCalls = [];
	const get = vi.fn(async (path: string, config?: { params?: Record<string, any> }) => {
		if (path === '/items/physical_samples' && !config?.params?.groupBy) {
			itemCalls.push(config?.params ?? {});
			return { data: { data: ROWS, meta: { filter_count: 153 } } };
		}
		if (path === '/presets/7') return { data: { data: { id: 7, bookmark: 'Heavy', collection: 'physical_samples', user: null, role: null, filter: null, search: null, layout_query: { tabular: { sort: ['-weight'] } } } } };
		if (path === '/collections') return { data: { data: ['physical_samples', 'projects', 'materials'].map((c) => ({ collection: c, meta: { hidden: false } })) } };
		return { data: { data: [] } };
	});
	const fake = { api: { get }, navigate: vi.fn(), openDataStudio: vi.fn(), isAdmin: ref(false), adminKnown: ref(true), user: ref(null) } as unknown as ExplorerHost;
	setExplorerHostFactory(() => fake);
	await useExplorerNav(fake).refresh();
	router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/home/:slug', component: { render: () => null } }, { path: '/:rest(.*)*', component: { render: () => null } }] });
	await router.push(path);
	await router.isReady();
	const Page = defineComponent({ setup: () => () => h(IndexPage, { def: indexDefBySlug('samples')!, ...props }) });
	app = createApp(Page);
	app.component('v-icon', defineComponent({ props: { name: String }, setup: (p) => () => h('i', p.name) }));
	app.component('router-link', defineComponent({ props: { to: [String, Object] }, setup: (p, { slots }) => () => h('a', { href: String(p.to) }, slots.default?.()) }));
	app.use(router);
	app.mount(host);
	await settle();
}

const $ = (sel: string) => host.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => [...host.querySelectorAll(sel)] as HTMLElement[];
const click = async (el: Element | null) => {
	(el as HTMLElement).click();
	await settle();
};
const saved = () => JSON.parse(localStorage.getItem('d1.list.samples') ?? '{}');

beforeEach(() => {
	configureLinks(starbaseLinks(''));
	localStorage.clear();
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	app?.unmount();
	app = null;
	host.remove();
	resetLinks();
	setExplorerHostFactory(null);
});

describe('the View rail beside the table', () => {
	it('is open from 1500px, in the grid beside the table and not in the toolbar, its sections in the designed order', async () => {
		await mount(1600);
		expect($('.index-grid .card .lid')).toBeTruthy();
		expect($('.tools .card')).toBeNull();
		expect($('.main .card')).toBeNull();
		expect($$('.card .d1-view-section').map((s) => s.querySelector('.label')?.textContent ?? '')).toEqual(['', 'Layout', 'Density', 'Sort', 'Group by', 'Columns', 'Rows per page']);
		expect($('.card .range')?.textContent).toBe('1–3 of 153');
	});

	it('is the 36px tab from 1100 to 1499px, with the sort and density in its summary', async () => {
		await mount(1300);
		expect($('.card')).toBeNull();
		expect($('.tab')?.textContent).toContain('View · Normal · Created ↓');
		await click($('.tab'));
		expect($('.card')).toBeTruthy();
	});

	it('is a "View" button with a popover under 1100px', async () => {
		await mount(900);
		expect($('.pop-button')).toBeTruthy();
		expect($('.card')).toBeNull();
		await click($('.pop-button'));
		expect($('.pop .card, .card.pop')).toBeTruthy();
	});

	it('comes back as it was left on this device, over the width default', async () => {
		localStorage.setItem('d1.list.samples.open', '0');
		await mount(1600);
		expect($('.tab')).toBeTruthy();
	});
});

describe('a picker over another page', () => {
	it('keeps its own settings and its own open/closed, and leaves the list page\'s alone', async () => {
		localStorage.setItem('d1.list.samples', JSON.stringify({ view: 'cards', pageSize: 25 }));
		localStorage.setItem('d1.list.samples.open', '1');
		await mount(1600, '/home/samples', { pick: true });
		// Not the list page's choices: a table of 50, the rail by the width.
		expect($('table.d1-table')).toBeTruthy();
		expect(itemCalls.at(-1)).toMatchObject({ limit: 50 });
		await click($$('[aria-label="Layout"] button')[2]);
		await click($$('[aria-label="Rows per page"] button')[2]);
		await click($('.collapse'));
		expect(JSON.parse(localStorage.getItem('d1.list.samples.pick')!)).toMatchObject({ view: 'list', pageSize: 100 });
		expect(localStorage.getItem('d1.list.samples.pick.open')).toBe('0');
		expect(JSON.parse(localStorage.getItem('d1.list.samples')!)).toMatchObject({ view: 'cards', pageSize: 25 });
		expect(localStorage.getItem('d1.list.samples.open')).toBe('1');
	});
});

describe('rows per page', () => {
	it('asks for 25, 50 or 100 rows, remembers it per list, and starts again from page 1', async () => {
		await router.push('/home/samples');
		await mount(1600);
		expect(itemCalls.at(-1)).toMatchObject({ limit: 50, page: 1 });
		await router.push('/home/samples?page=2');
		await settle();
		expect(itemCalls.at(-1)).toMatchObject({ page: 2 });
		const seg = $$('[aria-label="Rows per page"] button');
		expect(seg.map((b) => b.textContent)).toEqual(['25', '50', '100']);
		await click(seg[0]);
		expect(itemCalls.at(-1)).toMatchObject({ limit: 25, page: 1 });
		expect(router.currentRoute.value.query.page).toBeUndefined();
		expect(saved().pageSize).toBe(25);
		expect($('.foot .d1-note')?.textContent).toBe('Page 1 of 7');
	});
});

describe('layout', () => {
	it('shows compact two-line rows in the list layout, and remembers it', async () => {
		await mount(1600);
		expect($('table.d1-table')).toBeTruthy();
		await click($$('[aria-label="Layout"] button')[2]);
		expect($('table.d1-table')).toBeNull();
		expect($$('ul.list > li.row')).toHaveLength(3);
		expect($('ul.list > li.row .l1 a')?.textContent).toBe('S-1');
		expect($('ul.list > li.row .sub')?.textContent).toBe('Rod');
		expect($('ul.list > li.row .l2')?.textContent).toContain('Cylinder');
		expect(saved().view).toBe('list');
		await click($$('[aria-label="Layout"] button')[1]);
		expect($('.card-grid')).toBeTruthy();
	});
});

describe('sort', () => {
	it('is a field select and a direction button for every layout, in the URL', async () => {
		await mount(1600);
		const select = $('select[aria-label="Sort by"]') as HTMLSelectElement;
		expect(select.value).toBe('created_at');
		await click($('.dir'));
		expect(router.currentRoute.value.query.sort).toBe('created_at');
		expect(itemCalls.at(-1)?.sort).toEqual(['created_at']);
		select.value = 'nickname';
		select.dispatchEvent(new Event('change'));
		await settle();
		expect(router.currentRoute.value.query.sort).toBe('nickname');
		await click($$('[aria-label="Layout"] button')[1]);
		expect(($('select[aria-label="Sort by"]') as HTMLSelectElement).value).toBe('nickname');
	});
});

describe('sort of a saved view', () => {
	it('cannot be turned round with the direction button, which says why, and is no change from the default', async () => {
		await mount(1600, '/home/samples?bookmark=7');
		const dir = $('.dir') as HTMLButtonElement;
		expect(dir.disabled).toBe(true);
		expect(dir.title).toBe('Sorted by the saved view');
		expect(($('select[aria-label="Sort by"]') as HTMLSelectElement).value).toBe('weight');
		expect($('.dot')).toBeNull();
		expect(itemCalls.at(-1)?.sort).toEqual(['-weight']);
	});
});

describe('group by', () => {
	it('sorts by the group field first and puts a header above each run of rows', async () => {
		await mount(1600);
		expect($$('tr.group')).toHaveLength(0);
		const select = $('select[aria-label="Group by"]') as HTMLSelectElement;
		expect([...select.options].map((o) => o.textContent)).toEqual(['None', 'Project', 'Status', 'Material']);
		select.value = 'current_status';
		select.dispatchEvent(new Event('change'));
		await settle();
		expect(itemCalls.at(-1)?.sort).toEqual(['current_status', '-created_at']);
		expect($$('tr.group').map((t) => t.textContent)).toEqual(['active', 'consumed']);
		// One body per group, headed by a row-group header cell, and the rows follow it.
		expect($$('table.d1-table > tbody')).toHaveLength(2);
		expect($$('tbody > tr.group > th').map((t) => t.getAttribute('scope'))).toEqual(['rowgroup', 'rowgroup']);
		expect($$('tbody')[0].querySelectorAll('tr.row')).toHaveLength(2);
		expect(saved().groupBy).toBe('current_status');
		await click($$('[aria-label="Layout"] button')[2]);
		expect($$('li.group').map((t) => t.textContent)).toEqual(['active', 'consumed']);
		expect($$('li.group > [role="heading"]').map((t) => t.getAttribute('aria-level'))).toEqual(['3', '3']);
		await click($$('[aria-label="Layout"] button')[1]);
		expect($$('.card-grid > li.group > [role="heading"]').map((t) => t.textContent)).toEqual(['active', 'consumed']);
	});

	it('names a row without the value (or one the person may not read) "No project or not visible"', async () => {
		await mount(1600);
		const select = $('select[aria-label="Group by"]') as HTMLSelectElement;
		select.value = 'project_id';
		select.dispatchEvent(new Event('change'));
		await settle();
		expect($$('tr.group').map((t) => t.textContent)).toEqual(['P-A', 'No project or not visible']);
	});
});

describe('columns', () => {
	const headings = () => $$('thead th').map((t) => t.textContent?.trim()).filter(Boolean);

	it('says how many are shown, hides one, drags another to the front, and Reset brings them all back', async () => {
		await mount(1600);
		const trigger = $('.d1-columns .trigger')!;
		expect(trigger.textContent).toContain('8 of 8 shown');
		expect(headings()).toContain('Nickname');
		await click(trigger);
		expect($('.d1-columns .pop')).toBeTruthy();
		// The code column is always on.
		expect(($('input[aria-label="Show Code"]') as HTMLInputElement).disabled).toBe(true);
		await click($('input[aria-label="Show Nickname"]'));
		expect(headings()).not.toContain('Nickname');
		expect(trigger.textContent).toContain('7 of 8 shown');
		expect(saved().columns.hidden).toEqual(['nickname']);
		expect(saved().columns.order).not.toContain('sample_code');
		// Hidden ones are checkboxes under "Hidden"; checking one shows it again, where it was.
		await click($('input[aria-label="Show Nickname"]'));
		expect(headings().slice(0, 3)).toEqual(['Code', 'Nickname', 'Material']);
		// Alt+arrow on a grip moves a column.
		const grip = $('[data-grip="material_id"]')!;
		grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }));
		await settle();
		expect(headings().slice(0, 4)).toEqual(['Code', 'Material', 'Nickname', 'Project']);
		await click([...$$('.d1-columns .foot button')].find((b) => b.textContent === 'Reset')!);
		expect(headings().slice(0, 3)).toEqual(['Code', 'Nickname', 'Material']);
		expect(saved().columns).toBeNull();
		await click([...$$('.d1-columns .foot button')].find((b) => b.textContent === 'Done')!);
		expect($('.d1-columns .pop')).toBeNull();
	});

	it('keeps the keyboard on a column\'s box as it moves between Shown and Hidden, and gives it back to the button on Esc and Done', async () => {
		await mount(1600);
		const trigger = $('.d1-columns .trigger')!;
		await click(trigger);
		await click($('input[aria-label="Show Nickname"]'));
		expect(document.activeElement).toBe($('input[data-check="nickname"]'));
		expect($('input[data-check="nickname"]')?.closest('ul')).toBe($$('.d1-columns ul')[1]);
		await click($('input[data-check="nickname"]'));
		expect(document.activeElement).toBe($('input[data-check="nickname"]'));
		$('.d1-columns .pop')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await settle();
		expect($('.d1-columns .pop')).toBeNull();
		expect(document.activeElement).toBe(trigger);
		await click(trigger);
		await click([...$$('.d1-columns .foot button')].find((b) => b.textContent === 'Done')!);
		expect(document.activeElement).toBe(trigger);
	});

	it('finds a column by its name', async () => {
		await mount(1600);
		await click($('.d1-columns .trigger'));
		const find = $('.d1-columns .find') as HTMLInputElement;
		find.value = 'loc';
		find.dispatchEvent(new Event('input'));
		await settle();
		expect($$('.d1-columns li').map((l) => l.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Location⠿']);
	});

	it('applies to the cards and the list too', async () => {
		localStorage.setItem('d1.list.samples', JSON.stringify({ view: 'list', columns: ['sample_code', 'nickname', 'form'] }));
		await mount(1600);
		expect($('ul.list > li.row .l2')?.textContent).toBe('Cylinder');
	});
});

describe('the toolbar', () => {
	it('has search, the filters and Clear filters, and none of how rows look', async () => {
		await mount(1600);
		const tools = $('.tools')!;
		expect(tools.querySelector('input[type="search"]')).toBeTruthy();
		expect(tools.querySelector('select[aria-label="Filter by status"]')).toBeTruthy();
		for (const gone of ['Layout', 'Density', 'Sort by', 'Rows per page', 'Print labels']) expect(tools.innerHTML).not.toContain(gone);
	});
});
