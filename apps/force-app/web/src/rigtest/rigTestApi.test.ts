import { afterEach, describe, expect, it, vi } from 'vitest';
import { accept, answer, cancelRun, decline, detailText, getEligibility, getPending, getRun, snooze } from './rigTestApi';

function stub(status: number, body: unknown) {
	const f = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
	vi.stubGlobal('fetch', f);
	return f;
}
afterEach(() => vi.unstubAllGlobals());

describe('GET routes', () => {
	it('an older backend (404) is "missing", not an error', async () => {
		stub(404, { detail: 'Not Found' });
		expect((await getPending()).kind).toBe('missing');
		expect((await getRun()).kind).toBe('missing');
		expect((await getEligibility()).kind).toBe('missing');
	});
	it('an unreachable backend is an error, never a throw', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
		const r = await getPending();
		expect(r).toMatchObject({ kind: 'error', status: 0 });
	});
	it('GET /run: idle is no run, a run is parsed', async () => {
		stub(200, { state: 'idle' });
		expect(await getRun()).toEqual({ kind: 'ok', data: null });
		stub(200, { number: 3, state: 'running', steps: [] });
		const r = await getRun();
		expect(r.kind === 'ok' && r.data?.number).toBe(3);
	});
	it('GET /eligibility defaults relay to not_configured', async () => {
		stub(200, { eligible: true, rig_id: 'rig-1' });
		expect(await getEligibility()).toEqual({ kind: 'ok', data: { eligible: true, rig_id: 'rig-1', reason: undefined, relay: 'not_configured' } });
	});
	it('GET /eligibility keeps relay "unknown" (the relay has not been asked yet)', async () => {
		stub(200, { eligible: true, rig_id: 'rig-1', relay: 'unknown' });
		const r = await getEligibility();
		expect(r.kind === 'ok' && r.data.relay).toBe('unknown');
	});
	it('GET /eligibility keeps relay "token_rejected" (the relay refused this PC\'s token)', async () => {
		stub(200, { eligible: true, rig_id: 'rig-1', relay: 'token_rejected' });
		const r = await getEligibility();
		expect(r.kind === 'ok' && r.data.relay).toBe('token_rejected');
	});
	it('GET /pending returns requests, snoozed and busy', async () => {
		stub(200, { requests: [{ number: 1 }], snoozed: [{ number: 2, snoozed_until: 'after_recording' }], busy: true });
		const r = await getPending();
		expect(r.kind === 'ok' && [r.data.requests.length, r.data.snoozed[0].snoozed_until, r.data.busy]).toEqual([1, 'after_recording', true]);
	});
	it('GET /pending calls the contract path on the configured recorder', async () => {
		const f = stub(200, { requests: [] });
		await getPending();
		expect((f.mock.calls[0] as unknown as [string])[0]).toMatch(/\/rig-tests\/pending$/);
	});
});

describe('POST routes', () => {
	const sent = (f: ReturnType<typeof stub>) => {
		const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
		return { url, method: init.method, body: JSON.parse(String(init.body ?? 'null')) };
	};
	it('accept sends the full mode and the upload state', async () => {
		const f = stub(200, { ok: true });
		await accept(231, { uploadBusy: true });
		expect(sent(f)).toMatchObject({ method: 'POST', body: { mode: 'full', upload_busy: true } });
		expect(sent(f).url).toMatch(/\/rig-tests\/231\/accept$/);
		expect(sent(f).body).not.toHaveProperty('operator');
		expect(sent(f).body).not.toHaveProperty('app_version');
	});
	it('accept sends the operator name and the app version when known', async () => {
		const f = stub(200, { ok: true });
		await accept(231, { uploadBusy: false, operator: 'Ada Lovelace', appVersion: '0.1.37' });
		expect(sent(f).body).toEqual({ mode: 'full', upload_busy: false, operator: 'Ada Lovelace', app_version: '0.1.37' });
	});
	it('a 409 carries the backend detail for the prompt to show inline', async () => {
		stub(409, { detail: 'a recording is in progress' });
		expect(await accept(231, { uploadBusy: false })).toEqual({ kind: 'error', status: 409, detail: 'a recording is in progress' });
	});
	it('a 404 on a POST is an error (the request vanished), not "missing"', async () => {
		stub(404, { detail: 'no such request' });
		expect(await decline(9, { reason_code: 'not_today' })).toMatchObject({ kind: 'error', status: 404, detail: 'no such request' });
	});
	it('snooze, decline, answer and cancel use the contract bodies', async () => {
		let f = stub(200, { ok: true });
		await snooze(5, 'after_recording');
		expect(sent(f)).toMatchObject({ body: { until: 'after_recording' } });
		f = stub(200, { ok: true });
		await decline(5, { reason_code: 'other', text: 'no sensor' });
		expect(sent(f)).toMatchObject({ body: { reason_code: 'other', text: 'no sensor' } });
		f = stub(200, { ok: true });
		await answer(2, 'Yes', 'saw it');
		expect(sent(f)).toMatchObject({ body: { step: 2, option: 'Yes', note: 'saw it' } });
		f = stub(200, { ok: true });
		await answer(2, 'Yes');
		expect(sent(f).body).toEqual({ step: 2, option: 'Yes' });
		f = stub(200, { ok: true });
		await cancelRun();
		expect(sent(f).url).toMatch(/\/rig-tests\/run\/cancel$/);
	});
});

describe('detailText', () => {
	it('reads a string detail or the first validation message, else the fallback', () => {
		expect(detailText({ detail: 'busy' }, 'x')).toBe('busy');
		expect(detailText({ detail: [{ msg: 'bad until' }] }, 'x')).toBe('bad until');
		expect(detailText({}, 'fallback')).toBe('fallback');
		expect(detailText(null, 'fallback')).toBe('fallback');
	});
});
