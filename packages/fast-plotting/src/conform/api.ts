// Data access for Conform runs: upload a log, link a log already uploaded, set the run window, recompute.
// Everything goes through the host's axios instance (`FastHost.api`, which carries the base URL and the session),
// so this works unchanged in the Directus module and in STARbase.
import type { AxiosInstance } from 'axios';
import { loadTrace, parseTrace, type SeriesMeta, type Trace } from '../fastCache';
import { ConformLogError } from './channels';
import { ukDate } from './clock';
import { normaliseLog, wholeLogTotals, type ConformTotals } from './normalise';
import { parseConformCsv, parseIsoMs } from './parse';
import { CONFORM_POWER_CONSTANTS } from './power';
import { detectSteps, type ConformStep } from './steps';
import { summariseWindow, type ConformSummary } from './summary';

export interface ConformLogRow {
	log_id: string; directus_files_id: string; equipment_id: string | null; source_filename: string;
	log_start: string; log_end: string; n_rows: number; duration_s: number;
	series: SeriesMeta[]; totals: ConformTotals; constants: typeof CONFORM_POWER_CONSTANTS;
}
export interface ConformRunRow {
	id: string; operation_id: string; log_id: string | null; window_start: string | null; window_end: string | null;
	status: 'no_log' | 'no_window' | 'done' | 'error'; summary: ConformSummary | null; steps: ConformStep[] | null; error_message: string | null;
}

export const CONFORM_LOGS_FOLDER = 'Conform Logs';
const LOG_FIELDS = ['log_id', 'directus_files_id', 'equipment_id', 'source_filename', 'log_start', 'log_end', 'n_rows', 'duration_s', 'series', 'totals', 'constants'];
const RUN_FIELDS = ['id', 'operation_id', 'log_id', 'window_start', 'window_end', 'status', 'summary', 'steps', 'error_message'];
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- plumbing

const httpStatus = (e: any): number | undefined => e?.response?.status;
const directusMessage = (e: any): string | undefined => e?.response?.data?.errors?.[0]?.message;

/** A Directus error message becomes a ConformLogError with that text (e.g. `run window overlaps 17-03-25-CF-011`). */
function toLogError(e: unknown): unknown {
	if (e instanceof ConformLogError) return e;
	const m = directusMessage(e);
	return m ? new ConformLogError(m) : e;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
	try { return await fn(); } catch (e) { throw toLogError(e); }
}

const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));

function toLog(raw: any): ConformLogRow {
	return {
		log_id: raw.log_id,
		directus_files_id: raw.directus_files_id,
		equipment_id: raw.equipment_id ?? null,
		source_filename: raw.source_filename ?? '',
		log_start: raw.log_start,
		log_end: raw.log_end,
		n_rows: num(raw.n_rows),
		duration_s: num(raw.duration_s),
		series: raw.series ?? [],
		totals: raw.totals,
		constants: raw.constants,
	};
}

function toRun(raw: any): ConformRunRow {
	return {
		id: raw.id,
		operation_id: raw.operation_id,
		log_id: raw.log_id ?? null,
		window_start: raw.window_start ?? null,
		window_end: raw.window_end ?? null,
		status: raw.status ?? 'no_log',
		summary: raw.summary ?? null,
		steps: raw.steps ?? null,
		error_message: raw.error_message ?? null,
	};
}

/** Epoch ms of a Directus timestamp or date; a value with no zone is UTC, as Directus stores it. */
function instantMs(s: string): number {
	return parseIsoMs(/^\d{4}-\d\d-\d\d$/.test(s) ? `${s}T00:00:00Z` : s);
}

async function getRunRow(api: AxiosInstance, operationId: string): Promise<any | null> {
	const res = await api.get('/items/conform_run_data', {
		params: { filter: { operation_id: { _eq: operationId } }, fields: RUN_FIELDS, limit: 1 },
	});
	return res.data?.data?.[0] ?? null;
}

