import { describe, expect, it } from 'vitest';
import {
	DECLINE_REASONS, NOTIFY_MAX, clip, currentPosition, declineBody, estimateText, finishedText, formatApproxDuration, formatClock,
	httpUrl, justFinished, minimisedText, newRequests, parseHistory, parsePending, parseRequests, parseRun, relayInfo, snoozedUntilText, acceptBody, appVersionOf, isUploadBusy, operatorInitials, progress, promptMode, questionKey, rigBlocked, barAskText,
	questionNotification, requestNotification, runView, secondsLeft, shouldReopen, snoozeUntil, stepMark, summaryCounts, timeLeft,
	type RigRequest, type RigRun, type RunStep, type StepStatus,
} from './rigTestLogic';

function step(index: number, status: StepStatus, extra: Partial<RunStep> = {}): RunStep {
	return { index, item_id: 'R4', kind: 'ask', text: `step ${index}`, status, ...extra };
}
function run(extra: Partial<RigRun> = {}): RigRun {
	return {
		number: 231, title: '', url: '', state: 'running', started_at: '2026-10-11T14:02:00Z', deadline_at: '2026-10-11T14:30:00Z',
		elapsed_s: 120, estimate_s: 720,
		steps: [step(0, 'pass'), step(1, 'fail'), step(2, 'active'), step(3, 'pending')],
		current: 2, ...extra,
	};
}
const q = { step: 2, text: 'Pull the cable', options: ['Yes', 'No'], expires_at: '2026-10-11T14:07:00Z' };

describe('rigBlocked', () => {
	const idle = { phase: null, saveDialogOpen: false } as const;
	it('is clear only when the shell says idle, no Save dialog is open and the backend is not busy', () => {
		expect(rigBlocked(idle)).toBe(false);
		expect(rigBlocked({ ...idle, backendBusy: false })).toBe(false);
	});
	it('is blocked while recording or finalizing', () => {
		expect(rigBlocked({ ...idle, phase: 'recording' })).toBe(true);
		expect(rigBlocked({ ...idle, phase: 'finalizing' })).toBe(true);
	});
	it('is blocked while the Save dialog is open, even though the phase is already null', () => {
		expect(rigBlocked({ phase: null, saveDialogOpen: true })).toBe(true);
	});
	it('is blocked until the shell has answered once, and when the backend says it is busy', () => {
		expect(rigBlocked({ ...idle, phase: 'unknown' })).toBe(true);
		expect(rigBlocked({ ...idle, backendBusy: true })).toBe(true);
	});
});

describe('promptMode: dialog or badge', () => {
	it('is a dialog when not blocked', () => expect(promptMode(1, false, false)).toBe('dialog'));
	it('is only a badge while blocked: never a dialog over the Record page mid-cut or over the Save dialog', () => {
		expect(promptMode(1, false, true)).toBe('badge');
	});
	it('is nothing without requests, or while a run is active', () => {
		expect(promptMode(0, false, false)).toBe('none');
		expect(promptMode(0, false, true)).toBe('none');
		expect(promptMode(2, true, false)).toBe('none');
		expect(promptMode(2, true, true)).toBe('none');
	});
});

describe('estimate text', () => {
	it('says how long and how many steps need the operator', () => {
		expect(estimateText(720, 3)).toBe('about 12 min, 3 steps need you');
		expect(estimateText(240, 1)).toBe('about 4 min, 1 step needs you');
		expect(estimateText(240, 0)).toBe('about 4 min, nothing needed from you');
	});
	it('never says 0 min, and switches to hours past 90 min', () => {
		expect(formatApproxDuration(10)).toBe('1 min');
		expect(formatApproxDuration(90 * 60)).toBe('90 min');
		expect(formatApproxDuration(95 * 60)).toBe('1 h 35 min');
		expect(formatApproxDuration(120 * 60)).toBe('2 h');
	});
});

