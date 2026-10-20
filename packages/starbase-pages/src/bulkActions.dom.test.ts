// @vitest-environment happy-dom
// Bulk actions on the Samples list, in a real DOM against a fake host: tick rows, open the With-selected menu, Print labels still goes to
// the labels page with the ticked keys, Edit status opens the dialog, the dry run and Apply talk to the endpoint, the toast counts down and
// Undo takes the change back, and focus ends on the menu button.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { IndexPage, configureLinks, indexDefBySlug, resetLinks, setExplorerHostFactory, starbaseLinks } from '@d1/ui';

const ROWS = [
	{ sample_id: 's1', sample_code: 'S-1', current_status: 'active', form: 'disc' },
	{ sample_id: 's2', sample_code: 'S-2', current_status: 'active', form: 'disc' },
	{ sample_id: 's3', sample_code: 'S-3', current_status: 'consumed', form: 'disc' },
];

let app: App | null = null;
const posts: { path: string; body: any }[] = [];
let listReads = 0;

const answer = (path: string, body: any): any => {
	if (path.endsWith('/preview')) return { results: body.ids.map((id: string) => ({ id, code: id.toUpperCase(), status: 'ok' })), counts: { ok: body.ids.length } };
	if (path.endsWith('/apply')) {
		return { action_id: 'act-1', undo_until: new Date(Date.now() + 60_000).toISOString(), results: body.ids.map((id: string) => ({ id, code: id.toUpperCase(), outcome: 'applied' })) };
	}
	if (path.endsWith('/undo')) return { state: 'undone', results: [{ id: 's1', revert_outcome: 'reverted' }, { id: 's2', revert_outcome: 'reverted' }] };
	return {};
};

async function mountList() {
	const navigate = vi.fn();
	const api = {
		get: vi.fn(async (path: string, config?: { params?: Record<string, any> }) => {
			if (path === '/items/physical_samples' && !config?.params?.groupBy) {
				listReads += 1;
				return { data: { data: ROWS, meta: { filter_count: 3 } } };
			}
			return { data: { data: [] } };
		}),
		post: vi.fn(async (path: string, body?: any) => {
			posts.push({ path, body });
			return { data: answer(path, body) };
		}),
		patch: vi.fn(),
		delete: vi.fn(),
	};
	setExplorerHostFactory(() => ({
		api, navigate, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u-me' }),
	}) as any);
	configureLinks(starbaseLinks(''));
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [{ path: '/home/:slug', component: defineComponent({ setup: () => () => h(IndexPage, { def: indexDefBySlug('samples')! }) }) }],
	});
	await router.push('/home/samples');
	app = createApp({ render: () => h('div', [h(RouterView)]) });
	app.use(router);
	app.component('v-icon', defineComponent({ setup: () => () => h('span') }));
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	await vi.waitFor(() => expect(document.body.textContent).toContain('S-1'));
	return { navigate };
}

const menuButton = () => document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
const ticks = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[aria-label="Tick this row"]'));
const item = (label: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((b) => b.textContent?.trim() === label)!;
const flush = async () => {
	for (let i = 0; i < 6; i++) await nextTick();
};
async function tick(n: number) {
	for (const box of ticks().slice(0, n)) {
		box.click();
		await nextTick();
	}
}
async function openMenu() {
	menuButton().click();
	await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
}

beforeEach(() => {
	posts.length = 0;
	listReads = 0;
});
afterEach(() => {
	app?.unmount();
	app = null;
	document.body.replaceChildren();
	resetLinks();
	setExplorerHostFactory(null);
	vi.useRealTimers();
});

describe('bulk actions on the Samples list', () => {
	it('starts with a disabled menu, then counts the ticked rows', async () => {
		await mountList();
		expect(menuButton().textContent).toContain('With selected');
		expect(menuButton().getAttribute('aria-disabled')).toBe('true');
		menuButton().click();
		await flush();
		expect(document.querySelector('[role="menu"]')).toBeNull();
		await tick(2);
		expect(menuButton().textContent).toContain('With 2 selected');
		expect(menuButton().getAttribute('aria-disabled')).toBe('false');
	});

	it('lists the entries and sends Print labels to the labels page with the ticked keys', async () => {
		const { navigate } = await mountList();
		await tick(2);
		await openMenu();
		expect(Array.from(document.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent?.trim())).toEqual([
			'Print labels', 'Restrict…', 'Unrestrict…', 'Edit status…', 'Edit project…', 'Edit mounted…',
		]);
		item('Print labels').click();
		await flush();
		expect(navigate).toHaveBeenCalledWith('/home/labels?ids=s1,s2');
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it('closes the menu with Escape and gives focus back to the button', async () => {
		await mountList();
		await tick(1);
		await openMenu();
		item('Print labels').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await flush();
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(menuButton());
	});

	it('edits a field: preview, apply, toast, reload with the ticks cleared, then Undo', async () => {
		await mountList();
		await tick(2);
		await openMenu();
		item('Edit status…').click();
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
		expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Edit status for 2 samples');
		// nothing is asked of the server until a value is chosen
		expect(posts).toEqual([]);
		const select = document.querySelector<HTMLSelectElement>('[role="dialog"] select')!;
		select.value = 'archived';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')!.textContent).toContain('2 can be changed'));
		expect(posts[0]).toEqual({ path: '/d1-bulk-actions/physical_samples/preview', body: { kind: 'edit_field', ids: ['s1', 's2'], params: { field: 'current_status', value: 'archived' } } });
		const apply = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((b) => b.textContent?.trim() === 'Apply to 2')!;
		const before = listReads;
		apply.click();
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
		expect(posts[1].path).toBe('/d1-bulk-actions/physical_samples/apply');
		// the toast, with its ring and Undo
		const toast = document.querySelector('.bulk-toast')!;
		expect(toast.textContent).toContain('Set status to Archived on 2 samples');
		expect(toast.querySelector('svg')).not.toBeNull();
		// the list reloaded and the ticks cleared; focus went back to the menu button (disabled now, but focusable)
		await vi.waitFor(() => expect(listReads).toBeGreaterThan(before));
		await vi.waitFor(() => expect(menuButton().textContent).toContain('With selected'));
		expect(document.activeElement).toBe(menuButton());
		// Undo
		Array.from(toast.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === 'Undo')!.click();
		await vi.waitFor(() => expect(document.querySelector('.bulk-toast')!.textContent).toContain('Undone'));
		expect(posts[2].path).toBe('/d1-bulk-actions/act-1/undo');
	});

	it('closes the dialog on Escape without asking for a change, and returns focus to the button', async () => {
		await mountList();
		await tick(1);
		await openMenu();
		item('Restrict…').click();
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
		await vi.waitFor(() => expect(posts.length).toBe(1));
		expect(posts[0].body).toEqual({ kind: 'restrict', ids: ['s1'], params: {} });
		document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
		await flush();
		expect(posts.some((p) => p.path.endsWith('/apply'))).toBe(false);
		expect(document.activeElement).toBe(menuButton());
	});
});
