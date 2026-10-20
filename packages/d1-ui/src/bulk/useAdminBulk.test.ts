import { describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import type { AccessApi } from '../access/accessApi';
import { useAdminBulk } from './useAdminBulk';

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}
const flush = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
};
const failure = (status: number, message: string) => Object.assign(new Error('Request failed'), { response: { status, data: { errors: [{ message }] } } });

const raw = (id: string, over: Record<string, unknown> = {}) => ({
	action_id: id, actor_user: 'u1', actor_name: 'Ann Lee', collection: 'physical_samples', kind: 'assign_team', params: { team_id: 't1' }, state: 'applied',
	created_at: '2026-10-20T10:00:00Z', undo_until: '2026-10-20T10:01:00Z', revert_of: null, mail_state: 'sent', n_applied: 3, n_skipped: 0, n_failed: 0, ...over,
});
const page = (ids: string[], hasMore = false) => ({ data: { actions: ids.map((id) => raw(id)), limit: 2, offset: 0, has_more: hasMore } });

type Get = (path: string, config?: any) => Promise<{ data: any }>;
type Post = (path: string, body?: any) => Promise<{ data: any }>;
function setup(get: Get, post: Post = async () => ({ data: {} }), active = true, pageSize = 2) {
	const api = { get: vi.fn(get), post: vi.fn(post), patch: vi.fn(), delete: vi.fn() } as unknown as AccessApi & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };
	const on = ref(active);
	const scope = effectScope();
	const bulk = scope.run(() => useAdminBulk({ api, active: on, pageSize }))!;
	return { api, bulk, on, stop: () => scope.stop() };
}
const ids = (b: { actions: { value: { action_id: string }[] } }) => b.actions.value.map((a) => a.action_id);

describe('the list', () => {
	it('reads nothing while inactive, and the first page when it turns active', async () => {
		const t = setup(async () => page(['a', 'b'], true), undefined, false);
		await flush();
		expect(t.api.get).not.toHaveBeenCalled();
		t.on.value = true;
		await nextTick();
		await flush();
		expect(t.api.get).toHaveBeenCalledWith('/d1-bulk-actions', { params: { limit: 2 } });
		expect(ids(t.bulk)).toEqual(['a', 'b']);
		expect(t.bulk.hasMore.value).toBe(true);
		expect(t.bulk.loaded.value).toBe(true);
		t.stop();
	});

	it('forgets everything when it turns inactive, and reads nothing more', async () => {
		const t = setup(async () => page(['a'], true));
		await flush();
		t.bulk.toggle('a');
		t.on.value = false;
		await nextTick();
		await flush();
		expect(t.bulk.actions.value).toEqual([]);
		expect(t.bulk.details.value).toEqual({});
		expect(t.bulk.loaded.value).toBe(false);
		const calls = t.api.get.mock.calls.length;
		await t.bulk.more();
		expect(t.api.get.mock.calls.length).toBe(calls);
		t.stop();
	});

	it('pages: Show more asks by the number shown, keeps a shifted line once, and stops when there is no more', async () => {
		const get: Get = async (_p, config) => {
			const offset = config?.params?.offset ?? 0;
			if (offset === 0) return page(['a', 'b'], true);
			// a new action shifted the pages: 'b' comes again
			return page(['b', 'c'], false);
		};
		const t = setup(get);
		await flush();
		await t.bulk.more();
		expect(t.api.get).toHaveBeenLastCalledWith('/d1-bulk-actions', { params: { limit: 2, offset: 2 } });
		expect(ids(t.bulk)).toEqual(['a', 'b', 'c']);
		expect(t.bulk.hasMore.value).toBe(false);
		const calls = t.api.get.mock.calls.length;
		await t.bulk.more();
		expect(t.api.get.mock.calls.length).toBe(calls);
		t.stop();
	});

	it('does not start a second page while one is running', async () => {
		const second = deferred<{ data: any }>();
		let n = 0;
		const t = setup(async () => (n++ === 0 ? page(['a', 'b'], true) : second.promise));
		await flush();
		const first = t.bulk.more();
		void t.bulk.more();
		expect(t.bulk.loadingMore.value).toBe(true);
		second.resolve(page(['c'], false));
		await first;
		expect(t.api.get).toHaveBeenCalledTimes(2);
		expect(ids(t.bulk)).toEqual(['a', 'b', 'c']);
		t.stop();
	});

	it('drops a page that arrives after a reload', async () => {
		const late = deferred<{ data: any }>();
		let n = 0;
		const t = setup(async () => {
			n += 1;
			if (n === 1) return page(['a', 'b'], true);
			if (n === 2) return late.promise;
			return page(['x', 'y'], false);
		});
		await flush();
		const slow = t.bulk.more();
		await t.bulk.load();
		late.resolve(page(['old'], false));
		await slow;
		expect(ids(t.bulk)).toEqual(['x', 'y']);
		expect(t.bulk.loadingMore.value).toBe(false);
		t.stop();
	});

	it('says what failed and what to do, and keeps the lines already shown', async () => {
		let n = 0;
		const t = setup(async () => {
			n += 1;
			if (n === 1) return page(['a', 'b'], true);
			throw failure(500, 'The database is busy');
		});
		await flush();
		await t.bulk.more();
		expect(t.bulk.error.value).toBe('The next bulk actions could not be loaded: The database is busy. Press Show more to try again.');
		expect(ids(t.bulk)).toEqual(['a', 'b']);
		await t.bulk.load();
		expect(t.bulk.error.value).toBe('The bulk actions could not be loaded: The database is busy. Try Reload in a moment.');
		expect(ids(t.bulk)).toEqual(['a', 'b']);
		t.stop();
	});

	it('shows an empty journal as an answer, not an error', async () => {
		const t = setup(async () => page([]));
		await flush();
		expect(t.bulk.loaded.value).toBe(true);
		expect(t.bulk.actions.value).toEqual([]);
		expect(t.bulk.error.value).toBe('');
		t.stop();
	});
});

