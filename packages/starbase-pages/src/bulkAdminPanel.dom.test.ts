// @vitest-environment happy-dom
// The admin Home "Bulk actions" panel in a real DOM against a fake host: the journal lines in plain words with who, when, counts and a state badge; Revert only
// where the endpoint would take it; Show more; a line opening to its records; the Revert confirm dialog (focus, Escape, cautions) and its per-record result;
// failures that say what to do; and nothing at all, not even a request, for anyone who is not a confirmed administrator.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { setExplorerHostFactory } from '@d1/ui';
import AdminPanels from './home/AdminPanels.vue';

let app: App | null = null;
const calls: { method: string; path: string; params?: any }[] = [];

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const line = (id: string, over: Record<string, unknown> = {}) => ({
	action_id: id, actor_user: 'u1', actor_name: 'Ann Lee', collection: 'physical_samples', kind: 'assign_team', params: { team_id: 't1' }, state: 'applied',
	created_at: iso(2 * 3600_000), undo_until: iso(2 * 3600_000 - 60_000), revert_of: null, mail_state: 'sent', n_applied: 3, n_skipped: 1, n_failed: 0, ...over,
});

interface Script {
	pages?: Record<number, any>;
	list?: () => any;
	detail?: (id: string) => any;
	revert?: () => any;
	overviewFails?: boolean;
}

function mount(script: Script, host: { isAdmin?: boolean } = {}) {
	const api = {
		get: vi.fn(async (path: string, config?: { params?: Record<string, any> }) => {
			calls.push({ method: 'get', path, params: config?.params });
			if (path === '/d1-admin-overview') throw Object.assign(new Error('Request failed'), { response: { status: 500, data: { errors: [{ message: 'Overview is down' }] } } });
			if (path === '/d1-bulk-actions') return { data: script.list ? script.list() : script.pages?.[config?.params?.offset ?? 0] };
			const id = decodeURIComponent(path.split('/').pop()!);
			return { data: script.detail!(id) };
		}),
		post: vi.fn(async (path: string) => {
			calls.push({ method: 'post', path });
			const out = script.revert!();
			if (out instanceof Error) throw out;
			return { data: out };
		}),
		patch: vi.fn(),
		delete: vi.fn(),
	};
	setExplorerHostFactory(() => ({ api, navigate: vi.fn(), openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(host.isAdmin ?? true), adminKnown: ref(true), user: ref({ id: 'u-me' }) }) as any);
	const on = ref(host.isAdmin ?? true);
	app = createApp({ render: () => h(AdminPanels, { isAdmin: on.value }) });
	app.component('v-icon', defineComponent({ setup: () => () => h('span') }));
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	return { api, on };
}

afterEach(() => {
	app?.unmount();
	app = null;
	document.body.replaceChildren();
	calls.length = 0;
	setExplorerHostFactory(null);
});

const text = () => document.body.textContent ?? '';
const buttons = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter((b) => b.textContent?.trim() === label);
const lineOf = (words: string) => Array.from(document.querySelectorAll<HTMLElement>('li.action')).find((li) => li.textContent?.includes(words))!;
const flush = async () => {
	for (let i = 0; i < 8; i++) await nextTick();
};
const failure = (status: number, message: string) => Object.assign(new Error('Request failed'), { response: { status, data: { errors: [{ message }] } } });

const JOURNAL = {
	actions: [
		line('rev', { revert_of: 'orig', n_applied: 2, n_skipped: 1, created_at: iso(10 * 60_000) }),
		line('applied'),
		line('part', { state: 'partly_reverted', kind: 'edit_field', params: { field: 'current_status', value: 'archived' }, n_applied: 5, n_skipped: 0, n_failed: 1, created_at: iso(30 * 3600_000) }),
		line('undone', { state: 'undone', kind: 'restrict', params: {}, n_applied: 4, actor_name: '', created_at: iso(3 * 86_400_000) }),
		line('orig', { state: 'reverted', collection: 'test_sessions', kind: 'share_access', params: { person_id: 'p1', role: 'edit' }, n_applied: 6, n_skipped: 0 }),
	],
	has_more: false,
};