async function saveRun(api: AxiosInstance, existing: any | null, body: Record<string, unknown>): Promise<ConformRunRow> {
	const res = existing
		? await api.patch(`/items/conform_run_data/${existing.id}`, body, { params: { fields: RUN_FIELDS } })
		: await api.post('/items/conform_run_data', body, { params: { fields: RUN_FIELDS } });
	return toRun({ ...existing, ...body, ...(res.data?.data ?? {}) });
}

/** The log row, or null when this user may not read it (403, or 404 for a log the row rules hide). */
async function getLogRow(api: AxiosInstance, logId: string): Promise<ConformLogRow | null> {
	try {
		const res = await api.get(`/items/conform_logs/${logId}`, { params: { fields: LOG_FIELDS } });
		return res.data?.data ? toLog(res.data.data) : null;
	} catch (e) {
		if (httpStatus(e) === 403 || httpStatus(e) === 404) return null;
		throw e;
	}
}

// ---------------------------------------------------------------- reading

export async function loadConformRun(api: AxiosInstance, operationId: string): Promise<{ run: ConformRunRow | null; log: ConformLogRow | null; logHidden: boolean }> {
	const raw = await getRunRow(api, operationId);
	if (!raw) return { run: null, log: null, logHidden: false };
	const run = toRun(raw);
	if (!run.log_id) return { run, log: null, logHidden: false };
	const log = await getLogRow(api, run.log_id);
	return { run, log, logHidden: log === null };
}

/** The log's trace (time in seconds from log start), downloaded once per log and cached by `log_id`. */
export function loadLogTrace(api: AxiosInstance, log: ConformLogRow): Promise<Trace> {
	return loadTrace(log.log_id, log.series, async () => {
		const res = await api.get(`/assets/${log.directus_files_id}`, { responseType: 'text' });
		return res.data as string;
	});
}

/** Logs from the same machine (any machine when `equipmentId` is null) that start within a day of `aroundDate`. */
export async function listCandidateLogs(api: AxiosInstance, equipmentId: string | null, aroundDate: string): Promise<ConformLogRow[]> {
	const day = Math.floor(instantMs(aroundDate) / DAY_MS) * DAY_MS;
	if (Number.isNaN(day)) return [];
	const and: unknown[] = [
		{ log_start: { _gte: new Date(day - DAY_MS).toISOString() } },
		{ log_start: { _lt: new Date(day + 2 * DAY_MS).toISOString() } },
	];
	if (equipmentId) and.push({ equipment_id: { _eq: equipmentId } });
	const res = await api.get('/items/conform_logs', { params: { filter: { _and: and }, fields: LOG_FIELDS, sort: ['log_start'], limit: -1 } });
	return (res.data?.data ?? []).map(toLog);
}

export async function listLogWindows(api: AxiosInstance, logId: string): Promise<{ operation_id: string; label: string; start: string; end: string }[]> {
	const res = await api.get('/items/conform_run_data', {
		params: {
			filter: { _and: [{ log_id: { _eq: logId } }, { window_start: { _nnull: true } }, { window_end: { _nnull: true } }] },
			fields: ['operation_id.operation_id', 'operation_id.pass_code', 'operation_id.conform_feedstock', 'window_start', 'window_end'],
			sort: ['window_start'], limit: -1,
		},
	});
	return (res.data?.data ?? []).map((r: any) => {
		const op = r.operation_id && typeof r.operation_id === 'object' ? r.operation_id : { operation_id: r.operation_id };
		return { operation_id: op.operation_id, label: op.conform_feedstock || op.pass_code || '', start: r.window_start, end: r.window_end };
	});
}

// ---------------------------------------------------------------- writing

async function conformFolderId(api: AxiosInstance): Promise<string | null> {
	try {
		const res = await api.get('/folders', { params: { filter: { name: { _eq: CONFORM_LOGS_FOLDER } }, fields: ['id'], limit: 1 } });
		return res.data?.data?.[0]?.id ?? null;
	} catch {
		return null;   // no folder permission: the file simply goes to the root
	}
}

