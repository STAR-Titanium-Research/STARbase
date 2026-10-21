import type { AxiosInstance } from 'axios';
import { describe, expect, it } from 'vitest';
import { fixtureText } from './__fixtures__/load';
import { ConformLogError } from './channels';
import {
	linkExistingLog, listCandidateLogs, listLogWindows, loadConformRun, recomputeRun, setRunWindow, uploadConformLog,
	type ConformLogRow,
} from './api';
import { normaliseLog } from './normalise';
import { parseConformCsv } from './parse';

interface Call { method: 'get' | 'post' | 'patch' | 'delete'; url: string; body?: any; config?: any }

const httpError = (status: number, message: string) =>
	Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { errors: [{ message }] } } });

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

const norm = normaliseLog(parseConformCsv(fixtureText));
const logRow = (id: string): ConformLogRow => ({
	log_id: id, directus_files_id: `file-${id}`, equipment_id: 'eq-1', source_filename: 'TiSwarf.csv',
	log_start: norm.logStart, log_end: norm.logEnd, n_rows: norm.nRows, duration_s: norm.durationS,
	series: norm.series, totals: norm.totals, constants: norm.constants,
});
const OP = { operation_id: 'op-1', equipment_id: 'eq-1', operation_date: '2025-03-17T09:00:00' };

// Defaults for a happy upload; a test overrides one route by returning from `over` first.
const happy = (over: (c: Call) => unknown = () => undefined) => (c: Call): unknown => {
	const o = over(c);
	if (o !== undefined) return o;
	if (c.method === 'get' && c.url === '/folders') return [{ id: 'folder-1' }];
	if (c.method === 'get' && c.url === '/items/conform_run_data') return [];
	if (c.method === 'post' && c.url === '/files') return { id: 'file-new' };
	if (c.method === 'post' && c.url === '/items/conform_logs') return { log_id: 'log-new' };
	if (c.method === 'post' && c.url === '/items/conform_run_data') return { id: 'run-new' };
	return {};
};