describe('the Bulk actions panel', () => {
	it('lists each action in plain words with who, when, counts and a state badge', async () => {
		mount({ list: () => JOURNAL });
		await vi.waitFor(() => expect(document.querySelector('li.action')).not.toBeNull());
		const applied = lineOf('Assigned 3 samples to a team');
		expect(applied.textContent).toContain('Applied');
		expect(applied.textContent).toContain('Ann Lee');
		expect(applied.textContent).toContain('2 h ago');
		expect(applied.textContent).toContain('3 changed, 1 not changed');
		const part = lineOf('Set status to Archived on 5 samples');
		expect(part.textContent).toContain('Partly reverted');
		expect(part.textContent).toContain('5 changed, 1 failed');
		expect(lineOf('Restricted 4 samples').textContent).toContain('Someone');
		expect(lineOf('Restricted 4 samples').textContent).toContain('Undone');
		// the revert names its original, which is on the page
		const rev = lineOf('Revert of');
		expect(rev.textContent).toContain('Revert of ‘Shared 6 tests with a person (Can edit)’');
		expect(rev.textContent).toContain('2 put back, 1 left as it is');
		expect(rev.querySelector('.badge')!.textContent).toBe('Revert');
	});

	it('offers Revert only on an applied or partly reverted action that is not itself a revert', async () => {
		mount({ list: () => JOURNAL });
		await vi.waitFor(() => expect(document.querySelector('li.action')).not.toBeNull());
		const has = (words: string) => !!Array.from(lineOf(words).querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Revert');
		expect(has('Assigned 3 samples to a team')).toBe(true);
		expect(has('Set status to Archived')).toBe(true);
		expect(has('Restricted 4 samples')).toBe(false);
		expect(has('Revert of')).toBe(false);
		expect(has('Shared 6 tests')).toBe(false);
	});

	it('says so when no bulk action has been run, and when the list cannot be read', async () => {
		mount({ list: () => ({ actions: [], has_more: false }) });
		await vi.waitFor(() => expect(text()).toContain('No bulk action has been run yet.'));
		app!.unmount();
		document.body.replaceChildren();
		mount({ list: () => { throw failure(500, 'The database is busy'); } });
		await vi.waitFor(() => expect(text()).toContain('The bulk actions could not be loaded: The database is busy. Try Reload in a moment.'));
		expect(document.querySelector('[role="alert"]')).not.toBeNull();
	});

	it('stays when the admin overview above could not load', async () => {
		mount({ list: () => JOURNAL });
		await vi.waitFor(() => expect(text()).toContain('The admin overview is not available right now'));
		await vi.waitFor(() => expect(document.querySelector('li.action')).not.toBeNull());
	});

	it('pages with Show more, by the number of lines shown, until there is no more', async () => {
		const second = [line('c'), line('d')];
		mount({
			pages: {
				0: { actions: [line('a'), line('b')], has_more: true },
				2: { actions: second, has_more: false },
			},
		});
		await vi.waitFor(() => expect(document.querySelectorAll('li.action')).toHaveLength(2));
		expect(calls.find((c) => c.path === '/d1-bulk-actions')!.params).toEqual({ limit: 25 });
		buttons('Show more')[0].click();
		await vi.waitFor(() => expect(document.querySelectorAll('li.action')).toHaveLength(4));
		expect(calls.filter((c) => c.path === '/d1-bulk-actions').at(-1)!.params).toEqual({ limit: 25, offset: 2 });
		expect(buttons('Show more')).toHaveLength(0);
	});

	it('opens a line to its records, with the reason and what a revert did, and closes it again', async () => {
		mount({
			list: () => ({ actions: [line('applied')], has_more: false }),
			detail: () => ({
				action: line('applied'),
				rows: [
					{ record_id: 'r1', record_code: 'S-1', outcome: 'applied', revert_outcome: 'reverted' },
					{ record_id: 'r2', record_code: 'S-2', outcome: 'skipped', reason: 'You are not the owner of this record.', revert_outcome: null },
					{ record_id: 'r3', record_code: 'S-3', outcome: 'applied', revert_outcome: 'changed_since', revert_reason: 'Changed since this action ran, so it was left alone.' },
				],
			}),
		});
		await vi.waitFor(() => expect(document.querySelector('li.action')).not.toBeNull());
		const toggle = document.querySelector<HTMLButtonElement>('button.toggle')!;
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		toggle.click();
		await vi.waitFor(() => expect(document.querySelector('table')).not.toBeNull());
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		expect(calls.some((c) => c.path === '/d1-bulk-actions/applied')).toBe(true);
		const rows = Array.from(document.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.querySelectorAll('th,td')).map((c) => c.textContent?.trim()));
		expect(rows).toEqual([
			['S-1', 'Changed', '', 'Reverted'],
			['S-2', 'Skipped', 'You are not the owner of this record', ''],
			['S-3', 'Changed', '', 'Changed sinceChanged since, so it was left as it is'],
		]);
		toggle.click();
		await nextTick();
		expect(document.querySelector('table')).toBeNull();
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
	});

	it('says what failed when a line cannot be opened, and tries again', async () => {
		let fail = true;
		mount({
			list: () => ({ actions: [line('applied')], has_more: false }),
			detail: () => {
				if (fail) throw failure(404, 'That bulk action does not exist, or you cannot see it.');
				return { action: line('applied'), rows: [{ record_id: 'r1', record_code: 'S-1', outcome: 'applied' }] };
			},
		});
		await vi.waitFor(() => expect(document.querySelector('li.action')).not.toBeNull());
		document.querySelector<HTMLButtonElement>('button.toggle')!.click();
		await vi.waitFor(() => expect(text()).toContain('Close it and open it again.'));
		fail = false;
		buttons('Try again')[0].click();
		await vi.waitFor(() => expect(document.querySelector('table')).not.toBeNull());
	});
});

