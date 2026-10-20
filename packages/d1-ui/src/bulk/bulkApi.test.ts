import { describe, expect, it, vi } from 'vitest';
import type { AccessApi } from '../access/accessApi';
import { indexDefBySlug } from '../index/indexConfig';
import { applyBulk, getBulk, listBulk, loadFieldOptions, previewBulk, revertBulk, undoBulk } from './bulkApi';

const fakeApi = (over: Partial<Record<'get' | 'post', (...a: any[]) => any>> = {}) => {
	const api = { get: vi.fn(over.get ?? (async () => ({ data: {} }))), post: vi.fn(over.post ?? (async () => ({ data: {} }))), patch: vi.fn(), delete: vi.fn() };
	return api as typeof api & AccessApi;
};
const failure = (status: number, message: string) => Object.assign(new Error('Request failed'), { response: { status, data: { errors: [{ message }] } } });

describe('previewBulk', () => {
	it('posts kind, ids and params to the collection and maps the rows', async () => {
		const api = fakeApi({
			post: async () => ({
				data: {
					results: [
						{ id: 'a', code: 'S-1', status: 'ok' },
						{ id: 'b', code: 'S-2', status: 'skip', reason: 'You are not the owner' },
						{ id: 'c', status: 'noop', warning: '  ' },
					],
					counts: { ok: 1 },
				},
			}),
		});
		const out = await previewBulk(api, 'physical_samples', 'edit_field', ['a', 'b', 'c'], { field: 'current_status', value: 'archived' });
		expect(api.post).toHaveBeenCalledWith('/d1-bulk-actions/physical_samples/preview', { kind: 'edit_field', ids: ['a', 'b', 'c'], params: { field: 'current_status', value: 'archived' } });
		expect(out).toEqual({
			ok: true,
			data: [
				{ id: 'a', code: 'S-1', status: 'ok', reason: undefined, warning: undefined },
				{ id: 'b', code: 'S-2', status: 'skip', reason: 'You are not the owner', warning: undefined },
				{ id: 'c', code: 'c', status: 'noop', reason: undefined, warning: undefined },
			],
		});
	});
	it('reads a row it does not understand as skipped, never as changeable', async () => {
		const api = fakeApi({ post: async () => ({ data: { results: [{ id: 'a', status: 'maybe' }, 'junk', null] } }) });
		const out = await previewBulk(api, 'physical_samples', 'restrict', ['a'], {});
		expect(out).toMatchObject({ ok: true, data: [{ id: 'a', status: 'skip' }] });
	});
	it('answers with the endpoint message instead of throwing', async () => {
		const api = fakeApi({ post: async () => { throw failure(403, 'Your account can look but not change.'); } });
		expect(await previewBulk(api, 'physical_samples', 'restrict', ['a'], {})).toEqual({ ok: false, message: 'Your account can look but not change.' });
	});
	it('says so when the server cannot be reached', async () => {
		const api = fakeApi({ post: async () => { throw Object.assign(new Error(''), {}); } });
		expect(await previewBulk(api, 'physical_samples', 'restrict', ['a'], {})).toEqual({ ok: false, message: 'Could not reach the server.' });
	});
	it('encodes the collection in the address', async () => {
		const api = fakeApi();
		await previewBulk(api, 'a/b', 'restrict', [], {});
		expect(api.post.mock.calls[0][0]).toBe('/d1-bulk-actions/a%2Fb/preview');
	});
});

describe('applyBulk', () => {
	it('maps the action id, the undo time and the rows', async () => {
		const api = fakeApi({
			post: async () => ({
				data: {
					action_id: 'act-1', undo_until: '2026-10-20T10:01:00Z',
					results: [{ id: 'a', code: 'S-1', outcome: 'applied' }, { id: 'b', code: 'S-2', outcome: 'skipped', reason: 'No' }, { id: 'c', outcome: 'weird' }],
				},
			}),
		});
		const out = await applyBulk(api, 'physical_samples', 'restrict', ['a', 'b', 'c'], {});
		expect(api.post).toHaveBeenCalledWith('/d1-bulk-actions/physical_samples/apply', { kind: 'restrict', ids: ['a', 'b', 'c'], params: {} });
		expect(out).toEqual({
			ok: true,
			data: {
				actionId: 'act-1', undoUntil: '2026-10-20T10:01:00Z',
				results: [
					{ id: 'a', code: 'S-1', outcome: 'applied', reason: undefined },
					{ id: 'b', code: 'S-2', outcome: 'skipped', reason: 'No' },
					{ id: 'c', code: 'c', outcome: 'failed', reason: undefined },
				],
			},
		});
	});
	it('answers with the message when the cap is exceeded', async () => {
		const api = fakeApi({ post: async () => { throw failure(400, 'At most 100 records at a time.'); } });
		expect(await applyBulk(api, 'physical_samples', 'restrict', [], {})).toEqual({ ok: false, message: 'At most 100 records at a time.' });
	});
});

