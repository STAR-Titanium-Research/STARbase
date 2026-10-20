// @vitest-environment happy-dom
// The ownership and access bulk actions on the Samples list, in a real DOM against a fake host: Assign to team (the team tiles),
// Change owner (the people search), Share or change access (people and teams, the access level), Remove access, the warnings counted
// before Apply, and where focus goes. The endpoint is mocked to the contract: kinds assign_team / change_owner / share_access /
// remove_access with {team_id} / {person_id} / {person_id|team_id, role} / {person_id|team_id}.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { EXPLORER_HOST, IndexPage, configureLinks, indexDefBySlug, resetLinks, setExplorerHostFactory, starbaseLinks } from '@d1/ui';

const ROWS = [
	{ sample_id: 's1', sample_code: 'S-1', current_status: 'active', form: 'disc' },
	{ sample_id: 's2', sample_code: 'S-2', current_status: 'active', form: 'disc' },
	{ sample_id: 's3', sample_code: 'S-3', current_status: 'consumed', form: 'disc' },
];
const TEAMS = [
	{ team_id: 't1', name: 'Team X', description: null, color: 'teal', logo: null, member_count: 4, managers: [], is_member: true, is_manager: true },
	{ team_id: 't2', name: 'Team Y', description: null, color: 'blue', logo: null, member_count: 1, managers: [], is_member: false, is_manager: false },
];
const PEOPLE = [{ person_id: 'p-ann', full_name: 'Ann Lee', user_id: 'u-ann' }];
const WARN = 'You may lose access to this record';

let app: App | null = null;
const posts: { path: string; body: any }[] = [];
let previewRows: ((id: string, i: number) => Record<string, unknown>) | null = null;

const answer = (path: string, body: any): any => {
	if (path.endsWith('/preview')) {
		return { results: body.ids.map((id: string, i: number) => previewRows?.(id, i) ?? { id, code: id.toUpperCase(), status: 'ok' }) };
	}
	if (path.endsWith('/apply')) {
		return { action_id: 'act-1', undo_until: new Date(Date.now() + 60_000).toISOString(), results: body.ids.map((id: string) => ({ id, code: id.toUpperCase(), outcome: 'applied' })) };
	}
	return {};
};

async function mountList() {
	const api = {
		get: vi.fn(async (path: string, config?: { params?: Record<string, any> }) => {
			if (path === '/items/physical_samples' && !config?.params?.groupBy) return { data: { data: ROWS, meta: { filter_count: 3 } } };
			if (path === '/d1-teams') return { data: { teams: TEAMS } };
			if (path === '/items/people') return { data: { data: PEOPLE } };
			return { data: { data: [] } };
		}),
		post: vi.fn(async (path: string, body?: any) => {
			posts.push({ path, body });
			return { data: answer(path, body) };
		}),
		patch: vi.fn(),
		delete: vi.fn(),
	};
	const host = {
		api, navigate: vi.fn(), openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u-me' }),
	} as any;
	setExplorerHostFactory(() => host);
	configureLinks(starbaseLinks(''));
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [{ path: '/home/:slug', component: defineComponent({ setup: () => () => h(IndexPage, { def: indexDefBySlug('samples')! }) }) }],
	});
	await router.push('/home/samples');
	app = createApp({ render: () => h('div', [h(RouterView)]) });
	app.use(router);
	app.provide(EXPLORER_HOST, host);
	app.component('v-icon', defineComponent({ setup: () => () => h('span') }));
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	await vi.waitFor(() => expect(document.body.textContent).toContain('S-1'));
}

const menuButton = () => document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
const ticks = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[aria-label="Tick this row"]'));
const dlg = () => document.querySelector('[role="dialog"]')!;
const dlgText = () => dlg().textContent ?? '';
const flush = async () => {
	for (let i = 0; i < 6; i++) await nextTick();
};
async function openAction(label: string, count = 3) {
	for (const box of ticks().slice(0, count)) {
		box.click();
		await nextTick();
	}
	menuButton().click();
	await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
	Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((b) => b.textContent?.trim() === label)!.click();
	await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
}
const previewPosts = () => posts.filter((p) => p.path.endsWith('/preview')).map((p) => p.body);
const applyButton = () => Array.from(dlg().querySelectorAll<HTMLButtonElement>('button')).find((b) => /^(Apply to|Applying)/.test(b.textContent?.trim() ?? ''))!;
const searchBox = () => dlg().querySelector<HTMLInputElement>('input[role="combobox"]')!;
async function search(text: string) {
	const box = searchBox();
	box.value = text;
	box.dispatchEvent(new Event('input', { bubbles: true }));
	// the box waits 250 ms after the last key before it searches
	await vi.waitFor(() => expect(dlg().querySelector('[role="option"]')).not.toBeNull(), { timeout: 2000 });
}
const option = (name: string) => Array.from(dlg().querySelectorAll<HTMLElement>('[role="option"]')).find((o) => o.textContent?.includes(name))!;
const changeButton = () => Array.from(dlg().querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === 'Change')!;

