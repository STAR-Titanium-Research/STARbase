import { describe, expect, it, vi } from 'vitest';
import { MAX_PICTURES_IN_FLIGHT, PictureCancelled, createPictureStore, picturesFor } from './inboxPictures';
import { createFakeInbox, foundFile } from './fakeInboxServer';
import type { PictureSize } from './inboxApi';

/** A loader the test finishes by hand: each call is a pending load with resolve and reject. */
function manual() {
	const pending: Array<{ id: string; size: PictureSize; resolve(url: string): void; reject(e: unknown): void }> = [];
	const revoked: string[] = [];
	let n = 0;
	return {
		pending,
		revoked,
		load: (id: string, size: PictureSize) => new Promise<string>((resolve, reject) => pending.push({ id, size, resolve, reject })),
		revoke: (u: string) => void revoked.push(u),
		url: () => `blob:test/${(n += 1)}`,
	};
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('the picture store', () => {
	it('runs at most four loads at once and starts the next as one finishes', async () => {
		const m = manual();
		const store = createPictureStore({ load: m.load, revoke: m.revoke });
		expect(MAX_PICTURES_IN_FLIGHT).toBe(4);
		const handles = Array.from({ length: 7 }, (_, i) => store.acquire(`c${i}`, 'thumb'));
		await tick();
		expect(m.pending.map((p) => p.id)).toEqual(['c0', 'c1', 'c2', 'c3']);
		expect(store.stats()).toMatchObject({ inFlight: 4, queued: 3 });
		m.pending[1].resolve(m.url());
		await tick();
		expect(m.pending.map((p) => p.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
		expect(store.stats()).toMatchObject({ inFlight: 4, queued: 2 });
		await expect(handles[1].promise).resolves.toMatch(/^blob:/);
		// a failure frees its place too
		m.pending[0].reject(new Error('boom'));
		await expect(handles[0].promise).rejects.toThrow('boom');
		await tick();
		expect(m.pending.map((p) => p.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
	});

	it('loads one picture once however many ask, and tells each the same URL', async () => {
		const m = manual();
		const store = createPictureStore({ load: m.load, revoke: m.revoke });
		const a = store.acquire('c1', 'thumb');
		const b = store.acquire('c1', 'thumb');
		const other = store.acquire('c1', 'preview');
		await tick();
		expect(m.pending.map((p) => `${p.size}:${p.id}`)).toEqual(['thumb:c1', 'preview:c1']);
		m.pending[0].resolve('blob:test/a');
		await expect(Promise.all([a.promise, b.promise])).resolves.toEqual(['blob:test/a', 'blob:test/a']);
		// the URL lives until the LAST holder lets go
		a.release();
		expect(m.revoked).toEqual([]);
		b.release();
		expect(m.revoked).toEqual(['blob:test/a']);
		other.release();
	});

	it('a clicked preview jumps the queue', async () => {
		const m = manual();
		const store = createPictureStore({ load: m.load, revoke: m.revoke, maxInFlight: 1 });
		store.acquire('c1', 'thumb');
		store.acquire('c2', 'thumb');
		store.acquire('c3', 'thumb');
		await tick(); // c1 is loading, c2 and c3 wait
		store.acquire('c9', 'preview', { priority: true });
		await tick();
		m.pending[0].resolve('blob:test/1');
		await tick();
		expect(m.pending.map((p) => `${p.size}:${p.id}`)).toEqual(['thumb:c1', 'preview:c9']);
	});

	it('drops a queued load whose holder let go, so a row that is gone costs no request', async () => {
		const m = manual();
		const store = createPictureStore({ load: m.load, revoke: m.revoke, maxInFlight: 1 });
		store.acquire('c1', 'thumb');
		const gone = store.acquire('c2', 'thumb');
		const kept = store.acquire('c3', 'thumb');
		await tick();
		gone.release();
		await expect(gone.promise).rejects.toBeInstanceOf(PictureCancelled);
		m.pending[0].resolve('blob:test/1');
		await tick();
		expect(m.pending.map((p) => p.id)).toEqual(['c1', 'c3']);
		m.pending[1].resolve('blob:test/3');
		await expect(kept.promise).resolves.toBe('blob:test/3');
	});

	it('revokes a picture that arrives after its last holder left, and never shows it', async () => {
		const m = manual();
		const store = createPictureStore({ load: m.load, revoke: m.revoke });
		const h = store.acquire('c1', 'thumb');
		await tick();
		h.release();
		h.release(); // twice is harmless
		m.pending[0].resolve('blob:test/late');
		await expect(h.promise).rejects.toBeInstanceOf(PictureCancelled);
		expect(m.revoked).toEqual(['blob:test/late']);
		expect(store.stats()).toMatchObject({ inFlight: 0, held: 0, unused: 0 });
	});

	it('a holder that comes back while the picture is still loading keeps it', async () => {
		const m = manual();
		const store = createPictureStore({ load: m.load, revoke: m.revoke });
		store.acquire('c1', 'thumb').release();
		const back = store.acquire('c1', 'thumb');
		await tick();
		expect(m.pending).toHaveLength(1);
		m.pending[0].resolve('blob:test/1');
		await expect(back.promise).resolves.toBe('blob:test/1');
		expect(m.revoked).toEqual([]);
	});

	it('does not remember a failure: the next acquire (a remounted row, Retry) tries again', async () => {
		const m = manual();
		const store = createPictureStore({ load: m.load, revoke: m.revoke });
		const first = store.acquire('c1', 'preview');
		await tick();
		m.pending[0].reject(new Error('500'));
		await expect(first.promise).rejects.toThrow('500');
		const second = store.acquire('c1', 'preview');
		await tick();
		expect(m.pending).toHaveLength(2);
		m.pending[1].resolve('blob:test/ok');
		await expect(second.promise).resolves.toBe('blob:test/ok');
	});

	it('a loader that throws at once is a failed picture, not a broken store', async () => {
		const store = createPictureStore({ load: () => { throw new Error('sync'); }, revoke: () => {} });
		await expect(store.acquire('c1', 'thumb').promise).rejects.toThrow('sync');
		expect(store.stats().inFlight).toBe(0);
	});

	it('keeps up to keepUnused pictures for a quick return and revokes the oldest beyond that', async () => {
		const m = manual();
		const store = createPictureStore({ load: m.load, revoke: m.revoke, keepUnused: 2 });
		const hs = ['c1', 'c2', 'c3'].map((id) => store.acquire(id, 'thumb'));
		await tick();
		m.pending.forEach((p, i) => p.resolve(`blob:test/${i + 1}`));
		await Promise.all(hs.map((h) => h.promise));
		hs.forEach((h) => h.release());
		expect(m.revoked).toEqual(['blob:test/1']);
		expect(store.stats().unused).toBe(2);
		// c3 comes back from the cache: no new load
		const again = store.acquire('c3', 'thumb');
		await expect(again.promise).resolves.toBe('blob:test/3');
		await tick();
		expect(m.pending).toHaveLength(3);
		expect(store.stats().unused).toBe(1);
	});
});

describe('picturesFor', () => {
	it('is one store per api, loading through loadPicture and revoking with URL.revokeObjectURL', async () => {
		const fake = createFakeInbox({ files: [foundFile({ has_thumbnail: true })] });
		const other = createFakeInbox({ files: [] });
		expect(picturesFor(fake.api)).toBe(picturesFor(fake.api));
		expect(picturesFor(fake.api)).not.toBe(picturesFor(other.api));
		const revoke = vi.spyOn(URL, 'revokeObjectURL');
		const h = picturesFor(fake.api).acquire(fake.files[0].candidate_id, 'thumb');
		const url = await h.promise;
		expect(url).toMatch(/^blob:/);
		h.release();
		expect(revoke).toHaveBeenCalledWith(url);
		revoke.mockRestore();
	});
});
