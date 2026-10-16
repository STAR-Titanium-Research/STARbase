// The shared cap on imaging-settings loads (final review I3): a record with many images mounts one LinkedFileItem each, and every mount asks
// GET /d1-inbox/sem-settings. At most 4 of those requests are in flight at once; the rest wait their turn (first in, first out).
import { describe, expect, it } from 'vitest';
import { createSemSettings } from './useSemSettings';

type Api = Parameters<typeof createSemSettings>[0];
const tick = () => new Promise((r) => setTimeout(r, 0));

/** An api whose GET stays open until `finishOne` answers it, counting how many are open at once. */
function slowApi() {
	const open: Array<() => void> = [];
	const asked: string[] = [];
	let inFlight = 0;
	let peak = 0;
	const api = {
		get: (_path: string, config: { params: { file: string } }) => {
			asked.push(config.params.file);
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			return new Promise((resolve) =>
				open.push(() => {
					inFlight -= 1;
					resolve({ data: { data: { locked: false, settings: null } } });
				}),
			);
		},
	} as unknown as Api;
	const finishOne = async () => {
		open.shift()?.();
		await tick();
	};
	return { api, finishOne, asked, stats: () => ({ inFlight, peak, total: asked.length }) };
}

describe('the shared cap on settings loads', () => {
	it('never has more than 4 requests in flight for 10 simultaneous mounts, and answers every one', async () => {
		const { api, finishOne, stats } = slowApi();
		const all = Array.from({ length: 10 }, (_, i) => createSemSettings(api, () => `file-${i}`));
		const loads = all.map((s) => s.load());
		await tick();
		expect(stats().inFlight).toBe(4);
		for (let n = 0; n < 10; n++) {
			await finishOne();
			expect(stats().peak).toBeLessThanOrEqual(4);
		}
		await Promise.all(loads);
		expect(stats()).toMatchObject({ peak: 4, total: 10, inFlight: 0 });
		expect(all.every((s) => s.state.value === 'none')).toBe(true);
	});

	it('starts the waiting ones in the order they asked (first in, first out)', async () => {
		const { api, finishOne, asked, stats } = slowApi();
		const loads = Array.from({ length: 6 }, (_, i) => createSemSettings(api, () => `f${i}`).load());
		await tick();
		expect(asked).toEqual(['f0', 'f1', 'f2', 'f3']);
		await finishOne();
		expect(asked).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
		while (stats().inFlight > 0) await finishOne();
		await Promise.all(loads);
		expect(asked).toEqual(['f0', 'f1', 'f2', 'f3', 'f4', 'f5']);
	});

	it('a load cancelled while it waited never sends its request', async () => {
		const { api, finishOne, stats } = slowApi();
		const all = Array.from({ length: 6 }, (_, i) => createSemSettings(api, () => `file-${i}`));
		const loads = all.map((s) => s.load());
		await tick();
		all[5].cancelPending(); // the page moved on (unmount) while it queued
		while (stats().inFlight > 0) await finishOne();
		await Promise.all(loads);
		expect(stats()).toMatchObject({ total: 5, inFlight: 0, peak: 4 });
	});

	it('a failed request frees its slot', async () => {
		const failing = { get: () => Promise.reject(new Error('Network Error')) } as unknown as Api;
		const ok = slowApi();
		await Promise.all(Array.from({ length: 8 }, (_, i) => createSemSettings(failing, () => `x${i}`).load()));
		const p = createSemSettings(ok.api, () => 'after').load();
		await tick();
		expect(ok.stats().inFlight).toBe(1); // no slot was left taken
		await ok.finishOne();
		await p;
	});
});
