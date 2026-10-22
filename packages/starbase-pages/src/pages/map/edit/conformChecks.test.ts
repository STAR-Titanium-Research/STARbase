import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@d1/ui';
import { conformWindowChecks, conformWindowText, readConformRuns, readPassCodes } from './conformChecks';

const run = (over: Record<string, unknown> = {}) => ({ operation_id: 'c1', log_id: 'l1', window_start: null, window_end: null, ...over }) as Parameters<typeof conformWindowChecks>[0][number];

describe('conformWindowChecks', () => {
	it('a run with a log and no window is a warning, never a block', () => {
		const out = conformWindowChecks([run()]);
		expect(out).toEqual([{ key: 'c1', level: 'warn', text: 'No run window, so no summary, energy or steps.' }]);
		expect(out[0].text).toBe(conformWindowText());
	});

	it('names the run by its pass code when it is known', () => {
		expect(conformWindowChecks([run()], { c1: '17-03-25-CF-012' })[0].text).toBe('17-03-25-CF-012: no run window, so no summary, energy or steps.');
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

describe('readPassCodes', () => {
	it('reads the pass codes of the operations, by id, and skips one with no code', async () => {
		const get = vi.fn(async () => ({ data: { data: [{ operation_id: 'c1', pass_code: '17-03-25-CF-012' }, { operation_id: 'c2', pass_code: null }] } }));
		expect(await readPassCodes({ get } as unknown as Pick<HostApi, 'get'>, ['c1', 'c2'])).toEqual({ c1: '17-03-25-CF-012' });
		expect(get).toHaveBeenCalledWith('/items/manufacturing_operations', { params: { filter: { operation_id: { _in: ['c1', 'c2'] } }, fields: ['operation_id', 'pass_code'], limit: -1 } });
	});

	it('is no codes when the read fails, or there is nothing to read', async () => {
		expect(await readPassCodes({ get: vi.fn(async () => { throw new Error('403'); }) } as unknown as Pick<HostApi, 'get'>, ['c1'])).toEqual({});
		const get = vi.fn();
		expect(await readPassCodes({ get } as unknown as Pick<HostApi, 'get'>, [])).toEqual({});
		expect(get).not.toHaveBeenCalled();
	});
});
