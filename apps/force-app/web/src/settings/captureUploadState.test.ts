import { describe, expect, it } from 'vitest';
import { analysisComplete, confirmUploadState, lookupUploadState, matchUploaded, recheckUploaded, uploadedRowsSince, type RowGetter } from './captureUploadState';

describe('uploadedRowsSince', () => {
	it('bounds at the earliest capture time, minus two days of slack', () => {
		const since = uploadedRowsSince(['20260926-142026-67ef81', '20260901-080000-aaaaaa']);
		const expected = new Date(2026, 8, 1, 8, 0, 0).getTime() - 2 * 24 * 3600 * 1000;
		expect(since).toBe(new Date(expected).toISOString());
	});

	it('does not narrow when any id lacks a leading timestamp', () => {
		expect(uploadedRowsSince(['20260926-142026-67ef81', 'imported-capture'])).toBeNull();
	});

	it('has no bound for an empty list', () => {
		expect(uploadedRowsSince([])).toBeNull();
	});
});

describe('matchUploaded', () => {
	it('matches rows to local capture ids by recorded_metadata.capture_id', () => {
		const rows = [
			{ operation_id: 'op-1', recorded_metadata: { capture_id: 'cap-a' } },
			{ operation_id: 'op-2', recorded_metadata: { capture_id: 'cap-elsewhere' } },
			{ operation_id: 'op-3', recorded_metadata: { sample_name: 'no capture id' } },
			{ operation_id: 'op-4', recorded_metadata: null },
			{ operation_id: 'op-5', recorded_metadata: { capture_id: 42 } },
		];
		expect(matchUploaded(rows, ['cap-a', 'cap-b'])).toEqual({
			uploaded: { 'cap-a': true },
			opIds: { 'cap-a': 'op-1' },
			allOpIds: { 'cap-a': ['op-1'] },
		});
	});

	it('marks a capture uploaded even when its row has no operation id', () => {
		const { uploaded, opIds } = matchUploaded([{ recorded_metadata: { capture_id: 'cap-a' } }], ['cap-a']);
		expect(uploaded).toEqual({ 'cap-a': true });
		expect(opIds).toEqual({});
	});
});