beforeEach(() => {
	posts.length = 0;
	previewRows = null;
});
afterEach(() => {
	app?.unmount();
	app = null;
	document.body.replaceChildren();
	resetLinks();
	setExplorerHostFactory(null);
});

describe('Assign to team', () => {
	it('shows the teams, previews the chosen one, applies, and the toast names the team', async () => {
		await mountList();
		await openAction('Assign to team…');
		expect(dlgText()).toContain('Assign 3 samples to a team');
		await vi.waitFor(() => expect(dlg().querySelectorAll('input[type="radio"]')).toHaveLength(2));
		expect(dlgText()).toContain('Team X');
		expect(dlgText()).toContain('Team · 4 members');
		expect(dlg().querySelector('.d1-team-tile')).not.toBeNull();
		expect(posts).toEqual([]);
		expect(applyButton().disabled).toBe(true);

		dlg().querySelectorAll<HTMLInputElement>('input[type="radio"]')[0].click();
		await vi.waitFor(() => expect(dlgText()).toContain('3 can be changed'));
		expect(previewPosts()).toEqual([{ kind: 'assign_team', ids: ['s1', 's2', 's3'], params: { team_id: 't1' } }]);
		expect(dlgText()).toContain('Assign 3 samples to Team X');
		expect(applyButton().textContent?.trim()).toBe('Apply to 3');
		expect(applyButton().disabled).toBe(false);

		applyButton().click();
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
		expect(posts[1]).toEqual({ path: '/d1-bulk-actions/physical_samples/apply', body: { kind: 'assign_team', ids: ['s1', 's2', 's3'], params: { team_id: 't1' } } });
		expect(document.querySelector('.bulk-toast')!.textContent).toContain('Assigned 3 samples to Team X');
	});

	it('keeps Apply off when every row would be skipped, with the reason in plain words', async () => {
		previewRows = (id) => ({ id, code: id.toUpperCase(), status: 'skip', reason: 'TEAM_HAS_NO_MANAGER' });
		await mountList();
		await openAction('Assign to team…');
		await vi.waitFor(() => expect(dlg().querySelectorAll('input[type="radio"]')).toHaveLength(2));
		dlg().querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].click();
		await vi.waitFor(() => expect(dlgText()).toContain('None can be changed. 3 will be skipped'));
		expect(dlgText()).toContain('Why are 3 skipped?');
		expect(dlgText()).toContain('That team has no manager yet (3)');
		expect(applyButton().disabled).toBe(true);
	});
});

describe('Change owner', () => {
	it('searches people, writes the pick with Change, and previews at once', async () => {
		await mountList();
		await openAction('Change owner…', 2);
		expect(dlgText()).toContain('Change the owner of 2 samples');
		expect(searchBox().placeholder).toBe('Search people by name…');
		expect(dlg().querySelector('.d1-team-tile')).toBeNull();
		await search('ann');
		expect(dlgText()).toContain('Ann Lee');
		option('Ann Lee').click();
		await vi.waitFor(() => expect(dlgText()).toContain('2 can be changed'));
		expect(previewPosts()).toEqual([{ kind: 'change_owner', ids: ['s1', 's2'], params: { person_id: 'p-ann' } }]);
		expect(dlgText()).toContain('Change the owner of 2 samples to Ann Lee');
		expect(searchBox()).toBeNull();
		// the box left with the pick: focus is on Change, not lost
		await flush();
		expect(document.activeElement).toBe(changeButton());
		// Change takes the pick back, empties the check, and puts the cursor in the box again
		changeButton().click();
		await vi.waitFor(() => expect(searchBox()).not.toBeNull());
		await flush();
		expect(document.activeElement).toBe(searchBox());
		expect(dlgText()).toContain('Search for a person to see what would change.');
		expect(applyButton().disabled).toBe(true);
	});
});

describe('Share or change access', () => {
	it('previews with Can view, again with Can edit, and the toast says who', async () => {
		await mountList();
		await openAction('Share or change access…');
		expect(searchBox().placeholder).toBe('Search people and teams by name…');
		const level = dlg().querySelector<HTMLSelectElement>('select')!;
		expect(Array.from(level.options).map((o) => o.textContent?.trim())).toEqual(['Can view', 'Can edit']);
		await search('ann');
		option('Ann Lee').click();
		await vi.waitFor(() => expect(dlgText()).toContain('3 can be changed'));
		expect(previewPosts().at(-1)).toEqual({ kind: 'share_access', ids: ['s1', 's2', 's3'], params: { person_id: 'p-ann', role: 'view' } });
		expect(dlgText()).toContain('Share 3 samples with Ann Lee (Can view)');

		const select = dlg().querySelector<HTMLSelectElement>('select')!;
		select.value = 'edit';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		await vi.waitFor(() => expect(previewPosts()).toHaveLength(2));
		expect(previewPosts()[1].params).toEqual({ person_id: 'p-ann', role: 'edit' });
		await vi.waitFor(() => expect(dlgText()).toContain('(Can edit)'));

		applyButton().click();
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
		expect(posts.at(-1)!.body).toEqual({ kind: 'share_access', ids: ['s1', 's2', 's3'], params: { person_id: 'p-ann', role: 'edit' } });
		expect(document.querySelector('.bulk-toast')!.textContent).toContain('Shared 3 samples with Ann Lee');
	});

	it('offers teams in the same box and sends a team as team_id', async () => {
		await mountList();
		await openAction('Share or change access…', 1);
		await search('team');
		expect(dlgText()).toContain('Team X');
		expect(dlgText()).toContain('Team · 4 members');
		option('Team Y').click();
		await vi.waitFor(() => expect(previewPosts()).toHaveLength(1));
		expect(previewPosts()[0]).toEqual({ kind: 'share_access', ids: ['s1'], params: { team_id: 't2', role: 'view' } });
		expect(dlgText()).toContain('Team');
	});
});