describe('expanding a line', () => {
	const detail = (id: string, codes: string[]) => ({
		data: { action: raw(id), rows: codes.map((c, i) => ({ record_id: `r${i}`, record_code: c, outcome: 'applied', revert_outcome: null })) },
	});
	const get = (rows: Record<string, string[]>): Get => async (path) => (path === '/d1-bulk-actions' ? page(Object.keys(rows)) : detail(path.split('/').pop()!, rows[path.split('/').pop()!]));

	it('reads the rows when first opened, keeps them when closed, and does not read them again on reopening', async () => {
		const t = setup(get({ a: ['S-1', 'S-2'], b: ['S-3'] }));
		await flush();
		t.bulk.toggle('a');
		expect(t.bulk.details.value.a).toMatchObject({ open: true, loading: true, rows: null });
		await flush();
		expect(t.bulk.details.value.a).toMatchObject({ open: true, loading: false, error: '' });
		expect(t.bulk.details.value.a.rows!.map((r) => r.record_code)).toEqual(['S-1', 'S-2']);
		t.bulk.toggle('a');
		expect(t.bulk.details.value.a.open).toBe(false);
		t.bulk.toggle('a');
		expect(t.bulk.details.value.a.open).toBe(true);
		expect(t.api.get.mock.calls.filter((c) => c[0] === '/d1-bulk-actions/a')).toHaveLength(1);
		t.stop();
	});

	it('says what failed when the rows cannot be read, and can try again', async () => {
		let fail = true;
		const t = setup(async (path) => {
			if (path === '/d1-bulk-actions') return page(['a']);
			if (fail) throw failure(404, 'That bulk action does not exist, or you cannot see it.');
			return detail('a', ['S-1']);
		});
		await flush();
		t.bulk.toggle('a');
		await flush();
		expect(t.bulk.details.value.a.error).toBe('The records of this action could not be loaded: That bulk action does not exist, or you cannot see it. Close it and open it again.');
		expect(t.bulk.details.value.a.rows).toBeNull();
		fail = false;
		await t.bulk.retryRows('a');
		expect(t.bulk.details.value.a).toMatchObject({ error: '', loading: false });
		expect(t.bulk.details.value.a.rows).toHaveLength(1);
		t.stop();
	});

	it('keeps each line to its own answer when two are opened together', async () => {
		const da = deferred<{ data: any }>();
		const db = deferred<{ data: any }>();
		const t = setup(async (path) => (path === '/d1-bulk-actions' ? page(['a', 'b']) : path.endsWith('/a') ? da.promise : db.promise));
		await flush();
		t.bulk.toggle('a');
		t.bulk.toggle('b');
		db.resolve(detail('b', ['B-1']));
		da.resolve(detail('a', ['A-1', 'A-2']));
		await flush();
		expect(t.bulk.details.value.a.rows).toHaveLength(2);
		expect(t.bulk.details.value.b.rows).toHaveLength(1);
		t.stop();
	});
});