describe('uploadConformLog', () => {
	it('uploads the file, then the log, then the run data with the whole-log window', async () => {
		const f = fakeApi(happy());
		const res = await uploadConformLog(f.api, OP, { name: 'TiSwarf.csv', text: fixtureText });
		expect(f.writes()).toEqual(['POST /files', 'POST /items/conform_logs', 'POST /items/conform_run_data']);

		const form = f.calls.find((c) => c.url === '/files')!.body as FormData;
		expect(form.get('folder')).toBe('folder-1');
		expect(f.calls.find((c) => c.url === '/folders')!.config.params.filter).toEqual({ name: { _eq: 'Conform Logs' } });
		const csv = await (form.get('file') as File).text();
		expect(csv.split('\n')[0].startsWith('time_s,')).toBe(true);

		const logBody = f.calls.find((c) => c.method === 'post' && c.url === '/items/conform_logs')!.body;
		expect(logBody).toMatchObject({ directus_files_id: 'file-new', equipment_id: 'eq-1', source_filename: 'TiSwarf.csv', n_rows: 900, log_start: '2025-03-17T13:38:20.000Z' });

		const runBody = f.calls.find((c) => c.method === 'post' && c.url === '/items/conform_run_data')!.body;
		expect(runBody).toMatchObject({ operation_id: 'op-1', log_id: 'log-new', window_start: '2025-03-17T13:38:20.000Z', window_end: '2025-03-17T13:53:19.000Z', status: 'done' });
		expect(runBody.summary.energy_kwh.total).toBeCloseTo(7.670553, 5);
		expect(runBody.steps).toHaveLength(3);

		expect(res.log.log_id).toBe('log-new');
		expect(res.run).toMatchObject({ id: 'run-new', status: 'done', log_id: 'log-new' });
		expect(res.dateWarning).toBeNull();
	});

	it('updates an existing run row instead of inserting', async () => {
		const f = fakeApi(happy((c) => (c.method === 'get' && c.url === '/items/conform_run_data' ? [{ id: 'run-old', operation_id: 'op-1', status: 'no_log' }] : undefined)));
		await uploadConformLog(f.api, OP, { name: 'TiSwarf.csv', text: fixtureText });
		expect(f.writes()).toEqual(['POST /files', 'POST /items/conform_logs', 'PATCH /items/conform_run_data/run-old']);
	});

	it('uploads to the root when the folder does not exist', async () => {
		const f = fakeApi(happy((c) => (c.url === '/folders' ? [] : undefined)));
		await uploadConformLog(f.api, OP, { name: 'x.csv', text: fixtureText });
		expect((f.calls.find((c) => c.url === '/files')!.body as FormData).has('folder')).toBe(false);
	});

	it('refuses a malformed file before touching the server', async () => {
		const f = fakeApi(happy());
		await expect(uploadConformLog(f.api, OP, { name: 'x.csv', text: 'a,b\n1,2' })).rejects.toBeInstanceOf(ConformLogError);
		expect(f.calls).toEqual([]);
	});

	it('deletes the uploaded file when the log row cannot be written', async () => {
		const f = fakeApi(happy((c) => (c.method === 'post' && c.url === '/items/conform_logs' ? httpError(403, 'You do not have permission') : undefined)));
		await expect(uploadConformLog(f.api, OP, { name: 'x.csv', text: fixtureText })).rejects.toThrow('You do not have permission');
		expect(f.writes()).toEqual(['POST /files', 'POST /items/conform_logs', 'DELETE /files/file-new']);
	});

	it('removes the log row and the file when the run data cannot be written, and surfaces the message', async () => {
		const f = fakeApi(happy((c) => (c.method === 'post' && c.url === '/items/conform_run_data' ? httpError(400, 'run window overlaps 17-03-25-CF-011') : undefined)));
		const err = await uploadConformLog(f.api, OP, { name: 'x.csv', text: fixtureText }).catch((e) => e);
		expect(err).toBeInstanceOf(ConformLogError);
		expect(err.message).toBe('run window overlaps 17-03-25-CF-011');
		expect(f.writes().slice(-2)).toEqual(['DELETE /items/conform_logs/log-new', 'DELETE /files/file-new']);
	});

	it('sets an empty run date from the log', async () => {
		const f = fakeApi(happy());
		const res = await uploadConformLog(f.api, { ...OP, operation_date: null }, { name: 'x.csv', text: fixtureText });
		const patch = f.calls.find((c) => c.method === 'patch' && c.url === '/items/manufacturing_operations/op-1')!;
		expect(patch.body).toEqual({ operation_date: '2025-03-17T13:38:20.000Z' });
		expect(res.dateWarning).toBeNull();
	});

	it('warns, and changes nothing, when the run date is more than a day from the log', async () => {
		const f = fakeApi(happy());
		const res = await uploadConformLog(f.api, { ...OP, operation_date: '2025-03-20T09:00:00' }, { name: 'x.csv', text: fixtureText });
		expect(res.dateWarning).toBe("The log starts on 2025-03-17, more than a day from the run's date 2025-03-20; the date was not changed.");
		expect(f.writes().some((w) => w.includes('manufacturing_operations'))).toBe(false);
	});

	it('accepts a run date a day away without a warning', async () => {
		const f = fakeApi(happy());
		const res = await uploadConformLog(f.api, { ...OP, operation_date: '2025-03-18' }, { name: 'x.csv', text: fixtureText });
		expect(res.dateWarning).toBeNull();
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

	it('shows the database refusal text', async () => {
		const f = fakeApi(happy((c) => (c.method === 'post' && c.url === '/items/conform_run_data' ? httpError(400, 'nope') : undefined)));
		await expect(linkExistingLog(f.api, 'op-2', 'log-7')).rejects.toBeInstanceOf(ConformLogError);
	});
});

describe('setRunWindow', () => {
	const WIN = ['2025-03-17T13:43:18.000Z', '2025-03-17T13:53:20.000Z'] as const;
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
		expect(patch.body.summary.energy_kwh.total).toBeCloseTo(5.203773, 5);
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
		const f = fakeApi(routes({}, (c) => (c.method === 'patch' && c.url === '/items/conform_run_data/run-1' ? httpError(400, 'run window overlaps 17-03-25-CF-011') : undefined)));
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
			if (c.url === '/items/conform_run_data') return [{ id: 'r', operation_id: 'op-1', log_id: 'L', status: 'done', summary: { version: 1, extruding_s: 804 }, steps: [] }];
			if (c.url === '/items/conform_logs/L') return httpError(403, 'You do not have permission to access this.');
			return {};
		});
		const r = await loadConformRun(f.api, 'op-1');
		expect(r.logHidden).toBe(true);
		expect(r.log).toBeNull();
		expect((r.run!.summary as any).extruding_s).toBe(804);
	});

	it('lets other errors through', async () => {
		const f = fakeApi((c) => (c.url === '/items/conform_run_data' ? httpError(500, 'boom') : {}));
		await expect(loadConformRun(f.api, 'op-1')).rejects.toBeTruthy();
	});
});

