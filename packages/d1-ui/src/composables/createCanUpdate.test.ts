import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { createCanUpdate } from './createCanUpdate';

const answer = (access: unknown) => ({ data: { data: { update: { access } } } });
const deferred = <T>() => {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
};

describe('createCanUpdate', () => {
	it('asks for the id and reads update.access', async () => {
		const api = { get: vi.fn().mockResolvedValue(answer(false)) };
		const { canUpdate, refresh } = createCanUpdate(api, 'campaigns', ref('c1'));
		expect(canUpdate.value).toBeNull();
		await refresh();
		expect(api.get).toHaveBeenLastCalledWith('/permissions/me/campaigns/c1');
		expect(canUpdate.value).toBe(false);
	});

	it('asks nothing without an id', async () => {
		const api = { get: vi.fn() };
		const { canUpdate, refresh } = createCanUpdate(api, 'campaigns', ref(null));
		await refresh();
		expect(api.get).not.toHaveBeenCalled();
		expect(canUpdate.value).toBeNull();
	});

	it('forgets the old answer as soon as it asks again', async () => {
		const second = deferred<any>();
		const api = { get: vi.fn().mockResolvedValueOnce(answer(false)).mockReturnValueOnce(second.promise) };
		const { canUpdate, refresh } = createCanUpdate(api, 'physical_samples', ref('s1'));
		await nextTick(); // the first answer (asked when created)
		await nextTick();
		expect(canUpdate.value).toBe(false);
		const pending = refresh();
		expect(canUpdate.value).toBeNull();
		second.resolve(answer(true));
		await pending;
		expect(canUpdate.value).toBe(true);
	});

	it('drops a late answer for an older id', async () => {
		const first = deferred<any>();
		const api = { get: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(answer(true)) };
		const id = ref<string | null>('a');
		const { canUpdate } = createCanUpdate(api, 'test_sessions', id);
		id.value = 'b';
		await nextTick();
		await nextTick();
		expect(canUpdate.value).toBe(true);
		first.resolve(answer(false));
		await first.promise;
		await nextTick();
		expect(canUpdate.value).toBe(true);
	});

	it('is unknown (Edit stays available) when the request fails', async () => {
		const api = { get: vi.fn().mockRejectedValue(new Error('offline')) };
		const { canUpdate, refresh } = createCanUpdate(api, 'projects', ref('p1'));
		await refresh();
		expect(canUpdate.value).toBeNull();
	});
});
