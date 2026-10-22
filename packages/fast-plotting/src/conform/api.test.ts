import { createHash } from 'node:crypto';
import type { AxiosInstance } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTraceCache } from '../fastCache';
import { excelVariant, fixtureText } from './__fixtures__/load';
import { ConformLogError, ConformLogHiddenError } from './channels';
import {
	ALREADY_UPLOADED, CONFORM_LOGS_FOLDER_ID, COULD_NOT_SAVE_WINDOW, findLogByHash, guardReason, plainReason, labelWindows, linkExistingLog, listCandidateLogs, listLogWindows, loadConformRun,
	loadLogTrace, recomputeRun, setRunWindow, unlinkLog, uploadConformLog,
	type ConformLogRow,
} from './api';
import { normaliseLog } from './normalise';
import { parseConformCsv } from './parse';

interface Call { method: 'get' | 'post' | 'patch' | 'delete'; url: string; body?: any; config?: any }

const httpError = (status: number, message: string) =>
	Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { errors: [{ message }] } } });

/** A refusal by one of our hooks: `extensions.source` marks the sentence in `reason` as written for people. */
const guardError = (status: number, reason: string, source = 'd1-conform-guard') =>
	Object.assign(new Error(`Request failed with status code ${status}`), {
		response: { status, data: { errors: [{ message: `Invalid payload. ${reason}`, extensions: { code: 'INVALID_PAYLOAD', reason, source } }] } },
	});

