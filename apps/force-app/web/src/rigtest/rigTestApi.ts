// Typed client for the recorder's /rig-tests/* routes (the contract in
// docs/superpowers/plans/2026-10-11-rig-test-requests-phase1.md). Like every other recorder client
// it only talks to the local backend; the backend alone talks to the relay and GitHub.
//
// Nothing here throws. A 404 on a GET means an older backend without these routes (the UI then
// shows nothing); any other failure comes back as { kind: 'error' } so the store can keep what it
// had. A POST's error carries the backend's `detail`, which the prompt shows inline (a 409 says why
// a request can't be accepted right now).
import { JSON_HEADERS, recorderBase } from '../recorderHttp';
import {
	parseHistory, parsePending, parseRun,
	type DeclineCode, type Eligibility, type PendingList, type RigRun, type RunSummary,
} from './rigTestLogic';

export type ApiResult<T> =
	| { kind: 'ok'; data: T }
	| { kind: 'missing' }
	| { kind: 'error'; status: number; detail: string };

/** FastAPI's `detail` is a string, or a list of validation errors; say something readable either way. */
export function detailText(body: unknown, fallback: string): string {
	const d = (body as { detail?: unknown } | null)?.detail;
	if (typeof d === 'string' && d) return d.slice(0, 300);
	if (Array.isArray(d) && d.length) {
		const first = d[0] as { msg?: unknown };
		if (typeof first?.msg === 'string') return first.msg.slice(0, 300);
	}
	return fallback;
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResult<unknown>> {
	let res: Response;
	try {
		res = await fetch(`${recorderBase()}/rig-tests${path}`, {
			method,
			headers: body === undefined ? undefined : JSON_HEADERS,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch {
		return { kind: 'error', status: 0, detail: "couldn't reach the recording backend" };
	}
	let json: unknown = null;
	try { json = await res.json(); } catch { /* not JSON: a proxy error page, an empty 204 */ }
	if (res.ok) return { kind: 'ok', data: json };
	if (res.status === 404 && method === 'GET') return { kind: 'missing' };
	return { kind: 'error', status: res.status, detail: detailText(json, `the backend answered ${res.status}`) };
}

function map<T, U>(r: ApiResult<T>, f: (d: T) => U): ApiResult<U> {
	return r.kind === 'ok' ? { kind: 'ok', data: f(r.data) } : r;
}

export async function getEligibility(): Promise<ApiResult<Eligibility>> {
	return map(await call('GET', '/eligibility'), (d) => {
		const e = (d ?? {}) as Partial<Eligibility>;
		return {
			eligible: !!e.eligible, rig_id: typeof e.rig_id === 'string' ? e.rig_id : '',
			reason: typeof e.reason === 'string' ? e.reason : undefined,
			relay: e.relay === 'ok' || e.relay === 'unreachable' || e.relay === 'unknown' ? e.relay : 'not_configured',
		};
	});
}

export async function getPending(): Promise<ApiResult<PendingList>> {
	return map(await call('GET', '/pending'), parsePending);
}

/** `null` data = no run (the backend's `{state: "idle"}`). */
export async function getRun(): Promise<ApiResult<RigRun | null>> {
	return map(await call('GET', '/run'), parseRun);
}

export async function getHistory(): Promise<ApiResult<RunSummary[]>> {
	return map(await call('GET', '/history'), parseHistory);
}

export const accept = (n: number, uploadBusy: boolean) =>
	call('POST', `/${n}/accept`, { mode: 'full', upload_busy: uploadBusy });

export const snooze = (n: number, until: string) => call('POST', `/${n}/snooze`, { until });

export const decline = (n: number, body: { reason_code: DeclineCode; text?: string }) =>
	call('POST', `/${n}/decline`, body);

export const answer = (step: number, option: string, note?: string) =>
	call('POST', '/run/answer', note ? { step, option, note } : { step, option });

export const cancelRun = () => call('POST', '/run/cancel');

/** The whole client, as the store takes it (tests pass a fake). */
export const rigTestApi = { getEligibility, getPending, getRun, getHistory, accept, snooze, decline, answer, cancelRun };
export type RigTestApi = typeof rigTestApi;
