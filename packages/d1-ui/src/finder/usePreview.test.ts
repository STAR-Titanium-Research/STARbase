import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, nextTick, ref, watch } from 'vue';
import type { FinderHit } from './finder';
import { sameHitIndex } from './finderNav';
import { PREVIEW_SETTLE_MS, usePreview } from './usePreview';

const hit = (id: string, extra: Partial<FinderHit> = {}): FinderHit => ({
	group: 'Samples', label: `S-${id}`, to: `/home/samples/${id}`, rank: 3, record: { collection: 'physical_samples', id }, ...extra,
});

interface Call { path: string; params: any; signal?: AbortSignal; resolve(v: any): void; reject(e: unknown): void }

// A host whose answers the test releases by hand.
function setup(initial: FinderHit | null = null, enabled = true) {
	const calls: Call[] = [];
	const api = {
		get: (path: string, cfg?: any) =>
			new Promise<any>((resolve, reject) => {
				calls.push({ path, params: cfg?.params, signal: cfg?.signal, resolve, reject });
			}),
	};
	const active = ref<FinderHit | null | undefined>(initial);
	const on = ref(enabled);
	const preview = usePreview(active, api, on);
	return { calls, active, on, preview };
}

const answer = (call: Call, data: unknown) => call.resolve({ data: { data } });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('usePreview', () => {
	it('shows nothing, and asks nothing, when there is no record hit', async () => {
		const { calls, preview } = setup(null);
		await vi.advanceTimersByTimeAsync(1000);
		expect(calls).toEqual([]);
		expect(preview.state.value).toBe('idle');
		expect(preview.card.value).toBeNull();
	});

	it('waits for the settle time, then does one GET with only the card fields', async () => {
		const { calls, preview } = setup(hit('1'));
		await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS - 1);
		expect(calls).toEqual([]);
		// the instant part is there meanwhile
		expect(preview.state.value).toBe('loading');
		expect(preview.card.value).toMatchObject({ title: 'S-1', kind: 'Sample', facts: [] });
		await vi.advanceTimersByTimeAsync(1);
		expect(calls).toHaveLength(1);
		expect(calls[0].path).toBe('/items/physical_samples/1');
		expect(calls[0].params.fields).toContain('material_id.alloy_code');
		expect(calls[0].params.fields).not.toContain('*');
	});

	it('shows the instant part (from the hit) at once, then the finished card', async () => {
		const { calls, preview } = setup(hit('1', { detail: 'disc', matchedIn: 'notes', matchedSnippet: '…crack…' }));
		expect(preview.state.value).toBe('loading');
		await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS);
		expect(preview.card.value).toMatchObject({ title: 'S-1', kind: 'Sample', detail: 'disc', facts: [], matched: { field: 'notes', snippet: '…crack…' } });
		answer(calls[0], { form: 'disc', location: 'Shelf 2' });
		await vi.advanceTimersByTimeAsync(0);
		expect(preview.state.value).toBe('ready');
		expect(preview.card.value?.kind).toBe('Sample · Disc');
		expect(preview.card.value?.facts.map((f) => f.label)).toEqual(['Geometry', 'Location']);
		expect(preview.card.value?.matched).toEqual({ field: 'notes', snippet: '…crack…' });
	});

	it('stepping fast through rows fetches only the row it comes to rest on', async () => {
		const { calls, active } = setup(hit('1'));
		for (const id of ['2', '3', '4']) {
			await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS - 20);
			active.value = hit(id);
		}
		await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS);
		expect(calls.map((c) => c.path)).toEqual(['/items/physical_samples/4']);
	});

	it('a re-merged hit for the same record does not restart the wait', async () => {
		const { calls, active } = setup(hit('1'));
		await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS - 30);
		active.value = hit('1', { detail: 'new detail' });
		await vi.advanceTimersByTimeAsync(30);
		expect(calls).toHaveLength(1);
	});

	it('a record read once is cached: stepping back shows it at once with no second request', async () => {
		const { calls, active, preview } = setup(hit('1'));
		await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS);
		answer(calls[0], { location: 'Shelf 2' });
		await vi.advanceTimersByTimeAsync(0);
		active.value = hit('2');
		await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS);
		answer(calls[1], { location: 'Bay' });
		await vi.advanceTimersByTimeAsync(0);
		active.value = hit('1');
		await nextTick();
		// no waiting, no request
		expect(preview.state.value).toBe('ready');
		expect(preview.card.value?.facts).toEqual([{ label: 'Location', value: 'Shelf 2' }]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(calls).toHaveLength(2);
	});

	it('aborts the read in flight when the active row changes, and drops its late answer', async () => {
		const { calls, active, preview } = setup(hit('1'));
		await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS);
		expect(calls[0].signal?.aborted).toBe(false);
		active.value = hit('2');
		await nextTick();
		expect(calls[0].signal?.aborted).toBe(true);
		// row 2's instant part shows at once
		expect(preview.state.value).toBe('loading');
		expect(preview.card.value).toMatchObject({ title: 'S-2', facts: [] });
		// the answer for row 1 arrives late
		answer(calls[0], { location: 'Late' });
		await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS);
		expect(preview.state.value).toBe('loading');
		expect(preview.card.value?.title).toBe('S-2');
		answer(calls[1], { location: 'Bay' });
		await vi.advanceTimersByTimeAsync(0);
		expect(preview.card.value?.facts).toEqual([{ label: 'Location', value: 'Bay' }]);
	});

	it('an aborted read that rejects is not a failure of the next card', async () => {
		const { calls, active, preview } = setup(hit('1'));
		await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS);
		active.value = hit('2');
		await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS);
		calls[0].reject(new Error('canceled'));
		await vi.advanceTimersByTimeAsync(0);
		expect(preview.state.value).toBe('loading');
		// ... and is not cached as a result for row 1
		active.value = hit('1');
		await nextTick();
		expect(preview.state.value).toBe('loading');
	});

	it('a failed read is "unavailable" with the instant card, and is not cached', async () => {
		const { calls, active, preview } = setup(hit('1'));
		await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS);
		calls[0].reject({ response: { status: 403 } });
		await vi.advanceTimersByTimeAsync(0);
		expect(preview.state.value).toBe('unavailable');
		expect(preview.card.value).toMatchObject({ title: 'S-1', facts: [] });
		active.value = hit('2');
		await nextTick();
		active.value = hit('1');
		await nextTick();
		await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS);
		expect(calls).toHaveLength(2);
		expect(preview.state.value).toBe('loading');
	});

	it('an answer with no record is "unavailable"', async () => {
		const { calls, preview } = setup(hit('1'));
		await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS);
		answer(calls[0], null);
		await vi.advanceTimersByTimeAsync(0);
		expect(preview.state.value).toBe('unavailable');
	});

	it('does nothing for a hit that is not a record', async () => {
		const { calls, preview } = setup({ group: 'Pages', label: 'Samples', to: '/home/samples', rank: 3 });
		await vi.advanceTimersByTimeAsync(1000);
		expect(calls).toEqual([]);
		expect(preview.card.value).toBeNull();
	});

	it('does nothing while disabled (the Process map host, a narrow window), and starts when enabled', async () => {
		const { calls, on, preview } = setup(hit('1'), false);
		await vi.advanceTimersByTimeAsync(1000);
		expect(calls).toEqual([]);
		expect(preview.state.value).toBe('idle');
		on.value = true;
		await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS);
		expect(calls).toHaveLength(1);
	});

	it('disabling cancels the pending wait and the read in flight', async () => {
		const first = setup(hit('1'));
		await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS - 10);
		first.on.value = false;
		await vi.advanceTimersByTimeAsync(1000);
		expect(first.calls).toEqual([]);

		const second = setup(hit('1'));
		await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS);
		second.on.value = false;
		await nextTick();
		expect(second.calls[0].signal?.aborted).toBe(true);
		expect(second.preview.card.value).toBeNull();
	});

	// Finder.vue's wiring: the active hit is hits[active], and active is re-pointed by a watcher on hits (pre flush) after a streamed answer has landed.
	it('an answer that inserts rows above the active row does not abort or repeat the read', async () => {
		const calls: Call[] = [];
		const api = { get: (path: string, cfg?: any) => new Promise<any>((resolve, reject) => { calls.push({ path, params: cfg?.params, signal: cfg?.signal, resolve, reject }); }) };
		const hits = ref<FinderHit[]>([hit('1'), hit('2')]);
		const active = ref(1);
		watch(hits, (h, old) => { active.value = sameHitIndex(old?.[active.value], h); });
		const preview = usePreview(computed(() => hits.value[active.value]), api, ref(true));
		await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS);
		expect(calls).toHaveLength(1);
		expect(calls[0].path).toBe('/items/physical_samples/2');
		// a pass 2 answer puts a new row first: row 2 is now at index 2
		hits.value = [hit('0'), hit('1'), hit('2')];
		await nextTick();
		await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS * 2);
		expect(active.value).toBe(2);
		expect(calls).toHaveLength(1);
		expect(calls[0].signal?.aborted).toBe(false);
		answer(calls[0], { location: 'Bay' });
		await vi.advanceTimersByTimeAsync(0);
		expect(preview.state.value).toBe('ready');
		expect(preview.card.value?.title).toBe('S-2');
	});

	it('reads a file through /files', async () => {
		const { calls } = setup({ group: 'Files', label: 'a.tif', to: '/files/f1', rank: 3, record: { collection: 'directus_files', id: 'f1' } });
		await vi.advanceTimersByTimeAsync(PREVIEW_SETTLE_MS);
		expect(calls[0].path).toBe('/files/f1');
	});
});
