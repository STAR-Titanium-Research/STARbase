import { describe, expect, it } from 'vitest';
import { createSwr } from './swr';

function deferred<T>() {
	let resolve!: (v: T) => void, reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

describe('createSwr', () => {
	it('keeps the last-known data visible while a refresh runs', async () => {
		let n = 0;
		const gate = deferred<void>();
		const s = createSwr(async () => { n++; if (n > 1) await gate.promise; return n; });
		await s.revalidate();
		expect(s.data.value).toBe(1);
		const p = s.revalidate();
		expect(s.loading.value).toBe(true);
		expect(s.data.value).toBe(1);   // stale, not cleared
		gate.resolve();
		await p;
		expect(s.data.value).toBe(2);
		expect(s.loading.value).toBe(false);
	});

	it('shares one in-flight request between concurrent callers', async () => {
		let calls = 0;
		const gate = deferred<number>();
		const s = createSwr(() => { calls++; return gate.promise; });
		const a = s.revalidate(), b = s.revalidate();
		gate.resolve(7);
		await Promise.all([a, b]);
		expect(calls).toBe(1);
		expect(s.data.value).toBe(7);
	});

	it('keeps the data and reports the error when a refresh fails', async () => {
		let fail = false;
		const s = createSwr(async () => { if (fail) throw new Error('offline'); return 'ok'; });
		await s.revalidate();
		fail = true;
		await s.revalidate();
		expect(s.data.value).toBe('ok');
		expect(s.error.value).toBe('offline');
		fail = false;
		await s.revalidate();
		expect(s.error.value).toBeNull();
	});

	it('drops a refresh that was in flight across a local mutate', async () => {
		const gate = deferred<string>();
		const s = createSwr(() => gate.promise);
		const p = s.revalidate();
		s.mutate('saved locally');
		gate.resolve('stale from before the save');
		await p;
		expect(s.data.value).toBe('saved locally');
	});

	it('mutate can derive from the current data', async () => {
		const s = createSwr(async () => ({ mode: 'RESET', n: 1 }));
		await s.revalidate();
		s.mutate((cur) => ({ ...cur!, mode: 'MEASURE' }));
		expect(s.data.value).toEqual({ mode: 'MEASURE', n: 1 });
	});

	// The bug: a save, then refresh(), joined a request that started BEFORE the save, so the
	// pre-save snapshot landed and reverted the saved value.
	it('a revalidate after a local write starts a new request instead of joining the pre-write one', async () => {
		let server = 'old';
		const gate = deferred<void>();
		let calls = 0;
		const s = createSwr(async () => { calls++; const seen = server; await gate.promise; return seen; });
		const first = s.revalidate();          // started before the write: will read 'old'
		server = 'new'; s.invalidate();        // the write
		const second = s.revalidate();         // must not be `first`
		expect(calls).toBe(2);
		gate.resolve();
		await Promise.all([first, second]);
		expect(s.data.value).toBe('new');
	});

	it('mutate followed by revalidate also gets post-write data', async () => {
		let server = 1;
		const gate = deferred<void>();
		const s = createSwr(async () => { const seen = server; await gate.promise; return seen; });
		const pre = s.revalidate();
		server = 2; s.mutate(2);
		const post = s.revalidate();
		gate.resolve();
		await Promise.all([pre, post]);
		expect(s.data.value).toBe(2);
	});

	it('fresh forces a new request even with nothing written', async () => {
		let calls = 0;
		const s = createSwr(async () => ++calls);
		const a = s.revalidate(), b = s.revalidate({ fresh: true });
		await Promise.all([a, b]);
		expect(calls).toBe(2);
		expect(s.data.value).toBe(2);
	});

	it('never applies a stale result, whichever request finishes last', async () => {
		const gates = [deferred<string>(), deferred<string>()];
		let i = 0;
		const s = createSwr(() => gates[i++].promise);
		const older = s.revalidate();
		const newer = s.revalidate({ fresh: true });
		gates[1].resolve('newer');
		await newer;
		expect(s.data.value).toBe('newer');
		gates[0].resolve('older');   // lands last
		await older;
		expect(s.data.value).toBe('newer');
	});

	it('an older request neither clears loading nor reports its error over a newer one', async () => {
		const gates = [deferred<string>(), deferred<string>()];
		let i = 0;
		const s = createSwr(() => gates[i++].promise);
		const older = s.revalidate();
		const newer = s.revalidate({ fresh: true });
		gates[0].reject(new Error('old failure'));
		await older;
		expect(s.loading.value).toBe(true);
		expect(s.error.value).toBeNull();
		gates[1].resolve('ok');
		await newer;
		expect(s.loading.value).toBe(false);
	});
});