describe('listCandidateLogs and listLogWindows', () => {
	it('asks for logs from the machine within a day of the run date', async () => {
		const f = fakeApi(() => [logRow('a')]);
		const logs = await listCandidateLogs(f.api, 'eq-1', '2025-03-17T09:00:00');
		const filter = f.calls[0].config.params.filter._and;
		expect(filter).toContainEqual({ log_start: { _gte: '2025-03-16T00:00:00.000Z' } });
		expect(filter).toContainEqual({ log_start: { _lt: '2025-03-19T00:00:00.000Z' } });
		expect(filter).toContainEqual({ equipment_id: { _eq: 'eq-1' } });
		expect(logs.map((l) => l.log_id)).toEqual(['a']);
	});

	it('maps run windows with the feedstock or the operation code as label', async () => {
		const f = fakeApi(() => [
			{ operation_id: { operation_id: 'o1', pass_code: '17-03-25-CF-011', conform_feedstock: 'Ti swarf' }, window_start: 'a', window_end: 'b' },
			{ operation_id: { operation_id: 'o2', pass_code: '17-03-25-CF-012', conform_feedstock: null }, window_start: 'c', window_end: 'd' },
		]);
		expect(await listLogWindows(f.api, 'L')).toEqual([
			{ operation_id: 'o1', label: 'Ti swarf', start: 'a', end: 'b' },
			{ operation_id: 'o2', label: '17-03-25-CF-012', start: 'c', end: 'd' },
		]);
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

	it('recomputes over the stored window and refreshes the log constants', async () => {
		const f = fakeApi(routes());
		const run = await recomputeRun(f.api, 'op-1');
		expect(f.writes()).toEqual(['PATCH /items/conform_run_data/run-1', 'PATCH /items/conform_logs/log-r']);
		expect(f.calls.find((c) => c.url === '/items/conform_logs/log-r' && c.method === 'patch')!.body.constants.version).toBe(1);
		expect(run.summary!.version).toBe(1);
		expect(run.steps).toHaveLength(3);
	});

	it('still succeeds when the log may not be edited', async () => {
		const f = fakeApi(routes((c) => (c.method === 'patch' && c.url === '/items/conform_logs/log-r' ? httpError(403, 'forbidden') : undefined)));
		expect((await recomputeRun(f.api, 'op-1')).status).toBe('done');
	});

	it('does nothing for a run without a window', async () => {
		const f = fakeApi(routes((c) => (c.method === 'get' && c.url === '/items/conform_run_data'
			? [{ id: 'run-1', operation_id: 'op-1', log_id: 'log-r', status: 'no_window', window_start: null, window_end: null }] : undefined)));
		expect((await recomputeRun(f.api, 'op-1')).status).toBe('no_window');
		expect(f.writes()).toEqual([]);
	});
});