/** An axios stand-in: records every call and answers from `routes` (an Error return is thrown). */
function fakeApi(routes: (c: Call) => unknown) {
	const calls: Call[] = [];
	const run = async (method: Call['method'], url: string, body?: unknown, config?: unknown) => {
		const c: Call = { method, url, body, config };
		calls.push(c);
		const r = routes(c);
		if (r instanceof Error) throw r;
		// a string is a raw text body (the CSV from /assets); anything else is a Directus envelope
		return { data: typeof r === 'string' ? r : { data: r }, status: 200 };
	};
	const api = {
		get: (u: string, cfg?: unknown) => run('get', u, undefined, cfg),
		post: (u: string, b?: unknown, cfg?: unknown) => run('post', u, b, cfg),
		patch: (u: string, b?: unknown, cfg?: unknown) => run('patch', u, b, cfg),
		delete: (u: string) => run('delete', u),
	} as unknown as AxiosInstance;
	const writes = () => calls.filter((c) => c.method !== 'get').map((c) => `${c.method.toUpperCase()} ${c.url}`);
	return { api, calls, writes };
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const FILE = { name: 'synthetic.csv', bytes: bytesOf(fixtureText) };

beforeEach(() => {
	resetTraceCache();
	vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('log-new' as `${string}-${string}-${string}-${string}-${string}`);   // the id the upload picks for the log, as the server's reply echoes it
});

const norm = normaliseLog(parseConformCsv(fixtureText));
const logRow = (id: string): ConformLogRow => ({
	log_id: id, directus_files_id: `file-${id}`, equipment_id: 'eq-1', source_filename: 'synthetic.csv', source_sha256: sha(FILE.bytes), run_windows: [],
	log_start: norm.logStart, log_end: norm.logEnd, n_rows: norm.nRows, duration_s: norm.durationS,
	series: norm.series, totals: norm.totals, constants: norm.constants,
});
const OP = { operation_id: 'op-1', equipment_id: 'eq-1', operation_date: '2025-01-15T09:00:00' };

// Defaults for a happy upload; a test overrides one route by returning from `over` first.
const happy = (over: (c: Call) => unknown = () => undefined) => (c: Call): unknown => {
	const o = over(c);
	if (o !== undefined) return o;
	if (c.method === 'get' && c.url === '/items/conform_run_data') return [];
	if (c.method === 'post' && c.url === '/files') return { id: 'file-new' };
	if (c.method === 'post' && c.url === '/items/conform_logs') return { log_id: 'log-new' };
	if (c.method === 'post' && c.url === '/items/conform_run_data') return { id: 'run-new' };
	return {};
};

/** The result of an upload that went up (not a duplicate). */
async function uploaded(p: ReturnType<typeof uploadConformLog>) {
	const r = await p;
	if ('existing' in r) throw new Error('expected an upload, got an existing log');
	return r;
}

describe('uploadConformLog', () => {
	it('uploads the file, then the log, then the run data with the whole-log window', async () => {
		const f = fakeApi(happy());
		const res = await uploaded(uploadConformLog(f.api, OP, FILE));
		expect(f.writes()).toEqual(['POST /files', 'POST /items/conform_logs', 'POST /items/conform_run_data']);

		const form = f.calls.find((c) => c.url === '/files')!.body as FormData;
		expect(form.get('folder')).toBe(CONFORM_LOGS_FOLDER_ID);
		// Directus applies only the fields sent before the file part, and the log's file must be in this folder (migration 211)
		const keys = [...form.keys()];
		expect(keys.indexOf('folder')).toBeLessThan(keys.indexOf('file'));
		expect(CONFORM_LOGS_FOLDER_ID).toBe('c04f1000-0000-4000-8000-000000000001');
		expect(f.calls.some((c) => c.url === '/folders')).toBe(false);   // no lookup of the folder by name
		const csv = await (form.get('file') as File).text();
		expect(csv.split('\n')[0].startsWith('time_s,')).toBe(true);

		const logBody = f.calls.find((c) => c.method === 'post' && c.url === '/items/conform_logs')!.body;
		expect(logBody).toMatchObject({
			directus_files_id: 'file-new', equipment_id: 'eq-1', source_filename: 'synthetic.csv', n_rows: 900, log_start: '2025-01-15T10:00:00.000Z',
			source_sha256: sha(FILE.bytes),
		});

		const runBody = f.calls.find((c) => c.method === 'post' && c.url === '/items/conform_run_data')!.body;
		expect(runBody).toMatchObject({ operation_id: 'op-1', log_id: 'log-new', window_start: '2025-01-15T10:00:00.000Z', window_end: '2025-01-15T10:14:59.000Z', status: 'done' });
		expect(runBody.summary.energy_kwh.total).toBeCloseTo(7.523869, 5);
		expect(runBody.summary.constants_version).toBe(1);
		expect(runBody.steps).toHaveLength(3);

		expect(res.log.log_id).toBe('log-new');
		expect(res.run).toMatchObject({ id: 'run-new', status: 'done', log_id: 'log-new' });
		expect(res.dateWarning).toBeNull();
	});

	it('updates an existing run row instead of inserting', async () => {
		const f = fakeApi(happy((c) => (c.method === 'get' && c.url === '/items/conform_run_data' ? [{ id: 'run-old', operation_id: 'op-1', status: 'no_log' }] : undefined)));
		await uploadConformLog(f.api, OP, FILE);
		expect(f.writes()).toEqual(['POST /files', 'POST /items/conform_logs', 'PATCH /items/conform_run_data/run-old']);
	});

	it('reads the bytes, so a Windows-1252 export keeps its degree-C channels, and hashes the raw bytes', async () => {
		const bytes = Uint8Array.from(Buffer.from(excelVariant(fixtureText).replace(/^﻿/, '').replace(/Â°/g, '°'), 'latin1'));
		const f = fakeApi(happy());
		await uploaded(uploadConformLog(f.api, OP, { name: 'excel.csv', bytes }));
		const logBody = f.calls.find((c) => c.method === 'post' && c.url === '/items/conform_logs')!.body;
		expect(logBody.series.map((x: any) => x.key)).toEqual(expect.arrayContaining(['tooling1_c', 'tooling2_c', 'wheel_temp_c']));
		expect(logBody.source_sha256).toBe(sha(bytes));
		expect(logBody.source_sha256).not.toBe(sha(FILE.bytes));
	});

	it('looks the hash up before uploading anything and returns the log that has it', async () => {
		const f = fakeApi(happy((c) => (c.method === 'get' && c.url === '/items/conform_logs' ? [logRow('log-old')] : undefined)));
		const res = await uploadConformLog(f.api, OP, FILE);
		expect(res).toEqual({ existing: expect.objectContaining({ log_id: 'log-old' }), existingWindows: [] });
		expect(f.writes()).toEqual([]);
		expect(f.calls[0].config.params.filter).toEqual({ source_sha256: { _eq: sha(FILE.bytes) } });
	});

	it('also returns the windows already on that log, labelled, for the prompt', async () => {
		const old = { ...logRow('log-old'), run_windows: [{ operation_id: 'op-9', start: '2025-01-15T10:00:00Z', end: '2025-01-15T10:05:00Z' }, { operation_id: 'op-8', start: '2025-01-15T10:06:00Z', end: '2025-01-15T10:09:00Z' }] };
		const f = fakeApi(happy((c) => {
			if (c.method === 'get' && c.url === '/items/conform_logs') return [old];
			if (c.method === 'get' && c.url === '/items/manufacturing_operations') return [{ operation_id: 'op-9', pass_code: '15-01-25-CF-009', conform_feedstock: 'Ti swarf' }];
			return undefined;
		}));
		const res = await uploadConformLog(f.api, OP, FILE);
		expect(res).toMatchObject({ existingWindows: [
			{ operation_id: 'op-9', label: 'Ti swarf', readable: true },
			{ operation_id: 'op-8', label: 'Other run', readable: false },
		] });
		expect(f.writes()).toEqual([]);
	});

	it('words the database refusal of a duplicate hash', async () => {
		const dup = Object.assign(new Error('Request failed with status code 400'), {
			response: { status: 400, data: { errors: [{ message: 'Value for field "source_sha256" in collection "conform_logs" has to be unique.', extensions: { code: 'RECORD_NOT_UNIQUE', collection: 'conform_logs', field: 'source_sha256' } }] } },
		});
		const f = fakeApi(happy((c) => (c.method === 'post' && c.url === '/items/conform_logs' ? dup : undefined)));
		const err = await uploadConformLog(f.api, OP, FILE).catch((e) => e);
		expect(err).toBeInstanceOf(ConformLogError);
		expect(err.message).toBe(ALREADY_UPLOADED);
		expect(ALREADY_UPLOADED).toBe('This log is already uploaded: use “Use a log already uploaded”.');
		expect(f.writes()).toEqual(['POST /files', 'POST /items/conform_logs', 'DELETE /items/conform_logs/log-new', 'DELETE /files/file-new']);
	});

	it('refuses a malformed file before touching the server', async () => {
		const f = fakeApi(happy());
		await expect(uploadConformLog(f.api, OP, { name: 'x.csv', bytes: bytesOf('a,b\n1,2') })).rejects.toBeInstanceOf(ConformLogError);
		expect(f.calls).toEqual([]);
	});

	it('deletes the uploaded file when the log row cannot be written', async () => {
		const f = fakeApi(happy((c) => (c.method === 'post' && c.url === '/items/conform_logs' ? httpError(403, 'You do not have permission') : undefined)));
		await expect(uploadConformLog(f.api, OP, FILE)).rejects.toThrow("You can't change this Conform run.");
		// the log id is chosen before the create, so a create that failed after inserting its row is removed too (a miss is harmless)
		expect(f.writes()).toEqual(['POST /files', 'POST /items/conform_logs', 'DELETE /items/conform_logs/log-new', 'DELETE /files/file-new']);
	});

	it('removes the log row and the file when the run data cannot be written, and surfaces the message', async () => {
		const f = fakeApi(happy((c) => (c.method === 'post' && c.url === '/items/conform_run_data' ? guardError(400, 'Run window overlaps 17-03-25-CF-011 on this log.') : undefined)));
		const err = await uploadConformLog(f.api, OP, FILE).catch((e) => e);
		expect(err).toBeInstanceOf(ConformLogError);
		expect(err.message).toBe('Run window overlaps 17-03-25-CF-011 on this log.');
		expect(f.writes().slice(-2)).toEqual(['DELETE /items/conform_logs/log-new', 'DELETE /files/file-new']);
	});

	it('sets an empty run date from the log', async () => {
		const f = fakeApi(happy());
		const res = await uploaded(uploadConformLog(f.api, { ...OP, operation_date: null }, FILE));
		const patch = f.calls.find((c) => c.method === 'patch' && c.url === '/items/manufacturing_operations/op-1')!;
		expect(patch.body).toEqual({ operation_date: '2025-01-15T10:00:00.000Z' });
		expect(res.dateWarning).toBeNull();
	});

	it('never writes the run date of a planned run', async () => {
		const f = fakeApi(happy());
		const res = await uploaded(uploadConformLog(f.api, { ...OP, operation_date: null, work_state: 'planned' }, FILE));
		expect(f.writes().some((w) => w.includes('manufacturing_operations'))).toBe(false);
		expect(res.dateWarning).toBeNull();
		const g = fakeApi(happy());
		await uploaded(uploadConformLog(g.api, { ...OP, operation_date: '2025-03-20T09:00:00', work_state: 'planned' }, FILE));
		expect(g.writes().some((w) => w.includes('manufacturing_operations'))).toBe(false);
	});

	it('warns, and changes nothing, when the run date is more than a day from the log', async () => {
		const f = fakeApi(happy());
		const res = await uploaded(uploadConformLog(f.api, { ...OP, operation_date: '2025-03-20T09:00:00' }, FILE));
		expect(res.dateWarning).toBe("The log starts on 15 Jan 2025, more than a day from the run's date 20 Mar 2025; the date was not changed.");
		expect(f.writes().some((w) => w.includes('manufacturing_operations'))).toBe(false);
	});

	it('accepts a run date a day away without a warning', async () => {
		const f = fakeApi(happy());
		const res = await uploaded(uploadConformLog(f.api, { ...OP, operation_date: '2025-01-16' }, FILE));
		expect(res.dateWarning).toBeNull();
	});
});

describe('the server hook refusals', () => {
	const refusal = (reason: string) => Object.assign(new Error('Request failed with status code 400'), {
		response: { status: 400, data: { errors: [{ message: reason, extensions: { code: 'INVALID_PAYLOAD', reason } }] } },
	});
	it('are shown verbatim, from extensions.reason, when the Conform hook or the access guard refused', async () => {
		const sentence = 'Run window overlaps 15-01-25-CF-001 on this log.';
		for (const source of ['d1-conform-guard', 'd1-access-guard']) {
			const f = fakeApi(happy((c) => (c.method === 'post' && c.url === '/items/conform_run_data' ? guardError(400, sentence, source) : undefined)));
			const err = await linkExistingLog(f.api, 'op-2', 'log-7').catch((e) => e);
			expect(err).toBeInstanceOf(ConformLogError);
			expect(err.message).toBe(sentence);
		}
	});
	it('never show Directus developer text: a reason from any other source, or none, becomes a plain sentence', async () => {
		const stock = (status: number, message: string, ext: Record<string, unknown> = {}) => Object.assign(new Error('x'), { response: { status, data: { errors: [{ message, extensions: { code: 'X', ...ext } }] } } });
		const link = (e: unknown) => linkExistingLog(fakeApi(happy((c) => (c.method === 'post' && c.url === '/items/conform_run_data' ? (e as Error) : undefined))).api, 'op-2', 'log-7').catch((x) => x.message);
		expect(await link(stock(400, 'Invalid payload. Something internal.', { reason: 'Something internal.' }))).toBe('Could not link the log.');
		expect(await link(stock(400, 'Invalid payload.', { reason: 'From elsewhere', source: 'some-other-hook' }))).toBe('Could not link the log.');
		expect(await link(stock(403, "You don't have permission to access this."))).toBe("You can't change this Conform run.");
		expect(await link(stock(500, 'duplicate key value violates unique constraint "x"'))).toBe('Could not link the log.');
		expect(await link(Object.assign(new Error('Network Error'), { request: {} }))).toBe('Could not reach the server. Check the connection and try again.');
		expect(guardReason(guardError(400, 'Reason.'))).toBe('Reason.');
		expect(guardReason(stock(400, 'Reason.', { reason: 'Reason.' }))).toBeUndefined();
		expect(plainReason(stock(500, 'boom'), COULD_NOT_SAVE_WINDOW)).toBe('Could not save the run window.');
	});
});

describe('findLogByHash', () => {
	it('is null when nothing has the hash', async () => {
		const f = fakeApi(() => []);
		expect(await findLogByHash(f.api, 'abc')).toBeNull();
	});
});

describe('linkExistingLog', () => {
	it('links with an empty window and status no_window', async () => {
		const f = fakeApi(happy());
		const run = await linkExistingLog(f.api, 'op-2', 'log-7');
		const body = f.calls.find((c) => c.method === 'post' && c.url === '/items/conform_run_data')!.body;
		expect(body).toMatchObject({ operation_id: 'op-2', log_id: 'log-7', window_start: null, window_end: null, status: 'no_window', summary: null, steps: null });
		expect(run).toMatchObject({ status: 'no_window', window_start: null, log_id: 'log-7' });
	});

	it('never writes anything but the run row (no run date, planned or not)', async () => {
		const f = fakeApi(happy());
		await linkExistingLog(f.api, 'op-2', 'log-7');
		expect(f.writes()).toEqual(['POST /items/conform_run_data']);
	});

	it('shows the database refusal text', async () => {
		const f = fakeApi(happy((c) => (c.method === 'post' && c.url === '/items/conform_run_data' ? httpError(400, 'nope') : undefined)));
		await expect(linkExistingLog(f.api, 'op-2', 'log-7')).rejects.toBeInstanceOf(ConformLogError);
	});
});

describe('setRunWindow', () => {
	const WIN = ['2025-01-15T10:04:58.000Z', '2025-01-15T10:15:00.000Z'] as const;
	const routes = (opFields: Record<string, unknown>, over: (c: Call) => unknown = () => undefined) => happy((c) => {
		const o = over(c);
		if (o !== undefined) return o;
		if (c.method === 'get' && c.url === '/items/conform_run_data') return [{ id: 'run-1', operation_id: 'op-1', log_id: 'log-w', status: 'no_window', window_start: null, window_end: null }];
		if (c.method === 'get' && c.url === '/items/conform_logs/log-w') return logRow('log-w');
		if (c.method === 'get' && c.url === '/assets/file-log-w') return norm.csvText;
		if (c.method === 'get' && c.url === '/items/manufacturing_operations/op-1') return opFields;
		return undefined;
	});

	it('recomputes the summary and steps and fills the empty setpoint fields only', async () => {
		const f = fakeApi((c) => {
			const r = routes({ conform_wheel_speed_rpm: null, conform_ips_setpoint_c: 450 })(c);
			// the real axios returns the text itself for /assets
			return r;
		});
		const run = await setRunWindow(f.api, 'op-1', WIN[0], WIN[1]);
		const patch = f.calls.find((c) => c.method === 'patch' && c.url === '/items/conform_run_data/run-1')!;
		expect(patch.body).toMatchObject({ window_start: WIN[0], window_end: WIN[1], status: 'done', error_message: null });
		expect(patch.body.summary.energy_kwh.total).toBeCloseTo(5.118654, 5);
		expect(patch.body.steps.map((s: any) => s.wheel_speed_rpm)).toEqual([5]);
		expect(run.status).toBe('done');
		const op = f.calls.filter((c) => c.method === 'patch' && c.url === '/items/manufacturing_operations/op-1');
		expect(op.map((c) => c.body)).toEqual([{ conform_wheel_speed_rpm: 5 }]);
	});

	it('leaves setpoint fields that are already filled', async () => {
		const f = fakeApi(routes({ conform_wheel_speed_rpm: 0, conform_ips_setpoint_c: 450 }));
		await setRunWindow(f.api, 'op-1', WIN[0], WIN[1]);
		expect(f.writes()).toEqual(['PATCH /items/conform_run_data/run-1']);
	});

	it('shows an overlap refusal verbatim and writes nothing else', async () => {
		const f = fakeApi(routes({}, (c) => (c.method === 'patch' && c.url === '/items/conform_run_data/run-1' ? guardError(400, 'run window overlaps 17-03-25-CF-011') : undefined)));
		const err = await setRunWindow(f.api, 'op-1', WIN[0], WIN[1]).catch((e) => e);
		expect(err).toBeInstanceOf(ConformLogError);
		expect(err.message).toBe('run window overlaps 17-03-25-CF-011');
		expect(f.writes()).toEqual(['PATCH /items/conform_run_data/run-1']);
	});

	it('refuses an inverted window and a run without a log', async () => {
		const f = fakeApi(routes({}));
		await expect(setRunWindow(f.api, 'op-1', WIN[1], WIN[0])).rejects.toBeInstanceOf(ConformLogError);
		const g = fakeApi(happy());
		await expect(setRunWindow(g.api, 'op-9', WIN[0], WIN[1])).rejects.toThrow(/no Conform log/);
	});

	it('says so when the log is not visible', async () => {
		const f = fakeApi(routes({}, (c) => (c.url === '/items/conform_logs/log-w' ? httpError(403, 'forbidden') : undefined)));
		await expect(setRunWindow(f.api, 'op-1', WIN[0], WIN[1])).rejects.toThrow('Conform log not visible to you');
	});
});

describe('loadConformRun', () => {
	it('returns nothing for an operation without a run', async () => {
		const f = fakeApi(happy());
		expect(await loadConformRun(f.api, 'op-1')).toEqual({ run: null, log: null, logHidden: false });
	});

	it('loads the run and its log', async () => {
		const f = fakeApi((c) => {
			if (c.url === '/items/conform_run_data') return [{ id: 'r', operation_id: 'op-1', log_id: 'L', status: 'done', summary: { version: 1 }, steps: [] }];
			if (c.url === '/items/conform_logs/L') return { ...logRow('L'), n_rows: '900', duration_s: '899' };
			return {};
		});
		const r = await loadConformRun(f.api, 'op-1');
		expect(r.logHidden).toBe(false);
		expect(r.log!.n_rows).toBe(900);
		expect(r.log!.duration_s).toBe(899);
	});

	it('keeps the summary and flags a hidden log on 403', async () => {
		const f = fakeApi((c) => {
			if (c.url === '/items/conform_run_data') return [{ id: 'r', operation_id: 'op-1', log_id: 'L', status: 'done', summary: { version: 1, extruding_s: 870 }, steps: [] }];
			if (c.url === '/items/conform_logs/L') return httpError(403, 'You do not have permission to access this.');
			return {};
		});
		const r = await loadConformRun(f.api, 'op-1');
		expect(r.logHidden).toBe(true);
		expect(r.log).toBeNull();
		expect((r.run!.summary as any).extruding_s).toBe(870);
	});

	it('lets other errors through', async () => {
		const f = fakeApi((c) => (c.url === '/items/conform_run_data' ? httpError(500, 'boom') : {}));
		await expect(loadConformRun(f.api, 'op-1')).rejects.toBeTruthy();
	});
});

describe('listCandidateLogs and listLogWindows', () => {
	it('asks for logs from the machine within a day of the run date', async () => {
		const f = fakeApi(() => [logRow('a')]);
		const logs = await listCandidateLogs(f.api, 'eq-1', '2025-01-15T09:00:00');
		const filter = f.calls[0].config.params.filter._and;
		expect(filter).toContainEqual({ log_start: { _gte: '2025-01-14T00:00:00.000Z' } });
		expect(filter).toContainEqual({ log_start: { _lt: '2025-01-17T00:00:00.000Z' } });
		expect(filter).toContainEqual({ equipment_id: { _eq: 'eq-1' } });
		expect(logs.map((l) => l.log_id)).toEqual(['a']);
	});

	it('searches around today when the run has no date', async () => {
		const f = fakeApi(() => []);
		await listCandidateLogs(f.api, null, null);
		const filter = f.calls[0].config.params.filter._and;
		const gte = Date.parse(filter.find((x: any) => x.log_start?._gte).log_start._gte);
		expect(Math.abs(gte - Date.now())).toBeLessThan(2 * 86_400_000 + 5000);
		expect(filter.some((x: any) => x.equipment_id)).toBe(false);
	});

	it('names the windows on each candidate log: a readable run by feedstock or code, any other as "Other run"', async () => {
		const W1 = { operation_id: 'o1', start: '2025-01-15T10:00:00.000Z', end: '2025-01-15T10:05:00.000Z' };
		const W2 = { operation_id: 'o2', start: '2025-01-15T10:05:00.000Z', end: '2025-01-15T10:14:59.000Z' };
		const W3 = { operation_id: 'o3', start: '2025-01-15T11:00:00.000Z', end: '2025-01-15T11:05:00.000Z' };
		const f = fakeApi((c) => {
			if (c.url === '/items/conform_logs') return [{ ...logRow('a'), run_windows: [W1, W2] }, { ...logRow('b'), run_windows: [W3] }, logRow('c')];
			// only o1 and o2 are readable: Directus leaves the others out
			if (c.url === '/items/manufacturing_operations') return [{ operation_id: 'o1', pass_code: '15-01-25-CF-001', conform_feedstock: 'Ti swarf' }, { operation_id: 'o2', pass_code: '15-01-25-CF-002', conform_feedstock: null }];
			return [];
		});
		const logs = await listCandidateLogs(f.api, 'eq-1', '2025-01-15T09:00:00');
		expect(logs.map((l) => l.windows.map((w) => [w.label, w.readable]))).toEqual([[['Ti swarf', true], ['15-01-25-CF-002', true]], [['Other run', false]], []]);
		expect(f.calls.filter((c) => c.url === '/items/manufacturing_operations')).toHaveLength(1);
	});

	it('reads the windows of a log from its run_windows, not from the other runs', async () => {
		const W = { operation_id: 'o1', start: 'a', end: 'b' };
		const f = fakeApi((c) => {
			if (c.url === '/items/conform_logs/L') return { ...logRow('L'), run_windows: [W, { operation_id: 'o9', start: 'c', end: 'd' }] };
			if (c.url === '/items/manufacturing_operations') return [{ operation_id: 'o1', pass_code: '15-01-25-CF-001', conform_feedstock: 'Ti swarf' }];
			return [];
		});
		expect(await listLogWindows(f.api, 'L')).toEqual([
			{ operation_id: 'o1', label: 'Ti swarf', readable: true, start: 'a', end: 'b' },
			{ operation_id: 'o9', label: 'Other run', readable: false, start: 'c', end: 'd' },
		]);
		expect(f.calls.some((c) => c.url === '/items/conform_run_data')).toBe(false);
	});

	it('labels every window "Other run" when the operations cannot be read, and an unreadable log has no windows', async () => {
		const f = fakeApi((c) => (c.url === '/items/manufacturing_operations' ? httpError(403, 'no') : undefined));
		expect(await labelWindows(f.api, [{ operation_id: 'o1', start: 'a', end: 'b' }])).toEqual([{ operation_id: 'o1', start: 'a', end: 'b', label: 'Other run', readable: false }]);
		const g = fakeApi((c) => (c.url === '/items/conform_logs/L' ? httpError(403, 'no') : undefined));
		expect(await listLogWindows(g.api, 'L')).toEqual([]);
	});
});

describe('recomputeRun', () => {
	const routes = (over: (c: Call) => unknown = () => undefined) => (c: Call): unknown => {
		const o = over(c);
		if (o !== undefined) return o;
		if (c.method === 'get' && c.url === '/items/conform_run_data') return [{ id: 'run-1', operation_id: 'op-1', log_id: 'log-r', status: 'done', window_start: norm.logStart, window_end: norm.logEnd, summary: {} }];
		if (c.method === 'get' && c.url === '/items/conform_logs/log-r') return { ...logRow('log-r'), constants: { ...norm.constants, version: 0 } };
		if (c.method === 'get' && c.url === '/assets/file-log-r') return norm.csvText;
		return {};
	};

	it('recomputes over the stored window and writes only the run, never the shared log row', async () => {
		const f = fakeApi(routes());
		const run = await recomputeRun(f.api, 'op-1');
		expect(f.writes()).toEqual(['PATCH /items/conform_run_data/run-1']);
		expect(run.summary!.version).toBe(1);
		expect(run.summary!.constants_version).toBe(1);
		expect(run.steps).toHaveLength(3);
	});

	it('does nothing for a run without a window', async () => {
		const f = fakeApi(routes((c) => (c.method === 'get' && c.url === '/items/conform_run_data'
			? [{ id: 'run-1', operation_id: 'op-1', log_id: 'log-r', status: 'no_window', window_start: null, window_end: null }] : undefined)));
		expect((await recomputeRun(f.api, 'op-1')).status).toBe('no_window');
		expect(f.writes()).toEqual([]);
	});
});

describe('unlinkLog', () => {
	const RUN = { id: 'run-1', operation_id: 'op-1', log_id: 'log-u', status: 'done', window_start: norm.logStart, window_end: norm.logEnd, summary: {}, steps: [] };
	const routes = (over: (c: Call) => unknown = () => undefined) => (c: Call): unknown => {
		const o = over(c);
		if (o !== undefined) return o;
		if (c.method === 'get' && c.url === '/items/conform_run_data') {
			// the run row for the operation filter, nothing for the "any other run on this log" filter
			return c.config.params.filter.operation_id ? [RUN] : [];
		}
		if (c.method === 'get' && c.url === '/items/conform_logs/log-u') return logRow('log-u');
		return {};
	};

	it('clears the run, then deletes the log and then its file when nothing else uses it', async () => {
		const f = fakeApi(routes());
		expect(await unlinkLog(f.api, 'op-1')).toEqual({ logRemoved: true });
		expect(f.writes()).toEqual(['PATCH /items/conform_run_data/run-1', 'DELETE /items/conform_logs/log-u', 'DELETE /files/file-log-u']);
		expect(f.calls.find((c) => c.method === 'patch')!.body).toEqual({
			log_id: null, window_start: null, window_end: null, summary: null, steps: null, status: 'no_log', error_message: null,
		});
	});

	it('keeps the log when another run has a window on it', async () => {
		const f = fakeApi(routes((c) => (c.url === '/items/conform_logs/log-u' ? { ...logRow('log-u'), run_windows: [{ operation_id: 'o2', start: 'a', end: 'b' }] } : undefined)));
		expect(await unlinkLog(f.api, 'op-1')).toEqual({ logRemoved: false });
		expect(f.writes()).toEqual(['PATCH /items/conform_run_data/run-1']);
	});

	it('keeps the log when another run row still points at it (even one with no window)', async () => {
		const f = fakeApi(routes((c) => (c.method === 'get' && c.url === '/items/conform_run_data' && c.config.params.filter.log_id ? [{ id: 'run-2' }] : undefined)));
		expect(await unlinkLog(f.api, 'op-1')).toEqual({ logRemoved: false });
		expect(f.writes()).toEqual(['PATCH /items/conform_run_data/run-1']);
	});

	it('leaves a log somebody else uploaded (the delete is refused), and does not touch its file', async () => {
		const f = fakeApi(routes((c) => (c.method === 'delete' && c.url === '/items/conform_logs/log-u' ? httpError(403, 'You do not have permission') : undefined)));
		expect(await unlinkLog(f.api, 'op-1')).toEqual({ logRemoved: false });
		expect(f.writes()).toEqual(['PATCH /items/conform_run_data/run-1', 'DELETE /items/conform_logs/log-u']);
	});

	it('still unlinks when the file cannot be deleted', async () => {
		const f = fakeApi(routes((c) => (c.method === 'delete' && c.url.startsWith('/files/') ? httpError(403, 'no') : undefined)));
		expect(await unlinkLog(f.api, 'op-1')).toEqual({ logRemoved: true });
	});

	it('does nothing for a run with no log', async () => {
		const f = fakeApi((c) => (c.url === '/items/conform_run_data' ? [{ ...RUN, log_id: null }] : {}));
		expect(await unlinkLog(f.api, 'op-1')).toEqual({ logRemoved: false });
		expect(f.writes()).toEqual([]);
	});

	it('shows the database refusal when the run itself cannot be changed', async () => {
		const f = fakeApi(routes((c) => (c.method === 'patch' ? httpError(403, 'You do not have permission') : undefined)));
		await expect(unlinkLog(f.api, 'op-1')).rejects.toThrow("You can't change this Conform run.");
		expect(f.writes()).toEqual(['PATCH /items/conform_run_data/run-1']);
	});
});

describe('loadLogTrace', () => {
	it('says the log is not visible when its file is forbidden', async () => {
		const f = fakeApi((c) => (c.url.startsWith('/assets/') ? httpError(403, 'You do not have permission to access this.') : undefined));
		const err = await loadLogTrace(f.api, logRow('t1')).catch((e) => e);
		expect(err).toBeInstanceOf(ConformLogHiddenError);
		expect(err.message).toBe('Conform log not visible to you');
	});

	it('says it could not load the log for any other failure, and tries again next time', async () => {
		let fail = true;
		const f = fakeApi((c) => (c.url.startsWith('/assets/') ? (fail ? httpError(500, 'boom') : norm.csvText) : undefined));
		const err = await loadLogTrace(f.api, logRow('t2')).catch((e) => e);
		expect(err).toBeInstanceOf(ConformLogError);
		expect(err).not.toBeInstanceOf(ConformLogHiddenError);
		expect(err.message).toBe('Could not load the Conform log');
		fail = false;
		expect((await loadLogTrace(f.api, logRow('t2'))).n).toBe(900);
	});

	it('downloads once when loads of one log overlap', async () => {
		const f = fakeApi((c) => (c.url.startsWith('/assets/') ? norm.csvText : undefined));
		await Promise.all([loadLogTrace(f.api, logRow('t3')), loadLogTrace(f.api, logRow('t3')), loadLogTrace(f.api, logRow('t3'))]);
		expect(f.calls.filter((c) => c.url.startsWith('/assets/'))).toHaveLength(1);
	});
});