describe('countdown from expires_at', () => {
	const t0 = Date.parse('2026-10-11T14:00:00Z');
	it('counts whole seconds up, never negative', () => {
		expect(secondsLeft('2026-10-11T14:05:00Z', t0)).toBe(300);
		expect(secondsLeft('2026-10-11T14:00:00.200Z', t0)).toBe(1);
		expect(secondsLeft('2026-10-11T13:59:00Z', t0)).toBe(0);
	});
	it('is 0 for a time that does not parse', () => expect(secondsLeft('soon', t0)).toBe(0));
	it('formats m:ss', () => {
		expect(formatClock(300)).toBe('5:00');
		expect(formatClock(65)).toBe('1:05');
		expect(formatClock(-3)).toBe('0:00');
	});
});

describe('progress', () => {
	it('counts settled steps (anything but pending/active) and caps the time bar at full', () => {
		const p = progress(run());
		expect(p).toMatchObject({ done: 2, total: 4, stepFraction: 0.5 });
		expect(p.timeFraction).toBeCloseTo(120 / 720);
		expect(progress(run({ elapsed_s: 5000 })).timeFraction).toBe(1);
	});
	it('does not divide by zero', () => {
		expect(progress(run({ steps: [], estimate_s: 0 }))).toMatchObject({ total: 0, stepFraction: 0, timeFraction: 0 });
	});
});

describe('minimised bar text', () => {
	it('reads "Rig test #N, step i/n, about m min left"', () => {
		expect(minimisedText(run())).toBe('Rig test #231, step 3/4, about 10 min left');
	});
	it('finds the step from `current`, else the first unsettled one', () => {
		expect(currentPosition(run({ current: 3 }))).toBe(4);
		expect(currentPosition(run({ current: undefined }))).toBe(3);
		expect(currentPosition(run({ current: 99 }))).toBe(3);
	});
	it('does not promise minutes once the estimate is spent', () => {
		expect(timeLeft(run({ elapsed_s: 700 }))).toBe('under a minute');
		expect(timeLeft(run({ elapsed_s: 900 }))).toBe('under a minute');
	});
});

describe('which view the run gets', () => {
	it('modal while running, bar once minimised, nothing when idle or over', () => {
		expect(runView(run(), false, false)).toBe('modal');
		expect(runView(run(), true, false)).toBe('bar');
		expect(runView(null, false, false)).toBe('none');
		expect(runView(run({ state: 'done' }), false, false)).toBe('none');
	});
	it('a finished run shows its summary modal, minimised or not', () => {
		expect(runView(run({ state: 'partial' }), true, true)).toBe('modal');
	});
	it('while blocked (a cut is recording or being saved) a question shows on the bar, never the modal', () => {
		expect(runView(run({ question: q }), false, false, true)).toBe('bar');
		expect(runView(run({ question: q }), false, false, false)).toBe('modal');
		expect(barAskText(true)).toMatch(/after this cut/);
		expect(barAskText(false)).toBe('Waiting for you');
	});
	it('while blocked a finished summary waits instead of opening over the Save dialog', () => {
		expect(runView(run({ state: 'done' }), false, true, true)).toBe('none');
	});
	it('reopens for a new question but not for the same one the operator minimised', () => {
		const asking = run({ question: q });
		expect(shouldReopen(run(), asking)).toBe(true);
		expect(shouldReopen(asking, asking)).toBe(false);
		expect(shouldReopen(asking, run({ question: { ...q, step: 3 } }))).toBe(true);
		expect(shouldReopen(asking, run())).toBe(false);
		expect(questionKey(asking)).toBe('231:2');
		expect(questionKey(run())).toBeNull();
	});
	it('reopens for a run that just started, not for a run that is over', () => {
		expect(shouldReopen(null, run())).toBe(true);
		expect(shouldReopen(run({ number: 1 }), run({ number: 2 }))).toBe(true);
		expect(shouldReopen(run(), run({ state: 'done', question: q }))).toBe(false);
	});
	it('announces a run only when it was seen ending', () => {
		expect(justFinished(run(), run({ state: 'done' }))).toBe(true);
		expect(justFinished(null, run({ state: 'done' }))).toBe(false);
		expect(justFinished(run({ state: 'done' }), run({ state: 'done' }))).toBe(false);
		expect(justFinished(run({ number: 1 }), run({ number: 2, state: 'done' }))).toBe(false);
		expect(finishedText('timed_out')).toMatch(/out of time/);
	});
});

