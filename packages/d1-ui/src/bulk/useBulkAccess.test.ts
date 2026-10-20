// useBulkActions with the ownership and access kinds (assign_team, change_owner, share_access, remove_access): the params the endpoint is
// sent, the team list, the access level, the warnings that reach the toast, and the toast's words.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import type { AccessApi } from '../access/accessApi';
import { indexDefBySlug } from '../index/indexConfig';
import { bulkEntries } from './bulkModel';
import { useBulkActions } from './useBulkActions';

const operations = indexDefBySlug('operations')!;
const entries = bulkEntries(operations);
const entry = (id: string) => entries.find((e) => e.id === id)!;
const T0 = Date.parse('2026-10-20T10:00:00Z');
const flush = async () => {
	for (let i = 0; i < 6; i++) await Promise.resolve();
};

const TEAMS = [{ team_id: 't1', name: 'Team X', description: null, color: 'blue', logo: null, member_count: 4, managers: [], is_member: true, is_manager: true }];

type Post = (path: string, body?: any) => Promise<{ data: any }>;
function setup(post: Post, get?: (path: string) => Promise<{ data: any }>) {
	const api = {
		get: vi.fn(get ?? (async (path: string) => ({ data: path === '/d1-teams' ? { teams: TEAMS } : { data: [] } }))), post: vi.fn(post), patch: vi.fn(), delete: vi.fn(),
	} as unknown as AccessApi & { post: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
	const changed: string[][] = [];
	const scope = effectScope();
	const bulk = scope.run(() => useBulkActions({ api, def: operations, picked: ref(['a', 'b', 'c']), onChanged: (keep) => changed.push(keep) }))!;
	return { api, bulk, changed, stop: () => scope.stop() };
}
const preview = (rows: [string, string, string?, string?][]) => ({
	data: { results: rows.map(([id, status, reason, warning]) => ({ id, code: `O-${id}`, status, reason, warning })) },
});
const applied = (ids: string[], undoUntil = new Date(T0 + 60_000).toISOString()) => ({
	data: { action_id: 'act-1', undo_until: undoUntil, results: ids.map((id) => ({ id, code: `O-${id}`, outcome: 'applied' })) },
});
const previews = (t: ReturnType<typeof setup>) => t.api.post.mock.calls.filter((c: any[]) => String(c[0]).endsWith('/preview')).map((c: any[]) => c[1]);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('Assign to team', () => {
	it('loads the teams, waits for one, previews it and says its name on the toast', async () => {
		const t = setup(async (path) => (path.endsWith('/apply') ? applied(['a', 'b', 'c']) : preview([['a', 'ok'], ['b', 'ok'], ['c', 'ok']])));
		t.bulk.open(entry('assign_team'));
		await flush();
		expect(t.api.get).toHaveBeenCalledWith('/d1-teams');
		expect(t.bulk.teamOptions.value.map((x) => x.name)).toEqual(['Team X']);
		expect(t.api.post).not.toHaveBeenCalled();
		t.bulk.choose('t1', 'Team X', 'team');
		await flush();
		expect(previews(t)).toEqual([{ kind: 'assign_team', ids: ['a', 'b', 'c'], params: { team_id: 't1' } }]);
		expect(t.bulk.ready.value).toBe(true);
		await t.bulk.apply();
		expect(t.api.post).toHaveBeenLastCalledWith('/d1-bulk-actions/manufacturing_operations/apply', { kind: 'assign_team', ids: ['a', 'b', 'c'], params: { team_id: 't1' } });
		expect(t.bulk.toasts.value[0].message).toBe('Assigned 3 operations to Team X');
		expect(t.bulk.dialog.value).toBeNull();
		t.stop();
	});

	it('says why the team list failed, and keeps Apply off', async () => {
		const t = setup(async () => preview([]), async () => {
			throw Object.assign(new Error('x'), { response: { data: { errors: [{ message: 'Teams are not available.' }] } } });
		});
		t.bulk.open(entry('assign_team'));
		await flush();
		expect(t.bulk.optionsState.value.error).toBe('Teams are not available.');
		expect(t.bulk.teamOptions.value).toEqual([]);
		expect(t.bulk.ready.value).toBe(false);
		t.stop();
	});

	it('loads no team list for the kinds that search', async () => {
		const t = setup(async () => preview([]));
		t.bulk.open(entry('change_owner'));
		await flush();
		expect(t.api.get).not.toHaveBeenCalled();
		t.stop();
	});
});

describe('Change owner', () => {
	it('sends the person, and can take the choice back to pick another', async () => {
		const t = setup(async () => preview([['a', 'ok'], ['b', 'skip', 'You are not the owner'], ['c', 'noop']]));
		t.bulk.open(entry('change_owner'));
		t.bulk.choose('p1', 'Ann Lee', 'person');
		await flush();
		expect(previews(t)).toEqual([{ kind: 'change_owner', ids: ['a', 'b', 'c'], params: { person_id: 'p1' } }]);
		expect(t.bulk.summary.value).toBe('1 can be changed. 1 needs no change. 1 will be skipped');
		t.bulk.clearChoice();
		await flush();
		expect(t.bulk.dialog.value?.choice).toBeNull();
		expect(t.bulk.preview.value.rows).toBeNull();
		expect(t.bulk.ready.value).toBe(false);
		t.stop();
	});
});

describe('Share or change access', () => {
	it('previews at once with Can view, and again when the level changes', async () => {
		const t = setup(async () => preview([['a', 'ok']]));
		t.bulk.open(entry('share_access'));
		t.bulk.choose('p1', 'Ann', 'person');
		await flush();
		t.bulk.chooseRole('edit');
		await flush();
		expect(previews(t).map((b) => b.params)).toEqual([{ person_id: 'p1', role: 'view' }, { person_id: 'p1', role: 'edit' }]);
		t.stop();
	});

	it('keeps a level chosen before the target, and sends a team as team_id', async () => {
		const t = setup(async () => preview([['a', 'ok']]));
		t.bulk.open(entry('share_access'));
		t.bulk.chooseRole('edit');
		await flush();
		expect(t.api.post).not.toHaveBeenCalled();
		t.bulk.choose('t1', 'Team X', 'team');
		await flush();
		expect(previews(t)[0]).toEqual({ kind: 'share_access', ids: ['a', 'b', 'c'], params: { team_id: 't1', role: 'edit' } });
		t.stop();
	});

	it('words the toast without the level', async () => {
		const t = setup(async (path) => (path.endsWith('/apply') ? applied(['a', 'b']) : preview([['a', 'ok'], ['b', 'ok']])));
		t.bulk.open(entry('share_access'));
		t.bulk.choose('p1', 'Ann', 'person');
		await flush();
		await t.bulk.apply();
		expect(t.bulk.toasts.value[0].message).toBe('Shared 2 operations with Ann');
		t.stop();
	});
});

describe('Remove access', () => {
	it('sends the person or the team, and words the toast', async () => {
		const t = setup(async (path) => (path.endsWith('/apply') ? applied(['a']) : preview([['a', 'ok'], ['b', 'noop']])));
		t.bulk.open(entry('remove_access'));
		t.bulk.choose('t1', 'Team X', 'team');
		await flush();
		expect(previews(t)[0].params).toEqual({ team_id: 't1' });
		await t.bulk.apply();
		expect(t.bulk.toasts.value[0].message).toBe('Removed access for Team X on 1 operation');
		t.stop();
	});
});

describe('warnings', () => {
	const WARN = 'You may lose access to this record';
	it('are counted in the dialog and carried to the toast only for the rows that changed', async () => {
		const t = setup(async (path) => (path.endsWith('/apply')
			? { data: { action_id: 'a1', undo_until: new Date(T0 + 60_000).toISOString(), results: [
				{ id: 'a', code: 'O-a', outcome: 'applied' }, { id: 'b', code: 'O-b', outcome: 'skipped', reason: 'Changed since' }, { id: 'c', code: 'O-c', outcome: 'applied' },
			] } }
			: preview([['a', 'ok', undefined, WARN], ['b', 'ok', undefined, WARN], ['c', 'ok']])));
		t.bulk.open(entry('assign_team'));
		t.bulk.choose('t1', 'Team X', 'team');
		await flush();
		expect(t.bulk.warnings.value).toEqual([WARN]);
		await t.bulk.apply();
		const toast = t.bulk.toasts.value[0];
		expect(toast.warned).toEqual([{ id: 'a', code: 'O-a', reason: WARN }]);
		expect(toast.skipped.map((r) => r.id)).toEqual(['b']);
		t.stop();
	});
});