describe('Remove access', () => {
	it('has no access level, sends the person, and the toast says who lost it', async () => {
		await mountList();
		await openAction('Remove access…', 2);
		expect(dlgText()).toContain('Remove access to 2 samples');
		expect(dlg().querySelector('select')).toBeNull();
		await search('ann');
		option('Ann Lee').click();
		await vi.waitFor(() => expect(dlgText()).toContain('2 can be changed'));
		expect(previewPosts()).toEqual([{ kind: 'remove_access', ids: ['s1', 's2'], params: { person_id: 'p-ann' } }]);
		expect(dlgText()).toContain("Remove Ann Lee's access to 2 samples");
		applyButton().click();
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
		expect(document.querySelector('.bulk-toast')!.textContent).toContain('Removed access for Ann Lee on 2 samples');
	});
});

describe('warnings', () => {
	it('are counted before Apply, listed in a fold, and follow the applied rows onto the toast', async () => {
		previewRows = (id, i) => ({ id, code: id.toUpperCase(), status: 'ok', ...(i < 2 ? { warning: WARN } : {}) });
		await mountList();
		await openAction('Assign to team…');
		await vi.waitFor(() => expect(dlg().querySelectorAll('input[type="radio"]')).toHaveLength(2));
		dlg().querySelectorAll<HTMLInputElement>('input[type="radio"]')[0].click();
		await vi.waitFor(() => expect(dlgText()).toContain('3 can be changed'));
		expect(dlgText()).toContain('Read before you apply: 2 have a warning.');
		expect(dlg().querySelector('.warn')).not.toBeNull();
		expect(dlgText()).toContain('Which 2 have a warning?');
		expect(dlgText()).toContain(`${WARN} (2)`);
		expect(dlg().textContent).toContain('S1');
		// the warning is said in the dialog's polite status region too, so it is read out
		expect(dlg().querySelector('[role="status"]')!.textContent).toContain(WARN);

		applyButton().click();
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
		const toast = document.querySelector('.bulk-toast')!;
		expect(toast.textContent).toContain('Assigned 3 samples to Team X');
		expect(toast.textContent).toContain('2 had a warning');
	});

	it('are not mentioned when none of the rows has one', async () => {
		await mountList();
		await openAction('Assign to team…');
		await vi.waitFor(() => expect(dlg().querySelectorAll('input[type="radio"]')).toHaveLength(2));
		dlg().querySelectorAll<HTMLInputElement>('input[type="radio"]')[0].click();
		await vi.waitFor(() => expect(dlgText()).toContain('3 can be changed'));
		expect(dlgText()).not.toContain('warning');
	});
});

describe('the dialog conventions', () => {
	it('closes on Escape without a change, and an open search list takes the first Escape', async () => {
		await mountList();
		await openAction('Change owner…', 1);
		await search('ann');
		searchBox().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await flush();
		expect(dlg()).not.toBeNull();
		expect(dlg().querySelector('[role="listbox"]')!.getAttribute('style') ?? '').toContain('display: none');
		dlg().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
		await flush();
		expect(posts).toEqual([]);
		expect(document.activeElement).toBe(menuButton());
	});

	it('lists the failure of the team list as an alert and keeps Apply off', async () => {
		await mountList();
		const get = (app!._context.provides[EXPLORER_HOST as unknown as symbol] as any).api.get as ReturnType<typeof vi.fn>;
		get.mockImplementation(async (path: string) => {
			if (path === '/d1-teams') throw Object.assign(new Error('x'), { response: { data: { errors: [{ message: 'Teams are not available.' }] } } });
			return { data: { data: ROWS, meta: { filter_count: 3 } } };
		});
		await openAction('Assign to team…', 1);
		await vi.waitFor(() => expect(dlg().querySelector('[role="alert"]')).not.toBeNull());
		expect(dlg().querySelector('[role="alert"]')!.textContent).toContain('Teams are not available.');
		expect(applyButton().disabled).toBe(true);
	});
});