describe('step marks', () => {
	it('gives every status a distinct readable label', () => {
		const statuses: StepStatus[] = ['pending', 'active', 'pass', 'fail', 'no_response', 'skipped_dependency', 'cancelled', 'error'];
		const labels = statuses.map((s) => stepMark(s).label);
		expect(new Set(labels).size).toBe(statuses.length);
		expect(stepMark('pass').tone).toBe('ok');
		expect(stepMark('fail').tone).toBe('bad');
	});
});

describe('decline reasons', () => {
	it('maps each chip to the contract reason_code', () => {
		expect(DECLINE_REASONS.map((r) => r.code)).toEqual(['about_to_record', 'machine_in_use', 'rig_not_set_up', 'not_today', 'other']);
	});
	it('sends only the code for the ready-made reasons, even if text was typed earlier', () => {
		expect(declineBody('machine_in_use', 'stale text')).toEqual({ reason_code: 'machine_in_use' });
		expect(declineBody('not_today', '')).toEqual({ reason_code: 'not_today' });
	});
	it('"other" needs its text, trimmed and bounded', () => {
		expect(declineBody('other', '   ')).toBeNull();
		expect(declineBody('other', ' no sensor today ')).toEqual({ reason_code: 'other', text: 'no sensor today' });
		expect(declineBody('other', 'x'.repeat(1000))!.text).toHaveLength(300);
	});
	it('needs a reason chosen', () => expect(declineBody(null, 'x')).toBeNull());
});

describe('snooze', () => {
	const now = new Date(2026, 9, 11, 14, 0, 0); // local 14:00
	it('adds minutes to now', () => {
		expect(snoozeUntil({ kind: 'minutes', minutes: 30 }, now)).toBe(new Date(now.getTime() + 30 * 60_000).toISOString());
		expect(snoozeUntil({ kind: 'minutes', minutes: 120 }, now)).toBe(new Date(now.getTime() + 120 * 60_000).toISOString());
	});
	it('after this recording is sent as the literal the contract names', () => {
		expect(snoozeUntil({ kind: 'after_recording' }, now)).toBe('after_recording');
	});
	it('a time of day later today, or the same time tomorrow when it has passed', () => {
		expect(snoozeUntil({ kind: 'time', hhmm: '17:00' }, now)).toBe(new Date(2026, 9, 11, 17, 0, 0).toISOString());
		expect(snoozeUntil({ kind: 'time', hhmm: '09:30' }, now)).toBe(new Date(2026, 9, 12, 9, 30, 0).toISOString());
		expect(snoozeUntil({ kind: 'time', hhmm: '14:00' }, now)).toBe(new Date(2026, 9, 12, 14, 0, 0).toISOString());
	});
	it('rejects a time that is not HH:MM', () => {
		for (const bad of ['', '25:00', '9', 'noon', '12:60']) expect(snoozeUntil({ kind: 'time', hhmm: bad }, now)).toBeNull();
	});
});

describe('history counts', () => {
	it('reads counts, items or steps, whichever the backend sends', () => {
		expect(summaryCounts({ number: 1, state: 'done', counts: { pass: 3, fail: 1, error: 1 } })).toEqual({ pass: 3, fail: 2 });
		expect(summaryCounts({ number: 1, state: 'partial', items: [{ result: 'pass' }, { result: 'fail' }, { result: 'skipped_dependency' }] })).toEqual({ pass: 1, fail: 1 });
		expect(summaryCounts({ number: 1, state: 'done', steps: [{ status: 'pass' }, { status: 'pass' }] })).toEqual({ pass: 2, fail: 0 });
		expect(summaryCounts({ number: 1, state: 'cancelled' })).toEqual({ pass: 0, fail: 0 });
	});
});