const baseName = (name: string): string => name.replace(/\.[^.]+$/, '') || 'conform-log';

/**
 * Process the file in the browser, store the normalised CSV and the log row, and link the run to the whole log
 * with its summary and steps. A malformed file is refused before anything is uploaded. If a write fails after the
 * file went up, the log row and the file are removed again and the error is rethrown.
 */
export async function uploadConformLog(
	api: AxiosInstance,
	op: { operation_id: string; equipment_id: string | null; operation_date: string | null },
	file: { name: string; text: string },
): Promise<{ run: ConformRunRow; log: ConformLogRow; dateWarning: string | null }> {
	const parsed = parseConformCsv(file.text);
	const norm = normaliseLog(parsed);
	const trace = parseTrace(norm.csvText, norm.series);
	const startMs = parsed.startMs;
	const endMs = parsed.endMs;
	const summary = summariseWindow(trace, startMs, startMs, endMs);
	const steps = detectSteps(trace, startMs, startMs, endMs);

	const existing = await getRunRow(api, op.operation_id);   // read first: a failure here leaves nothing behind
	const folder = await conformFolderId(api);

	const form = new FormData();
	if (folder) form.append('folder', folder);
	form.append('title', `${baseName(file.name)} (normalised)`);
	form.append('file', new Blob([norm.csvText], { type: 'text/csv' }), `${baseName(file.name)}-normalised.csv`);
	const fileId: string = (await guarded(() => api.post('/files', form))).data.data.id;

	let logId: string | null = null;
	let log: ConformLogRow;
	let run: ConformRunRow;
	try {
		const logBody = {
			directus_files_id: fileId,
			equipment_id: op.equipment_id,
			source_filename: file.name,
			log_start: norm.logStart,
			log_end: norm.logEnd,
			n_rows: norm.nRows,
			duration_s: norm.durationS,
			series: norm.series,
			totals: norm.totals,
			constants: norm.constants,
		};
		const created = await api.post('/items/conform_logs', logBody, { params: { fields: LOG_FIELDS } });
		log = toLog({ ...logBody, ...(created.data?.data ?? {}) });
		logId = log.log_id;
		run = await saveRun(api, existing, {
			operation_id: op.operation_id,
			log_id: log.log_id,
			window_start: norm.logStart,
			window_end: norm.logEnd,
			status: 'done',
			summary,
			steps,
			error_message: null,
		});
	} catch (e) {
		if (logId) { try { await api.delete(`/items/conform_logs/${logId}`); } catch { /* best effort */ } }
		try { await api.delete(`/files/${fileId}`); } catch { /* best effort */ }
		throw toLogError(e);
	}

	return { run, log, dateWarning: await reconcileDate(api, op, norm.logStart) };
}

/**
 * An empty run date is set from the log. A date more than a day from the log's start is left alone, with a
 * warning. Failing to set the date does not undo the upload; it is reported as a warning too.
 */
async function reconcileDate(api: AxiosInstance, op: { operation_id: string; operation_date: string | null }, logStart: string): Promise<string | null> {
	const logDay = ukDate(logStart);
	if (!op.operation_date) {
		try {
			await api.patch(`/items/manufacturing_operations/${op.operation_id}`, { operation_date: logStart });
			return null;
		} catch (e) {
			return `The run's date could not be set from the log (${directusMessage(e) || (e as Error)?.message || 'request failed'}).`;
		}
	}
	const runDay = ukDate(instantMs(op.operation_date));
	const apart = Math.abs(Date.parse(`${logDay}T00:00:00Z`) - Date.parse(`${runDay}T00:00:00Z`)) / DAY_MS;
	return apart > 1 ? `The log starts on ${logDay}, more than a day from the run's date ${runDay}; the date was not changed.` : null;
}

/** Link a log that is already uploaded. The window starts empty. */
export async function linkExistingLog(api: AxiosInstance, operationId: string, logId: string): Promise<ConformRunRow> {
	return guarded(async () => saveRun(api, await getRunRow(api, operationId), {
		operation_id: operationId,
		log_id: logId,
		window_start: null,
		window_end: null,
		status: 'no_window',
		summary: null,
		steps: null,
		error_message: null,
	}));
}