describe('undoBulk and revertBulk', () => {
	const answer = { data: { state: 'partly_reverted', results: [{ id: 'a', revert_outcome: 'reverted' }, { id: 'b', revert_outcome: 'changed_since' }, { id: 'c', revert_outcome: 'nope' }] } };
	it('post to the action and map the per-row outcome', async () => {
		const api = fakeApi({ post: async () => answer });
		const expected = {
			ok: true,
			data: { state: 'partly_reverted', results: [{ id: 'a', revert_outcome: 'reverted' }, { id: 'b', revert_outcome: 'changed_since' }, { id: 'c', revert_outcome: 'failed' }] },
		};
		expect(await undoBulk(api, 'act 1')).toMatchObject(expected);
		expect(api.post.mock.calls[0][0]).toBe('/d1-bulk-actions/act%201/undo');
		expect(await revertBulk(api, 'act-1')).toMatchObject(expected);
		expect(api.post.mock.calls[1][0]).toBe('/d1-bulk-actions/act-1/revert');
	});
	it('say why when the window has closed', async () => {
		const api = fakeApi({ post: async () => { throw failure(403, 'The undo window has closed.'); } });
		expect(await undoBulk(api, 'act-1')).toEqual({ ok: false, message: 'The undo window has closed.' });
	});
});

describe('revertBulk keeps the codes and the line it wrote', () => {
	it('carries each row code and the revert action id when the endpoint sends them', async () => {
		const api = fakeApi({ post: async () => ({ data: { state: 'reverted', revert_action_id: 'rev-1', results: [{ id: 'a', code: 'S-1', revert_outcome: 'reverted' }, { id: 'b', revert_outcome: 'refused', reason: 'No' }] } }) });
		expect(await revertBulk(api, 'act-1')).toEqual({
			ok: true,
			data: { state: 'reverted', revertActionId: 'rev-1', results: [{ id: 'a', code: 'S-1', revert_outcome: 'reverted', reason: undefined }, { id: 'b', revert_outcome: 'refused', reason: 'No' }] },
		});
	});
});

describe('listBulk', () => {
	it('reads the journal lines, keeps who, params, undo_until and revert_of, and tolerates missing fields', async () => {
		const api = fakeApi({
			get: async () => ({
				data: {
					actions: [
						{ action_id: 'x', collection: 'physical_samples', kind: 'restrict', state: 'applied', n_applied: 3 },
						{
							action_id: 'y', actor_user: 'u1', actor_name: 'Ann Lee', collection: 'test_sessions', kind: 'edit_field', params: { field: 'status', value: 'failed' },
							state: 'applied', created_at: '2026-10-20T10:00:00Z', undo_until: '2026-10-20T10:01:00Z', revert_of: 'x', mail_state: 'none', n_applied: 2, n_skipped: 1, n_failed: 0,
						},
						7,
					],
					limit: 20, offset: 0, has_more: true,
				},
			}),
		});
		const out = await listBulk(api, { limit: 20, offset: 40 });
		expect(api.get).toHaveBeenCalledWith('/d1-bulk-actions', { params: { limit: 20, offset: 40 } });
		expect(out).toMatchObject({ ok: true, data: { hasMore: true } });
		const actions = (out as any).data.actions;
		expect(actions).toHaveLength(2);
		expect(actions[0]).toMatchObject({ action_id: 'x', kind: 'restrict', n_applied: 3, n_skipped: 0, n_failed: 0, actor_user: '', actor_name: '', params: {}, revert_of: null });
		expect(actions[1]).toEqual({
			action_id: 'y', actor_user: 'u1', actor_name: 'Ann Lee', collection: 'test_sessions', kind: 'edit_field', params: { field: 'status', value: 'failed' }, state: 'applied',
			created_at: '2026-10-20T10:00:00Z', undo_until: '2026-10-20T10:01:00Z', revert_of: 'x', mail_state: 'none', n_applied: 2, n_skipped: 1, n_failed: 0,
		});
	});
	it('says there is no next page unless the endpoint does', async () => {
		const api = fakeApi({ get: async () => ({ data: { actions: [] } }) });
		expect(await listBulk(api)).toEqual({ ok: true, data: { actions: [], hasMore: false } });
		expect(api.get).toHaveBeenCalledWith('/d1-bulk-actions', { params: {} });
	});
	it("gives the endpoint's own message when it refuses", async () => {
		const api = fakeApi({ get: async () => { throw failure(403, 'Forbidden'); } });
		expect(await listBulk(api)).toEqual({ ok: false, message: 'Forbidden' });
	});
});

