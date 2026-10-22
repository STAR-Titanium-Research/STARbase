// Data access for Conform runs: upload a log, link a log already uploaded, set the run window, unlink, recompute.
// Everything goes through the host's axios instance (`FastHost.api`, which carries the base URL and the session),
// so this works unchanged in the Directus module and in STARbase.
import type { AxiosInstance } from 'axios';
import { loadTrace, parseTrace, type SeriesMeta, type Trace } from '../fastCache';
import { ConformLogError, ConformLogHiddenError, LOG_LOAD_FAILED } from './channels';
import { ukDate } from './clock';
import { sha256Hex } from './hash';
import { normaliseLog, type ConformTotals } from './normalise';
import { decodeLogBytes, parseConformCsv, parseIsoMs } from './parse';
import { CONFORM_POWER_CONSTANTS } from './power';
import { detectSteps, type ConformStep } from './steps';
import { summariseWindow, type ConformSummary } from './summary';

/** A run's window on a log as `conform_logs.run_windows` keeps it (kept by a trigger; only rows with both ends). */
export interface RawLogWindow { operation_id: string; start: string; end: string }
/** The same with a label: the feedstock or code of a run the reader can see, "Other run" for any other. */
export interface LogWindow extends RawLogWindow { label: string; readable: boolean }

export interface ConformLogRow {
	log_id: string; directus_files_id: string; equipment_id: string | null; source_filename: string;
	/** Lowercase hex SHA-256 of the uploaded file's raw bytes (unique). */
	source_sha256: string;
	log_start: string; log_end: string; n_rows: number; duration_s: number;
	series: SeriesMeta[]; totals: ConformTotals; constants: typeof CONFORM_POWER_CONSTANTS;
	/** Every run window on this log (sorted by start); the run being looked at is one of them. */
	run_windows: RawLogWindow[];
}
export interface ConformRunRow {
	id: string; operation_id: string; log_id: string | null; window_start: string | null; window_end: string | null;
	status: 'no_log' | 'no_window' | 'done' | 'error'; summary: ConformSummary | null; steps: ConformStep[] | null; error_message: string | null;
}
/** A Conform run as the plotter and the Operation page hold it: the run row (null while none exists), its log, and whether the log is one this reader may not see. */
export interface ConformRunBundle { run: ConformRunRow | null; log: ConformLogRow | null; logHidden: boolean }
/** A log offered in a picker, with the windows already on it. */
export interface CandidateLog extends ConformLogRow { windows: LogWindow[] }

/** The fixed id of the Directus folder "Conform Logs" (seeded by migration 210). Uploads go into it with no lookup by name. */
export const CONFORM_LOGS_FOLDER_ID = 'c04f1000-0000-4000-8000-000000000001';
/** What a refused duplicate says (the database's unique error on `source_sha256`). */
export const ALREADY_UPLOADED = 'This log is already uploaded: use “Use a log already uploaded”.';
export const OTHER_RUN = 'Other run';

const LOG_FIELDS = ['log_id', 'directus_files_id', 'equipment_id', 'source_filename', 'source_sha256', 'log_start', 'log_end', 'n_rows', 'duration_s', 'series', 'totals', 'constants', 'run_windows'];
const RUN_FIELDS = ['id', 'operation_id', 'log_id', 'window_start', 'window_end', 'status', 'summary', 'steps', 'error_message'];
const DAY_MS = 86_400_000;
const LABEL_CHUNK = 40;

// ---------------------------------------------------------------- plumbing

const httpStatus = (e: any): number | undefined => e?.response?.status;
const directusError = (e: any): { message?: string; extensions?: { code?: string; field?: string } } | undefined => e?.response?.data?.errors?.[0];
// The server's hook refusals (HTTP 400, INVALID_PAYLOAD) carry the sentence to show in `extensions.reason` and in `message`: reason first, shown verbatim.
const directusMessage = (e: any): string | undefined => {
	const x = directusError(e) as { message?: string; extensions?: { reason?: unknown } } | undefined;
	const reason = x?.extensions?.reason;
	return typeof reason === 'string' && reason.trim() ? reason : x?.message;
};

/**
 * A Directus error message becomes a ConformLogError with that text (e.g. `Run window overlaps 17-03-25-CF-011 on this log.`).
 * The unique error on `source_sha256` becomes the "already uploaded" sentence.
 */
function toLogError(e: unknown): unknown {
	if (e instanceof ConformLogError) return e;
	const err = directusError(e);
	if (err?.extensions?.code === 'RECORD_NOT_UNIQUE' && (err.extensions.field === 'source_sha256' || /source_sha256/.test(err.message ?? ''))) {
		return new ConformLogError(ALREADY_UPLOADED);
	}
	const text = directusMessage(e);
	return text ? new ConformLogError(text) : e;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
	try { return await fn(); } catch (e) { throw toLogError(e); }
}

const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));

function rawWindows(v: unknown): RawLogWindow[] {
	if (!Array.isArray(v)) return [];
	return v
		.filter((w) => w && typeof w.operation_id === 'string' && typeof w.start === 'string' && typeof w.end === 'string')
		.map((w) => ({ operation_id: w.operation_id, start: w.start, end: w.end }));
}