describe('parsing the backend answers', () => {
	it('{state: "idle"} and junk are no run', () => {
		expect(parseRun({ state: 'idle' })).toBeNull();
		expect(parseRun(null)).toBeNull();
		expect(parseRun({ state: 'exploded' })).toBeNull();
	});
	it('fills what a run lacks instead of throwing', () => {
		const r = parseRun({ number: 7, state: 'running', steps: [{ kind: 'note', text: 'hi' }], question: { step: 0, text: 'q', options: ['A', 3], expires_at: '2026-10-11T14:00:00Z' } })!;
		expect(r.steps[0]).toMatchObject({ index: 0, kind: 'note', status: 'pending' });
		expect(r.question!.options).toEqual(['A']);
		expect(r.elapsed_s).toBe(0);
		expect(parseRun({ number: 7, state: 'running', question: { text: 'no expiry' } })!.question).toBeUndefined();
	});
	it('drops requests without a number and defaults the rest', () => {
		const list = parseRequests({ requests: [{ title: 'no number' }, { number: 5, estimate_s: { full: 60, automated: 0 } }] });
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ number: 5, title: 'Request #5', needs_operator_steps: 0, items: [] });
		expect(parseRequests(undefined)).toEqual([]);
		expect(parseHistory({ runs: [{ number: 2 }, { nope: 1 }] })).toEqual([{ number: 2, state: 'unknown' }]);
	});
});

describe('desktop notifications', () => {
	const req = (n: number): RigRequest => ({
		number: n, title: 'R4 pre-flight', url: '', requested_by: 'dpremoli', created_at: '',
		items: [], estimate_s: { full: 720, automated: 0 }, needs_operator_steps: 3,
	});
	it('only requests not seen before are announced', () => {
		expect(newRequests(new Set([1]), [req(1), req(2)]).map((r) => r.number)).toEqual([2]);
	});
	it('both strings stay within what the desktop shell accepts', () => {
		const long = { ...req(9), title: 'x'.repeat(500), requested_by: 'y'.repeat(500) };
		const n = requestNotification(long);
		expect(n.title.length).toBeLessThanOrEqual(NOTIFY_MAX);
		expect(n.body.length).toBeLessThanOrEqual(NOTIFY_MAX);
		const asking = questionNotification(run({ question: { ...q, text: 'z'.repeat(900) } }))!;
		expect(asking.title).toBe('Rig test #231 needs you');
		expect(asking.body.length).toBe(NOTIFY_MAX);
		expect(questionNotification(run())).toBeNull();
		expect(clip('abc', 10)).toBe('abc');
	});
	it('names who asked and the estimate', () => {
		const n = requestNotification(req(231));
		expect(n.title).toContain('dpremoli');
		expect(n.body).toBe('#231 R4 pre-flight (about 12 min, 3 steps need you)');
	});
});

describe('parsePending: the requests, the snoozed ones and the busy flag', () => {
	it('reads snoozed requests with their return time, and busy', () => {
		const p = parsePending({
			requests: [{ number: 5 }],
			snoozed: [{ title: 'no number' }, { number: 7, title: 'later', snoozed_until: '2026-10-11T17:00:00Z' }, { number: 8, snoozed_until: 'after_recording' }],
			busy: true,
		});
		expect(p.requests.map((r) => r.number)).toEqual([5]);
		expect(p.snoozed.map((r) => [r.number, r.snoozed_until])).toEqual([[7, '2026-10-11T17:00:00Z'], [8, 'after_recording']]);
		expect(p.busy).toBe(true);
	});
	it('an older backend (only `requests`) means nothing snoozed and not busy', () => {
		expect(parsePending({ requests: [{ number: 5 }] })).toMatchObject({ snoozed: [], busy: false });
		expect(parsePending(null)).toEqual({ requests: [], snoozed: [], busy: false });
		expect(parsePending({ busy: 'yes', snoozed: 4 })).toEqual({ requests: [], snoozed: [], busy: false });
	});
	it('a run carries its title and link, empty from an older backend', () => {
		expect(parseRun({ number: 7, state: 'running', title: 'R4 chips', url: 'https://x/7' })).toMatchObject({ title: 'R4 chips', url: 'https://x/7' });
		expect(parseRun({ number: 7, state: 'running' })).toMatchObject({ title: '', url: '' });
	});
});