describe('Revert', () => {
	const REVERTED = {
		state: 'partly_reverted', revert_action_id: 'rev-9',
		results: [
			{ id: 'r1', code: 'S-1', revert_outcome: 'reverted' },
			{ id: 'r2', code: 'S-2', revert_outcome: 'changed_since', reason: 'Changed since this action ran, so it was left alone.' },
			{ id: 'r3', code: 'S-3', revert_outcome: 'refused', reason: 'The team that owned this record has no manager now, so it cannot be handed back.' },
			{ id: 'r4', code: 'S-4', revert_outcome: 'failed' },
		],
	};
	const revertButton = () => buttons('Revert')[0];
	const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

	it('asks first, says what will be reverted and the cautions, and focuses Cancel', async () => {
		mount({ list: () => ({ actions: [line('applied')], has_more: false }), revert: () => REVERTED });
		await vi.waitFor(() => expect(revertButton()).toBeDefined());
		revertButton().click();
		await vi.waitFor(() => expect(dialog()).not.toBeNull());
		const d = dialog()!;
		expect(d.textContent).toContain('Revert this bulk action?');
		expect(d.textContent).toContain('Assigned 3 samples to a team, by Ann Lee');
		expect(d.textContent).toContain('Reverting puts 3 samples back as they were before.');
		expect(d.textContent).toContain('A record changed since this action ran is skipped and left as it is.');
		expect(d.textContent).toContain('A revert cannot be reverted.');
		expect(calls.some((c) => c.method === 'post')).toBe(false);
		await vi.waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe('Cancel'));
		expect(d.getAttribute('aria-modal')).toBe('true');
	});

	it('closes with Escape without reverting, and hands focus back to the Revert button', async () => {
		mount({ list: () => ({ actions: [line('applied')], has_more: false }), revert: () => REVERTED });
		await vi.waitFor(() => expect(revertButton()).toBeDefined());
		const opener = revertButton();
		opener.click();
		await vi.waitFor(() => expect(dialog()).not.toBeNull());
		dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await vi.waitFor(() => expect(dialog()).toBeNull());
		await flush();
		expect(calls.some((c) => c.method === 'post')).toBe(false);
		expect(document.activeElement).toBe(opener);
	});

	it('keeps Tab inside the dialog', async () => {
		mount({ list: () => ({ actions: [line('applied')], has_more: false }), revert: () => REVERTED });
		await vi.waitFor(() => expect(revertButton()).toBeDefined());
		revertButton().click();
		await vi.waitFor(() => expect(dialog()).not.toBeNull());
		const stops = Array.from(dialog()!.querySelectorAll<HTMLButtonElement>('button'));
		stops.at(-1)!.focus();
		dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
		expect(document.activeElement).toBe(stops[0]);
		dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
		expect(document.activeElement).toBe(stops.at(-1));
	});

	it('reverts, lists every record with its outcome (refused with its reason), reloads the list and focuses the panel when the button is gone', async () => {
		let reverted = false;
		mount({
			list: () => (reverted
				? { actions: [line('rev-9', { revert_of: 'applied', n_applied: 1, n_skipped: 2, n_failed: 1 }), line('applied', { state: 'partly_reverted' })], has_more: false }
				: { actions: [line('applied')], has_more: false }),
			revert: () => {
				reverted = true;
				return REVERTED;
			},
		});
		await vi.waitFor(() => expect(revertButton()).toBeDefined());
		revertButton().click();
		await vi.waitFor(() => expect(dialog()).not.toBeNull());
		buttons('Revert 3 samples')[0].click();
		await vi.waitFor(() => expect(dialog()!.textContent).toContain('Revert finished'));
		const d = dialog()!;
		expect(calls.filter((c) => c.method === 'post').map((c) => c.path)).toEqual(['/d1-bulk-actions/applied/revert']);
		expect(d.textContent).toContain('Put back 1 of 4 samples. 1 changed since, 1 refused, 1 failed.');
		// the button that was pressed is gone: focus moved to Close, not lost
		await vi.waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe('Close'));
		const lines = Array.from(d.querySelectorAll('.lines li')).map((li) => li.textContent?.replace(/\s+/g, ' ').trim());
		expect(lines).toEqual([
			'S-4FailedCould not be undone',
			'S-3RefusedThe team that owned this record has no manager now, so it cannot be handed back',
			'S-2Changed sinceChanged since, so it was left as it is',
			'S-1Reverted',
		]);
		// the list was read again: the original is now partly reverted and the revert has its own line
		await vi.waitFor(() => expect(document.querySelectorAll('li.action')).toHaveLength(2));
		expect(lineOf('Revert of').textContent).toContain('1 put back, 2 left as they are, 1 failed');
		// a partly reverted action can be tried again, so its Revert button stays; Close hands focus back to it (or to the panel when it is gone)
		buttons('Close').find((b) => dialog()!.contains(b))!.click();
		await vi.waitFor(() => expect(dialog()).toBeNull());
		await flush();
		expect(document.activeElement === document.querySelector('.bulk-admin') || document.activeElement?.getAttribute('aria-label')?.startsWith('Revert:')).toBe(true);
	});

	it('says what failed, keeps the dialog open and reloads the list', async () => {
		let reverted = false;
		mount({
			list: () => ({ actions: [line('applied', reverted ? { state: 'reverted' } : {})], has_more: false }),
			revert: () => {
				reverted = true;
				return failure(409, 'That bulk action has already been undone or reverted.');
			},
		});
		await vi.waitFor(() => expect(revertButton()).toBeDefined());
		revertButton().click();
		await vi.waitFor(() => expect(dialog()).not.toBeNull());
		buttons('Revert 3 samples')[0].click();
		await vi.waitFor(() => expect(dialog()!.textContent).toContain('The revert failed: That bulk action has already been undone or reverted. The list has been reloaded; check it before you try again.'));
		expect(dialog()!.querySelector('[role="alert"]')).not.toBeNull();
		await vi.waitFor(() => expect(lineOf('Assigned 3 samples').textContent).toContain('Reverted'));
		expect(Array.from(lineOf('Assigned 3 samples').querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Revert')).toBe(false);
	});
});

describe('who sees the panel', () => {
	it('shows nothing and asks for nothing when the person is not a confirmed administrator (a member, a Lab Viewer)', async () => {
		const { api } = mount({ list: () => JOURNAL }, { isAdmin: false });
		await flush();
		expect(text()).not.toContain('Bulk actions');
		expect(document.querySelector('li.action')).toBeNull();
		expect(api.get).not.toHaveBeenCalled();
	});

	it('appears, and reads the journal, when the server confirms an administrator, and goes again if that is withdrawn', async () => {
		const { api, on } = mount({ list: () => JOURNAL }, { isAdmin: false });
		await flush();
		expect(api.get).not.toHaveBeenCalled();
		on.value = true;
		await vi.waitFor(() => expect(document.querySelector('li.action')).not.toBeNull());
		on.value = false;
		await flush();
		expect(text()).not.toContain('Bulk actions');
	});
});