async function needLog(api: AxiosInstance, run: any | null): Promise<{ run: any; log: ConformLogRow }> {
	if (!run?.log_id) throw new ConformLogError('This run has no Conform log yet.');
	const log = await getLogRow(api, run.log_id);
	if (!log) throw new ConformLogError('Conform log not visible to you.');
	return { run, log };
}

/**
 * Set the run window, then recompute the summary and steps over it. The database refuses a window outside the log
 * or one that overlaps another run (the message is rethrown as a ConformLogError). Empty setpoint fields on the
 * operation are filled from the first step.
 */
export async function setRunWindow(api: AxiosInstance, operationId: string, startIso: string, endIso: string): Promise<ConformRunRow> {
	const startMs = Date.parse(startIso);
	const endMs = Date.parse(endIso);
	if (Number.isNaN(startMs) || Number.isNaN(endMs)) throw new ConformLogError('The window times are not valid.');
	if (!(startMs < endMs)) throw new ConformLogError('The window must start before it ends.');
	const { run: raw, log } = await needLog(api, await getRunRow(api, operationId));
	const trace = await loadLogTrace(api, log);
	const logStartMs = Date.parse(log.log_start);
	const summary = summariseWindow(trace, logStartMs, startMs, endMs);
	const steps = detectSteps(trace, logStartMs, startMs, endMs);
	const run = await guarded(() => saveRun(api, raw, {
		window_start: new Date(startMs).toISOString(),
		window_end: new Date(endMs).toISOString(),
		status: 'done',
		summary,
		steps,
		error_message: null,
	}));
	await fillSetpoints(api, operationId, steps);
	return run;
}

// The wheel speed and IPS setpoint fields start from the first step, but only while they are empty.
async function fillSetpoints(api: AxiosInstance, operationId: string, steps: ConformStep[]): Promise<void> {
	if (!steps.length) return;
	try {
		const res = await api.get(`/items/manufacturing_operations/${operationId}`, { params: { fields: ['conform_wheel_speed_rpm', 'conform_ips_setpoint_c'] } });
		const op = res.data?.data ?? {};
		const patch: Record<string, number> = {};
		if (op.conform_wheel_speed_rpm === null || op.conform_wheel_speed_rpm === undefined) patch.conform_wheel_speed_rpm = steps[0].wheel_speed_rpm;
		if (op.conform_ips_setpoint_c === null || op.conform_ips_setpoint_c === undefined) patch.conform_ips_setpoint_c = steps[0].ips_setpoint_c;
		if (Object.keys(patch).length) await api.patch(`/items/manufacturing_operations/${operationId}`, patch);
	} catch {
		// a convenience: the window itself is already saved
	}
}

/**
 * Recompute the run's summary and steps over its window with the current code and power constants, from the stored
 * normalised CSV (never the original upload). The log's whole-log totals and constants are refreshed too when this
 * user may edit the log.
 */
export async function recomputeRun(api: AxiosInstance, operationId: string): Promise<ConformRunRow> {
	const { run: raw, log } = await needLog(api, await getRunRow(api, operationId));
	if (!raw.window_start || !raw.window_end) return toRun(raw);
	const trace = await loadLogTrace(api, log);
	const logStartMs = Date.parse(log.log_start);
	const startMs = instantMs(raw.window_start);
	const endMs = instantMs(raw.window_end);
	const summary = summariseWindow(trace, logStartMs, startMs, endMs);
	const steps = detectSteps(trace, logStartMs, startMs, endMs);
	const run = await guarded(() => saveRun(api, raw, { status: 'done', summary, steps, error_message: null }));
	try {
		await api.patch(`/items/conform_logs/${log.log_id}`, { totals: wholeLogTotals(trace), constants: { ...CONFORM_POWER_CONSTANTS } });
	} catch {
		// no right to edit the log: the run itself is up to date
	}
	return run;
}