describe('relayInfo and snoozedUntilText', () => {
	it('"unknown" reads as not checked yet, never as reachable', () => {
		expect(relayInfo('unknown').text).toBe('Request relay not checked yet');
		expect(relayInfo('unknown').tone).not.toBe('ok');
		expect(relayInfo('ok').text).toBe('Request relay reachable');
		expect(relayInfo('unreachable').tone).toBe('bad');
		expect(relayInfo(undefined).text).toMatch(/not configured/);
		expect(relayInfo('token_rejected').tone).toBe('bad');
		expect(relayInfo('token_rejected').text).toMatch(/rig token/);
	});
	it('says when a snoozed request comes back', () => {
		expect(snoozedUntilText('after_recording')).toMatch(/next recording/);
		expect(snoozedUntilText('2026-10-11T17:00:00Z')).toMatch(/^Snoozed until .+/);
		expect(snoozedUntilText('garbage')).toBe('Snoozed');
	});
});

describe('what accept tells the recorder', () => {
	it('the operator is initials only: never the name or the email (the repository is public)', () => {
		expect(operatorInitials({ first_name: 'Ada', last_name: 'Lovelace' })).toBe('A.L.');
		expect(operatorInitials({ first_name: ' ada ', last_name: null })).toBe('A.');
		expect(operatorInitials({ last_name: 'Lovelace' })).toBe('L.');
		expect(operatorInitials({ first_name: 'Ünal', last_name: '"Çelik"' })).toBe('Ü.Ç.');
		expect(operatorInitials({ first_name: '1', last_name: '_' })).toBeUndefined();
		expect(operatorInitials({ first_name: '', last_name: ' ' })).toBeUndefined();
		expect(operatorInitials(null)).toBeUndefined();
		expect(operatorInitials({ first_name: 'Ada', last_name: 'L', email: 'ada@x.org' } as any)).toBe('A.L.');
	});
	it('the version is the shell\'s, else the bundled one, else absent', () => {
		expect(appVersionOf('0.1.37', '0.1.36')).toBe('0.1.37');
		expect(appVersionOf(undefined, '0.1.36')).toBe('0.1.36');
		expect(appVersionOf('', undefined)).toBeUndefined();
	});
	it('an upload is busy when the queue flushes or any capture file is going up', () => {
		expect(isUploadBusy(false, 0)).toBe(false);
		expect(isUploadBusy(true, 0)).toBe(true);
		expect(isUploadBusy(false, 1)).toBe(true);
	});
	it('the body omits what is unknown', () => {
		expect(acceptBody({ uploadBusy: false })).toEqual({ mode: 'full', upload_busy: false });
		expect(acceptBody({ uploadBusy: true, operator: 'Ada', appVersion: '1.0.0' }))
			.toEqual({ mode: 'full', upload_busy: true, operator: 'Ada', app_version: '1.0.0' });
	});
});

describe('httpUrl (what may be bound as an href)', () => {
	it('keeps http and https links', () => {
		expect(httpUrl('https://github.com/o/r/issues/231')).toBe('https://github.com/o/r/issues/231');
		expect(httpUrl('http://example.com/x')).toBe('http://example.com/x');
	});
	it('drops every other scheme, a relative path, an empty value and a non-string', () => {
		const bad = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', 'file:///C:/x', 'vbscript:x', '//evil.example', '/issues/1', '', '   ', null, undefined, 7, {}];
		for (const b of bad) expect(httpUrl(b)).toBe('');
	});
});