describe('Revert', () => {
	const rev = (state = 'reverted', results: any[] = [{ id: 'r0', code: 'S-1', revert_outcome: 'reverted' }]) => ({ data: { state, revert_action_id: 'rev-1', results } });

	it('opens the dialog only for an action that can be reverted', async () => {
		const t = setup(async () => ({
			data: { actions: [raw('a'), raw('b', { state: 'undone' }), raw('c', { revert_of: 'a' }), raw('d', { n_applied: 0 }), raw('e', { state: 'partly_reverted' })], has_more: false },
		}));
		await flush();
		const by = (id: string) => t.bulk.actions.value.find((a) => a.action_id === id)!;
		for (const id of ['b', 'c', 'd']) {
			t.bulk.openRevert(by(id));
			expect(t.bulk.revert.value, id).toBeNull();
		}
		t.bulk.openRevert(by('e'));
		expect(t.bulk.revert.value?.action.action_id).toBe('e');
		t.bulk.closeRevert();
		expect(t.bulk.revert.value).toBeNull();
		t.stop();
	});

	it('posts the revert, shows the per-row result, reloads the list and reads the original rows afresh', async () => {
		let reverted = false;
		const rows = (outcome: string | null) => ({ data: { action: raw('a'), rows: [{ record_id: 'r0', record_code: 'S-1', outcome: 'applied', revert_outcome: outcome }] } });
		const t = setup(
			async (path) => {
				if (path === '/d1-bulk-actions') return reverted ? { data: { actions: [raw('rev-1', { revert_of: 'a' }), raw('a', { state: 'reverted' })], has_more: false } } : page(['a']);
				return rows(reverted ? 'reverted' : null);
			},
			async (path) => {
				reverted = true;
				expect(path).toBe('/d1-bulk-actions/a/revert');
				return rev();
			},
		);
		await flush();
		t.bulk.toggle('a');
		await flush();
		t.bulk.openRevert(t.bulk.actions.value[0]);
		const done = t.bulk.confirmRevert();
		expect(t.bulk.revert.value?.busy).toBe(true);
		await done;
		await flush();
		expect(t.bulk.revert.value).toMatchObject({ busy: false, error: '', result: { state: 'reverted', revertActionId: 'rev-1', results: [{ id: 'r0', code: 'S-1', revert_outcome: 'reverted' }] } });
		expect(ids(t.bulk)).toEqual(['rev-1', 'a']);
		expect(t.bulk.actions.value[1].state).toBe('reverted');
		expect(t.bulk.details.value.a.rows![0].revert_outcome).toBe('reverted');
		t.stop();
	});

	it('reports refused and changed-since rows and does not count them as reverted', async () => {
		const results = [
			{ id: 'r0', code: 'S-1', revert_outcome: 'reverted' },
			{ id: 'r1', code: 'S-2', revert_outcome: 'changed_since' },
			{ id: 'r2', code: 'S-3', revert_outcome: 'refused', reason: 'The team that owned this record has no manager now, so it cannot be handed back.' },
		];
		const t = setup(async () => page(['a']), async () => rev('partly_reverted', results));
		await flush();
		t.bulk.openRevert(t.bulk.actions.value[0]);
		await t.bulk.confirmRevert();
		expect(t.bulk.revert.value?.result?.state).toBe('partly_reverted');
		expect(t.bulk.revert.value?.result?.results.map((r) => r.revert_outcome)).toEqual(['reverted', 'changed_since', 'refused']);
		t.stop();
	});

	it('does not run twice, nor close while it runs, and shows the result only once', async () => {
		const answer = deferred<{ data: any }>();
		const t = setup(async () => page(['a']), () => answer.promise);
		await flush();
		t.bulk.openRevert(t.bulk.actions.value[0]);
		const first = t.bulk.confirmRevert();
		void t.bulk.confirmRevert();
		t.bulk.closeRevert();
		expect(t.bulk.revert.value).not.toBeNull();
		answer.resolve(rev());
		await first;
		expect(t.api.post).toHaveBeenCalledTimes(1);
		await t.bulk.confirmRevert();
		expect(t.api.post).toHaveBeenCalledTimes(1);
		t.bulk.closeRevert();
		expect(t.bulk.revert.value).toBeNull();
		t.stop();
	});

	it('says what failed, keeps the dialog open, and reloads the list so a stale Revert goes away', async () => {
		let stale = true;
		const t = setup(
			async () => (stale ? page(['a']) : { data: { actions: [raw('a', { state: 'reverted' })], has_more: false } }),
			async () => {
				stale = false;
				throw failure(409, 'That bulk action has already been undone or reverted.');
			},
		);
		await flush();
		t.bulk.openRevert(t.bulk.actions.value[0]);
		await t.bulk.confirmRevert();
		expect(t.bulk.revert.value).toMatchObject({
			busy: false, result: null,
			error: 'The revert failed: That bulk action has already been undone or reverted. The list has been reloaded; check it before you try again.',
		});
		expect(t.bulk.actions.value[0].state).toBe('reverted');
		t.stop();
	});
});
