import { describe, expect, it, vi } from 'vitest';
import type { AccessApi } from '../access/accessApi';
import { indexDefBySlug } from '../index/indexConfig';
import { applyBulk, listBulk, loadFieldOptions, previewBulk, revertBulk, undoBulk } from './bulkApi';

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

describe('listBulk', () => {
	it('reads the journal lines and tolerates missing fields', async () => {
		const api = fakeApi({ get: async () => ({ data: { actions: [{ action_id: 'x', collection: 'physical_samples', kind: 'restrict', state: 'applied', n_applied: 3 }, 7] } }) });
		const out = await listBulk(api, { limit: 20 });
		expect(api.get).toHaveBeenCalledWith('/d1-bulk-actions', { params: { limit: 20 } });
		expect(out).toMatchObject({ ok: true, data: [{ action_id: 'x', kind: 'restrict', n_applied: 3, n_skipped: 0, n_failed: 0, actor_user: '' }] });
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
