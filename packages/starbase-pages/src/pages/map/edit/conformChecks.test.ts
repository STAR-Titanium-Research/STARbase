import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@d1/ui';
import { CONFORM_WINDOW_NOT_SET, conformWindowChecks, readConformRuns } from './conformChecks';

const run = (over: Record<string, unknown> = {}) => ({ operation_id: 'c1', log_id: 'l1', window_start: null, window_end: null, ...over }) as Parameters<typeof conformWindowChecks>[0][number];

describe('conformWindowChecks', () => {
	it('a run with a log and no window is a warning, never a block', () => {
		const out = conformWindowChecks([run()]);
		expect(out).toEqual([{ key: 'c1', level: 'warn', text: 'Conform run window not set' }]);
		expect(out[0].text).toBe(CONFORM_WINDOW_NOT_SET);
	});

	it('half a window is no window', () => {
		expect(conformWindowChecks([run({ window_start: '2025-03-17T13:00:00Z' })])).toHaveLength(1);
		expect(conformWindowChecks([run({ window_end: '2025-03-17T13:10:00Z' })])).toHaveLength(1);
	});

	it('a run with a window, or with no log at all, says nothing', () => {
		expect(conformWindowChecks([run({ window_start: '2025-03-17T13:00:00Z', window_end: '2025-03-17T13:10:00Z' })])).toEqual([]);
		expect(conformWindowChecks([run({ log_id: null })])).toEqual([]);
		expect(conformWindowChecks([])).toEqual([]);
	});

	it('names each run that lacks one', () => {
		const out = conformWindowChecks([run(), run({ operation_id: 'c2', window_start: 'a', window_end: 'b' }), run({ operation_id: 'c3' })]);
		expect(out.map((c) => c.key)).toEqual(['c1', 'c3']);
	});
});

describe('readConformRuns', () => {
	it('asks for the card\'s operations in one read', async () => {
		const get = vi.fn(async () => ({ data: { data: [run()] } }));
		expect(await readConformRuns({ get } as unknown as HostApi, ['c1', 'c2'])).toEqual([run()]);
		expect(get).toHaveBeenCalledTimes(1);
		expect(get).toHaveBeenCalledWith('/items/conform_run_data', expect.objectContaining({ params: expect.objectContaining({ filter: { operation_id: { _in: ['c1', 'c2'] } } }) }));
	});

	it('a refused read is no answer, and nothing to ask makes no request', async () => {
		const get = vi.fn(async () => {
			throw Object.assign(new Error('HTTP 403'), { response: { status: 403 } });
		});
		expect(await readConformRuns({ get } as unknown as HostApi, ['c1'])).toEqual([]);
		get.mockClear();
		expect(await readConformRuns({ get } as unknown as HostApi, [])).toEqual([]);
		expect(get).not.toHaveBeenCalled();
	});
});
