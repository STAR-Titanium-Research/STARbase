import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useEditSession } from './useEditSession';

function setup(over: { item?: Record<string, any> | null; edits?: Record<string, any>; creating?: boolean; api?: Record<string, any> } = {}) {
	const api = {
		get: vi.fn().mockResolvedValue({ data: { data: { version: 3 } } }),
		patch: vi.fn().mockResolvedValue({}),
		post: vi.fn().mockResolvedValue({ data: { data: { sample_id: 'new-1' } } }),
		...over.api,
	};
	const item = ref<Record<string, any> | null>(over.item === undefined ? { sample_id: 's1', version: 3 } : over.item);
	const edits = ref<Record<string, any>>(over.edits ?? {});
	const onSaved = vi.fn();
	const onCancelled = vi.fn();
	const session = useEditSession({
		api,
		collection: () => 'physical_samples',
		endpoint: () => '/items/physical_samples/s1',
		item,
		edits,
		creating: () => over.creating ?? false,
		onSaved,
		onCancelled,
	});
	return { api, item, edits, onSaved, onCancelled, session };
}

describe('useEditSession: the save, version-conflict and discard rules EditDrawer and the edit frame share', () => {
	it('saves only the changed fields, after re-reading the version, then reports saved', async () => {
		const { api, session, onSaved } = setup({ edits: { nickname: 'bar' } });
		expect(session.hasEdits.value).toBe(true);
		await session.save();
		expect(api.get).toHaveBeenCalledWith('/items/physical_samples/s1', { params: { fields: ['version'] } });
		expect(api.patch).toHaveBeenCalledWith('/items/physical_samples/s1', { nickname: 'bar' });
		expect(onSaved).toHaveBeenCalledTimes(1);
		expect(session.saving.value).toBe(false);
	});
	it('sends nothing when nothing changed', async () => {
		const { api, session, onSaved } = setup();
		await session.save();
		expect(api.get).not.toHaveBeenCalled();
		expect(api.patch).not.toHaveBeenCalled();
		expect(onSaved).not.toHaveBeenCalled();
	});
	it('stops on a version conflict, and says what moved; Save anyway then overwrites', async () => {
		const { api, session, onSaved } = setup({ edits: { nickname: 'bar' }, api: { get: vi.fn().mockResolvedValue({ data: { data: { version: 5 } } }) } });
		await session.save();
		expect(session.conflict.value).toEqual({ loaded: 3, current: 5 });
		expect(api.patch).not.toHaveBeenCalled();
		expect(onSaved).not.toHaveBeenCalled();
		await session.save(true);
		expect(api.patch).toHaveBeenCalledTimes(1);
		expect(session.conflict.value).toBeNull();
		expect(onSaved).toHaveBeenCalledTimes(1);
	});
	it('does not check the version of a record that has none', async () => {
		const { api, session } = setup({ item: { sample_id: 's1' }, edits: { nickname: 'bar' } });
		await session.save();
		expect(api.get).not.toHaveBeenCalled();
		expect(api.patch).toHaveBeenCalled();
	});
	it('shows why a save failed (a refusal in plain words) and does not report saved', async () => {
		const e = { response: { status: 403, data: { errors: [{ message: 'x' }] } } };
		const { session, onSaved } = setup({ edits: { nickname: 'bar' }, api: { patch: vi.fn().mockRejectedValue(e) } });
		await session.save();
		expect(session.saveError.value).toEqual(['Only the owner or a co-owner can change this record.']);
		expect(onSaved).not.toHaveBeenCalled();
		expect(session.saving.value).toBe(false);
	});
	it('ignores a second Save while one is running', async () => {
		let release!: () => void;
		const patch = vi.fn(
			() =>
				new Promise<void>((r) => {
					release = r;
				}),
		);
		const { session } = setup({ edits: { a: 1 }, api: { patch } });
		const first = session.save();
		await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
		await session.save();
		release();
		await first;
		expect(patch).toHaveBeenCalledTimes(1);
	});
	it('Cancel closes at once with no edits; with edits it asks first, and Discard then closes', () => {
		const clean = setup();
		clean.session.cancel();
		expect(clean.onCancelled).toHaveBeenCalledTimes(1);
		expect(clean.session.confirmDiscard.value).toBe(false);

		const dirty = setup({ edits: { a: 1 } });
		dirty.session.cancel();
		expect(dirty.onCancelled).not.toHaveBeenCalled();
		expect(dirty.session.confirmDiscard.value).toBe(true);
		dirty.session.discard();
		expect(dirty.session.confirmDiscard.value).toBe(false);
		expect(dirty.onCancelled).toHaveBeenCalledTimes(1);
	});
	it('reset clears the last error and conflict (a reload)', async () => {
		const { session } = setup({ edits: { a: 1 }, api: { get: vi.fn().mockResolvedValue({ data: { data: { version: 9 } } }) } });
		await session.save();
		expect(session.conflict.value).not.toBeNull();
		session.reset();
		expect(session.conflict.value).toBeNull();
		expect(session.saveError.value).toEqual([]);
	});
	it('a new record is POSTed (an empty form too) and reports the created row; no version check', async () => {
		const { api, session, onSaved } = setup({ creating: true, item: {} });
		await session.save();
		expect(api.get).not.toHaveBeenCalled();
		expect(api.post).toHaveBeenCalledWith('/items/physical_samples', {});
		expect(onSaved).toHaveBeenCalledWith({ sample_id: 'new-1' });

		const withEdits = setup({ creating: true, item: {}, edits: { nickname: 'n' } });
		await withEdits.session.save();
		expect(withEdits.api.post).toHaveBeenCalledWith('/items/physical_samples', { nickname: 'n' });
	});
});