function toLog(raw: any): ConformLogRow {
	return {
		log_id: raw.log_id,
		directus_files_id: raw.directus_files_id,
		equipment_id: raw.equipment_id ?? null,
		source_filename: raw.source_filename ?? '',
		source_sha256: raw.source_sha256 ?? '',
		log_start: raw.log_start,
		log_end: raw.log_end,
		n_rows: num(raw.n_rows),
		duration_s: num(raw.duration_s),
		series: raw.series ?? [],
		totals: raw.totals,
		constants: raw.constants,
		run_windows: rawWindows(raw.run_windows),
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

export async function loadConformRun(api: AxiosInstance, operationId: string): Promise<ConformRunBundle> {
	const raw = await getRunRow(api, operationId);
	if (!raw) return { run: null, log: null, logHidden: false };
	const run = toRun(raw);
	if (!run.log_id) return { run, log: null, logHidden: false };
	const log = await getLogRow(api, run.log_id);
	return { run, log, logHidden: log === null };
}

/**
 * The log's trace (time in seconds from log start), downloaded once per log and cached by `log_id` (loads in flight at
 * the same moment share the one download). A 403 on the file rejects with a ConformLogHiddenError ("Conform log not
 * visible to you"); any other failure with a ConformLogError ("Could not load the Conform log").
 */
export function loadLogTrace(api: AxiosInstance, log: ConformLogRow): Promise<Trace> {
	return loadTrace(log.log_id, log.series, async () => {
		try {
			const res = await api.get(`/assets/${log.directus_files_id}`, { responseType: 'text' });
			return res.data as string;
		} catch (e) {
			throw httpStatus(e) === 403 ? new ConformLogHiddenError() : new ConformLogError(LOG_LOAD_FAILED);
		}
	});
}

/** Whether a failure of `loadLogTrace` means the reader may not see the file (as against a failed download). */
export const isLogHidden = (e: unknown): boolean => e instanceof ConformLogHiddenError;

/**
 * `run_windows` entries with their labels. The reader may see only some of the runs: a run they can read is named by its
 * feedstock or its code, any other is "Other run". One read of the operations, which Directus filters to the readable ones.
 */
export async function labelWindows(api: AxiosInstance, windows: RawLogWindow[]): Promise<LogWindow[]> {
	const ids = [...new Set(windows.map((w) => w.operation_id))];
	const names = new Map<string, string>();
	for (let i = 0; i < ids.length; i += LABEL_CHUNK) {
		try {
			const res = await api.get('/items/manufacturing_operations', {
				params: { filter: { operation_id: { _in: ids.slice(i, i + LABEL_CHUNK) } }, fields: ['operation_id', 'pass_code', 'conform_feedstock'], limit: -1 },
			});
			for (const op of res.data?.data ?? []) names.set(op.operation_id, op.conform_feedstock || op.pass_code || 'Run');
		} catch {
			// no labels: every window is "Other run"
		}
	}
	return windows.map((w) => ({ ...w, label: names.get(w.operation_id) ?? OTHER_RUN, readable: names.has(w.operation_id) }));
}

/** Logs from the same machine (any machine when `equipmentId` is null) that start within a day of `aroundDate` (today when there is none). */
export async function listCandidateLogs(api: AxiosInstance, equipmentId: string | null, aroundDate: string | null): Promise<CandidateLog[]> {
	const day = Math.floor(instantMs(aroundDate || new Date().toISOString()) / DAY_MS) * DAY_MS;
	if (Number.isNaN(day)) return [];
	const and: unknown[] = [
		{ log_start: { _gte: new Date(day - DAY_MS).toISOString() } },
		{ log_start: { _lt: new Date(day + 2 * DAY_MS).toISOString() } },
	];
	if (equipmentId) and.push({ equipment_id: { _eq: equipmentId } });
	const res = await api.get('/items/conform_logs', { params: { filter: { _and: and }, fields: LOG_FIELDS, sort: ['log_start'], limit: -1 } });
	const logs: ConformLogRow[] = (res.data?.data ?? []).map(toLog);
	const labelled = await labelWindows(api, logs.flatMap((l) => l.run_windows));   // same order as given
	let at = 0;
	return logs.map((l) => {
		const windows = labelled.slice(at, at + l.run_windows.length);
		at += l.run_windows.length;
		return { ...l, windows };
	});
}

/** Every run window on a log, labelled (read from the log's own `run_windows`). A log the reader cannot read has none to show. */
export async function listLogWindows(api: AxiosInstance, logId: string): Promise<LogWindow[]> {
	const log = await getLogRow(api, logId);
	return log ? labelWindows(api, log.run_windows) : [];
}

/** The log already uploaded with exactly these bytes, or null. */
export async function findLogByHash(api: AxiosInstance, sha256: string): Promise<ConformLogRow | null> {
	const res = await api.get('/items/conform_logs', { params: { filter: { source_sha256: { _eq: sha256 } }, fields: LOG_FIELDS, limit: 1 } });
	const row = res.data?.data?.[0];
	return row ? toLog(row) : null;
}

// ---------------------------------------------------------------- writing

const baseName = (name: string): string => name.replace(/\.[^.]+$/, '') || 'conform-log';

/** The operation a log is attached to: what the upload needs to know about it. */
export interface UploadTarget { operation_id: string; equipment_id: string | null; operation_date: string | null; work_state?: string | null }

/**
 * Process the file in the browser, store the normalised CSV and the log row, and link the run to the whole log
 * with its summary and steps. A malformed file is refused before anything is uploaded. A file whose bytes are already
 * uploaded is not uploaded again: the result is `{ existing }`, for the caller to offer linking that log. If a write fails
 * after the file went up, the log row and the file are removed again and the error is rethrown.
 */
export async function uploadConformLog(
	api: AxiosInstance,
	op: UploadTarget,
	file: { name: string; bytes: ArrayBuffer | ArrayBufferView },
): Promise<{ run: ConformRunRow; log: ConformLogRow; dateWarning: string | null } | { existing: ConformLogRow }> {
	const parsed = parseConformCsv(decodeLogBytes(file.bytes));
	const norm = normaliseLog(parsed);
	const trace = parseTrace(norm.csvText, norm.series);
	const startMs = parsed.startMs;
	const endMs = parsed.endMs;
	const summary = summariseWindow(trace, startMs, startMs, endMs);
	const steps = detectSteps(trace, startMs, startMs, endMs);

	const sha = await sha256Hex(file.bytes);
	const existingLog = await findLogByHash(api, sha);
	if (existingLog) return { existing: existingLog };

	const existing = await getRunRow(api, op.operation_id);   // read first: a failure here leaves nothing behind

	const form = new FormData();
	form.append('folder', CONFORM_LOGS_FOLDER_ID);
	form.append('title', `${baseName(file.name)} (normalised)`);
	form.append('file', new Blob([norm.csvText], { type: 'text/csv' }), `${baseName(file.name)}-normalised.csv`);
	const fileId: string = (await guarded(() => api.post('/files', form))).data.data.id;

	let logId: string | null = null;
	let log: ConformLogRow;
	let run: ConformRunRow;
	try {
		// The id is chosen here, so the run can be linked (and a failed upload cleaned up)
		// even if the create returns no body.
		const logBody = {
			log_id: globalThis.crypto.randomUUID(),
			directus_files_id: fileId,
			equipment_id: op.equipment_id,
			source_filename: file.name,
			source_sha256: sha,
			log_start: norm.logStart,
			log_end: norm.logEnd,
			n_rows: norm.nRows,
			duration_s: norm.durationS,
			series: norm.series,
			totals: norm.totals,
			constants: norm.constants,
		};
		const created = await api.post('/items/conform_logs', logBody, { params: { fields: LOG_FIELDS } });
		log = toLog({ ...logBody, run_windows: [], ...(created.data?.data ?? {}) });
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
 * warning. Failing to set the date does not undo the upload; it is reported as a warning too. A planned run keeps
 * its date as it is (a planned run has no `operation_date` until the work is done), and says nothing.
 */
async function reconcileDate(api: AxiosInstance, op: UploadTarget, logStart: string): Promise<string | null> {
	if (op.work_state === 'planned') return null;
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

/** Link a log that is already uploaded. The window starts empty. The run's date is never touched. */
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

/**
 * Take the log off the run: no log, no window, no summary or steps, status `no_log`. If nothing else uses the log any more
 * (its `run_windows` is empty and no run row points at it) it is deleted, then its file. That is best effort and is the
 * database's decision: only the person who uploaded a log may delete it, and a log some run still uses is refused, so a
 * log somebody else uploaded, or one another run (even one this reader cannot see) uses, stays.
 */
export async function unlinkLog(api: AxiosInstance, operationId: string): Promise<{ logRemoved: boolean }> {
	const raw = await getRunRow(api, operationId);
	if (!raw?.log_id) return { logRemoved: false };
	const logId: string = raw.log_id;
	await guarded(() => saveRun(api, raw, {
		log_id: null, window_start: null, window_end: null, summary: null, steps: null, status: 'no_log', error_message: null,
	}));
	try {
		const log = await getLogRow(api, logId);
		if (!log || log.run_windows.length) return { logRemoved: false };
		const users = await api.get('/items/conform_run_data', { params: { filter: { log_id: { _eq: logId } }, fields: ['id'], limit: 1 } });
		if ((users.data?.data ?? []).length) return { logRemoved: false };
		await api.delete(`/items/conform_logs/${logId}`);
		try { await api.delete(`/files/${log.directus_files_id}`); } catch { /* the log row is gone; an orphan file is harmless */ }
		return { logRemoved: true };
	} catch {
		return { logRemoved: false };   // not the uploader, still in use, or no right to delete: the run is unlinked all the same
	}
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
	if (!(startMs < endMs)) throw new ConformLogError('Run window must start before it ends.');
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
 * normalised CSV (never the original upload). Only the run's own row is written: the log row is shared and members
 * cannot update it, so its whole-log totals keep the constants it was uploaded with.
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
	return guarded(() => saveRun(api, raw, { status: 'done', summary, steps, error_message: null }));
}