describe('getBulk', () => {
	it('reads the action with its rows and their revert outcomes, without the snapshots', async () => {
		const api = fakeApi({
			get: async () => ({
				data: {
					action: { action_id: 'a/1', kind: 'assign_team', collection: 'physical_samples', state: 'partly_reverted', n_applied: 2 },
					rows: [
						{ record_id: 's1', record_code: 'S-1', outcome: 'applied', reason: null, before: { owner: 1 }, after: { owner: 2 }, revert_outcome: 'reverted', revert_reason: null },
						{ record_id: 's2', record_code: null, outcome: 'skipped', reason: 'You are not the owner', revert_outcome: null },
						{ record_id: 's3', record_code: 'S-3', outcome: 'applied', revert_outcome: 'changed_since', revert_reason: 'Changed since this action ran, so it was left alone.' },
						{ record_id: 's4', outcome: 'odd', revert_outcome: 'odd' },
					],
				},
			}),
		});
		const out = await getBulk(api, 'a/1');
		expect(api.get).toHaveBeenCalledWith('/d1-bulk-actions/a%2F1');
		expect(out).toEqual({
			ok: true,
			data: {
				action: expect.objectContaining({ action_id: 'a/1', state: 'partly_reverted', n_applied: 2 }),
				rows: [
					{ record_id: 's1', record_code: 'S-1', outcome: 'applied', reason: undefined, revert_outcome: 'reverted', revert_reason: undefined },
					{ record_id: 's2', record_code: 's2', outcome: 'skipped', reason: 'You are not the owner', revert_outcome: null, revert_reason: undefined },
					{ record_id: 's3', record_code: 'S-3', outcome: 'applied', reason: undefined, revert_outcome: 'changed_since', revert_reason: 'Changed since this action ran, so it was left alone.' },
					{ record_id: 's4', record_code: 's4', outcome: 'failed', reason: undefined, revert_outcome: null, revert_reason: undefined },
				],
			},
		});
	});
	it("gives the endpoint's message for an action that cannot be seen", async () => {
		const api = fakeApi({ get: async () => { throw failure(404, 'That bulk action does not exist, or you cannot see it.'); } });
		expect(await getBulk(api, 'x')).toEqual({ ok: false, message: 'That bulk action does not exist, or you cannot see it.' });
	});
});

describe('loadFieldOptions', () => {
	const project = indexDefBySlug('samples')!.bulkFields!.find((f) => f.field === 'project_id')!;
	it('reads the related rows like a relation chip', async () => {
		const api = fakeApi({ get: async () => ({ data: { data: [{ project_id: 'p1', project_code: 'P-100' }, { project_id: 'p2', project_code: null }] } }) });
		const out = await loadFieldOptions(api, project);
		expect(api.get.mock.calls[0][0]).toBe('/items/projects');
		expect(out).toEqual({ ok: true, data: [{ value: 'p1', label: 'P-100' }, { value: 'p2', label: 'p2' }] });
	});
	it('says so when the role cannot read the table', async () => {
		const api = fakeApi({ get: async () => { throw failure(403, 'You do not have permission to access this.'); } });
		expect(await loadFieldOptions(api, project)).toEqual({ ok: false, message: 'You do not have permission to access this.' });
	});
	it('refuses a field with no list', async () => {
		const api = fakeApi();
		const out = await loadFieldOptions(api, { field: 'current_status', label: 'Status', kind: 'enum', values: ['a'] });
		expect(out.ok).toBe(false);
	});
});

describe('loadFieldOptions of a campaign link', () => {
	const campaign = indexDefBySlug('operations')!.bulkFields!.find((f) => f.field === 'campaign_id')!;
	it('asks for the name too and labels a campaign without a code by it', async () => {
		const api = fakeApi({ get: async () => ({ data: { data: [{ campaign_id: 'c1', campaign_code: 'CMP-1', name: 'Alpha' }, { campaign_id: 'c2', campaign_code: null, name: 'Beta' }] } }) });
		const out = await loadFieldOptions(api, campaign);
		expect(api.get.mock.calls[0][0]).toBe('/items/campaigns');
		expect((api.get.mock.calls[0][1] as any).params.fields).toEqual(['campaign_id', 'campaign_code', 'name']);
		expect(out).toEqual({ ok: true, data: [{ value: 'c1', label: 'CMP-1' }, { value: 'c2', label: 'Beta' }] });
	});
});