describe('lookupUploadState', () => {
	const op = (id: string, cap: string) => ({ operation_id: id, recorded_metadata: { capture_id: cap } });
	const fake = (ops: unknown[], analysis: unknown[]): { get: RowGetter; calls: [string, any][] } => {
		const calls: [string, any][] = [];
		return {
			calls,
			get: async (collection, params) => {
				calls.push([collection, params]);
				return collection === 'manufacturing_operations' ? ops : analysis;
			},
		};
	};

	it('an operation row with no analysis row is a partial upload, not uploaded', async () => {
		const { get } = fake([op('op-1', 'cap-a')], []);
		const r = await lookupUploadState([{ id: 'cap-a', hasMat: true }], get);
		expect(r.uploaded).toEqual({});
		expect(r.partial).toEqual({ 'cap-a': true });
		expect(r.opIds).toEqual({ 'cap-a': 'op-1' });
	});

	it('an analysis row without its live cache is still partial', async () => {
		const { get } = fake([op('op-1', 'cap-a')], [{ operation_id: 'op-1', live_cache_file: null, directus_files_id: 'f1' }]);
		expect((await lookupUploadState([{ id: 'cap-a', hasMat: true }], get)).partial).toEqual({ 'cap-a': true });
	});

	it('needs the .mat file id only when the capture wrote a .mat', async () => {
		const rows = [{ operation_id: 'op-1', live_cache_file: 'c1', directus_files_id: null }];
		const withMat = await lookupUploadState([{ id: 'cap-a', hasMat: true }], fake([op('op-1', 'cap-a')], rows).get);
		expect(withMat.partial).toEqual({ 'cap-a': true });
		const noMat = await lookupUploadState([{ id: 'cap-a', hasMat: false }], fake([op('op-1', 'cap-a')], rows).get);
		expect(noMat.uploaded).toEqual({ 'cap-a': true });
	});

	it('is uploaded with operation row, cache and mat; a duplicate orphan row does not hide that', async () => {
		const { get } = fake(
			[op('op-orphan', 'cap-a'), op('op-1', 'cap-a')],
			[{ operation_id: 'op-1', live_cache_file: 'c1', directus_files_id: 'f1' }],
		);
		const r = await lookupUploadState([{ id: 'cap-a', hasMat: true }, { id: 'cap-b', hasMat: true }], get);
		expect(r.uploaded).toEqual({ 'cap-a': true });
		expect(r.partial).toEqual({});
		expect(r.opIds['cap-a']).toBe('op-1');   // the complete one, not the orphan
	});

	it('asks only for the needed analysis fields, by operation id, in chunks', async () => {
		const ids = Array.from({ length: 170 }, (_, i) => `cap-${i}`);
		const { get, calls } = fake(ids.map((c, i) => op(`op-${i}`, c)), []);
		await lookupUploadState(ids.map((id) => ({ id, hasMat: true })), get);
		const analysisCalls = calls.filter(([c]) => c === 'machining_force_analysis');
		expect(analysisCalls).toHaveLength(3);
		expect(analysisCalls[0][1].fields).toEqual(['operation_id', 'live_cache_file', 'directus_files_id']);
		expect(analysisCalls[0][1].filter.operation_id._in).toHaveLength(80);
	});

	it('skips the analysis query when nothing matched, and throws when Directus fails', async () => {
		const { get, calls } = fake([], []);
		await lookupUploadState([{ id: 'cap-a', hasMat: true }], get);
		expect(calls.map(([c]) => c)).toEqual(['manufacturing_operations']);
		await expect(lookupUploadState([{ id: 'cap-a', hasMat: true }], async () => { throw new Error('403'); })).rejects.toThrow();
	});
});

describe('analysisComplete', () => {
	it('requires the live cache, and the .mat only when expected', () => {
		expect(analysisComplete([], false)).toBe(false);
		expect(analysisComplete([{ live_cache_file: 'c' }], false)).toBe(true);
		expect(analysisComplete([{ live_cache_file: 'c' }], true)).toBe(false);
		expect(analysisComplete([{ live_cache_file: 'c', directus_files_id: 'm' }], true)).toBe(true);
	});
});

describe('recheckUploaded', () => {
	it('is one analysis query for the operation and reflects the fresh rows', async () => {
		const calls: [string, any][] = [];
		const get = (rows: unknown[]): RowGetter => async (c, p) => { calls.push([c, p]); return rows; };
		expect(await recheckUploaded('op-1', true, get([{ operation_id: 'op-1', live_cache_file: 'c', directus_files_id: 'm' }]))).toBe(true);
		expect(await recheckUploaded('op-1', true, get([]))).toBe(false);   // analysis row deleted since the preview
		expect(calls.every(([c, p]) => c === 'machining_force_analysis' && p.filter.operation_id._in[0] === 'op-1')).toBe(true);
		await expect(recheckUploaded('op-1', true, async () => { throw new Error('offline'); })).rejects.toThrow();
	});
});

describe('confirmUploadState', () => {
	const rows = (r: unknown[]): RowGetter => async () => r;
	it('is uploaded only when the fresh analysis row is complete', async () => {
		expect(await confirmUploadState('op', true, rows([{ operation_id: 'op', live_cache_file: 'c', directus_files_id: 'm' }]))).toBe('uploaded');
	});
	it('is partial when the row still lacks a link (or there is none)', async () => {
		expect(await confirmUploadState('op', true, rows([{ operation_id: 'op', live_cache_file: 'c', directus_files_id: null }]))).toBe('partial');
		expect(await confirmUploadState('op', true, rows([]))).toBe('partial');
	});
	it('is unknown, never uploaded, when Directus cannot be asked', async () => {
		expect(await confirmUploadState('op', true, async () => { throw new Error('offline'); })).toBe('unknown');
	});
});
