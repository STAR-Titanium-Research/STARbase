import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult, RigTestApi } from './rigTestApi';
import { PENDING_POLL_MS, RUN_POLL_MS, createRigTestStore } from './rigTestStore';
import { saveDialogOpen } from './saveDialogOpen';
import type { PendingList, RigRequest, RigRun } from './rigTestLogic';

const ok = <T,>(data: T): ApiResult<T> => ({ kind: 'ok', data });
const pend = (requests: RigRequest[], extra: Partial<PendingList> = {}) => ok<PendingList>({ requests, snoozed: [], busy: false, session: true, hardwareOk: true, relay: 'ok', ...extra });
const req = (n: number): RigRequest => ({
	number: n, title: `Request ${n}`, url: `https://example/${n}`, requested_by: 'dpremoli', created_at: '2026-10-11T12:00:00Z',
	items: [], estimate_s: { full: 600, automated: 0 }, needs_operator_steps: 2,
});
const runOf = (extra: Partial<RigRun> = {}): RigRun => ({
	number: 1, title: '', url: '', state: 'running', started_at: '', deadline_at: '', elapsed_s: 0, estimate_s: 600,
	steps: [{ index: 0, item_id: 'R4', kind: 'ask', text: 'Pull the cable', status: 'active' }], current: 0, ...extra,
});
const q = { step: 0, text: 'Did the chip warn?', options: ['Yes', 'No'], expires_at: '2026-10-11T12:05:00Z' };

function fakeApi(over: Partial<Record<keyof RigTestApi, any>> = {}) {
	const api = {
		getEligibility: vi.fn(async () => ok({ eligible: true, rig_id: 'rig', relay: 'ok' as const, session: true, hardwareOk: true })),
		getPending: vi.fn(async () => pend([])),
		getRun: vi.fn(async () => ok<RigRun | null>(null)),
		getHistory: vi.fn(async () => ok([])),
		accept: vi.fn(async () => ok({ ok: true })),
		snooze: vi.fn(async () => ok({ ok: true })),
		decline: vi.fn(async () => ok({ ok: true })),
		answer: vi.fn(async () => ok({ ok: true })),
		cancelRun: vi.fn(async () => ok({ ok: true })),
		putSession: vi.fn(async () => ok({ ok: true })),
		deleteSession: vi.fn(async () => ok({ ok: true })),
		...over,
	};
	return api as typeof api & RigTestApi;
}
function make(api = fakeApi()) {
	const notify = vi.fn();
	const store = createRigTestStore({ api, notify, now: () => Date.now(), acceptContext: async () => ({ uploadBusy: false }) });
	store.setRecordingPhase(null); // the shell has answered: idle (the store starts at 'unknown')
	return { api, notify, store };
}

beforeEach(() => { saveDialogOpen.value = false; vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-11T12:00:00Z')); });
afterEach(() => vi.useRealTimers());

describe('polling', () => {
	it('polls pending every 30 s and the run only every 30 s while idle', async () => {
		const { api, store } = make();
		const stop = store.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(api.getPending).toHaveBeenCalledTimes(1);
		expect(api.getRun).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(PENDING_POLL_MS);
		expect(api.getPending).toHaveBeenCalledTimes(2);
		expect(api.getRun).toHaveBeenCalledTimes(2);
		stop();
	});

	it('polls the run every second while it is running, then stops', async () => {
		const api = fakeApi({ getRun: vi.fn(async () => ok<RigRun | null>(runOf())) });
		const { store } = make(api);
		const stop = store.start();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(RUN_POLL_MS * 5);
		expect(api.getRun.mock.calls.length).toBeGreaterThanOrEqual(6);
		stop();
		const after = api.getRun.mock.calls.length;
		await vi.advanceTimersByTimeAsync(PENDING_POLL_MS * 3);
		expect(api.getRun).toHaveBeenCalledTimes(after);
		expect(api.getPending).toHaveBeenCalledTimes(1);
	});

	it('stop() ignores a reply that was still in flight', async () => {
		let release!: (v: ApiResult<RigRequest[]>) => void;
		const api = fakeApi({ getPending: vi.fn(() => new Promise((r) => { release = r; })) });
		const { store } = make(api);
		const stop = store.start();
		stop();
		release(ok([req(1)]));
		await vi.advanceTimersByTimeAsync(0);
		expect(store.state.pending).toEqual([]);
	});

	it('a 404 (older backend) shows nothing, and a failed poll keeps what was shown', async () => {
		const api = fakeApi({ getPending: vi.fn(async () => pend([req(1)])) });
		const { store } = make(api);
		store.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(store.state.pending).toHaveLength(1);
		api.getPending.mockResolvedValueOnce({ kind: 'error', status: 0, detail: 'down' });
		await vi.advanceTimersByTimeAsync(PENDING_POLL_MS);
		expect(store.state.pending).toHaveLength(1);
		api.getPending.mockResolvedValueOnce({ kind: 'missing' });
		await vi.advanceTimersByTimeAsync(PENDING_POLL_MS);
		expect(store.state.pending).toEqual([]);
		expect(store.state.available).toBe(false);
		expect(store.mode.value).toBe('none');
		store.stop();
	});
});

describe('the pending answer', () => {
	it('keeps the snoozed list and the backend busy flag, and remembers titles of snoozed requests', async () => {
		const snoozed = [{ ...req(7), snoozed_until: 'after_recording' }];
		const api = fakeApi({ getPending: vi.fn(async () => pend([req(1)], { snoozed, busy: true })) });
		const { store } = make(api);
		store.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(store.state.snoozed.map((r) => r.number)).toEqual([7]);
		expect(store.state.backendBusy).toBe(true);
		expect(store.state.known[7].title).toBe('Request 7');
		store.stop();
	});
});

describe('what blocks the prompt and the run modal', () => {
	const asking = () => fakeApi({
		getPending: vi.fn(async () => pend([req(1)])),
		getRun: vi.fn(async () => ok<RigRun | null>(runOf({ question: q }))),
	});

	it('the phase is unknown until the shell answers: a badge, not a dialog (a reload mid-cut)', async () => {
		const api = fakeApi({ getPending: vi.fn(async () => pend([req(1)])) });
		const store = createRigTestStore({ api, notify: vi.fn(), now: () => Date.now(), acceptContext: async () => ({ uploadBusy: false }) });
		store.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(store.state.recordingPhase).toBe('unknown');
		expect(store.mode.value).toBe('badge');
		store.setRecordingPhase(null);
		expect(store.mode.value).toBe('dialog');
		store.stop();
	});

	it('the backend saying busy keeps the prompt a badge although the shell says idle', async () => {
		const { store } = make(fakeApi({ getPending: vi.fn(async () => pend([req(1)], { busy: true })) }));
		store.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(store.mode.value).toBe('badge');
		store.stop();
	});

	it('an open Save dialog keeps the prompt a badge although the phase is already null', async () => {
		const { store } = make(fakeApi({ getPending: vi.fn(async () => pend([req(1)])) }));
		store.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(store.mode.value).toBe('dialog');
		saveDialogOpen.value = true;
		expect(store.mode.value).toBe('badge');
		saveDialogOpen.value = false;
		expect(store.mode.value).toBe('dialog');
		store.stop();
	});

	it('a question arriving mid-cut is blocked (bar) and unblocks once the cut is saved', async () => {
		const { store } = make(asking());
		store.setRecordingPhase('recording');
		store.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(store.state.run?.question).toBeDefined();
		expect(store.state.minimised).toBe(false);
		expect(store.runBlocked.value).toBe(true);
		store.setRecordingPhase('finalizing');
		expect(store.runBlocked.value).toBe(true);
		store.setRecordingPhase(null);
		saveDialogOpen.value = true; // the Save dialog is up, the phase is already null
		expect(store.runBlocked.value).toBe(true);
		saveDialogOpen.value = false;
		expect(store.runBlocked.value).toBe(false);
		store.stop();
	});

	it('re-reads the pending list the moment a cut ends, so a stale busy flag does not hold the dialog back', async () => {
		let busy = true;
		const api = fakeApi({ getPending: vi.fn(async () => pend([req(1)], { busy })) });
		const { store } = make(api);
		store.setRecordingPhase('recording');
		store.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(store.mode.value).toBe('badge');
		busy = false;
		store.setRecordingPhase(null);
		await vi.advanceTimersByTimeAsync(0);
		expect(api.getPending).toHaveBeenCalledTimes(2);
		expect(store.mode.value).toBe('dialog');
		store.stop();
	});

	it('re-reads the pending list when the Save dialog closes', async () => {
		const api = fakeApi({ getPending: vi.fn(async () => pend([req(1)])) });
		const { store } = make(api);
		store.start();
		await vi.advanceTimersByTimeAsync(0);
		saveDialogOpen.value = true;
		await vi.advanceTimersByTimeAsync(0);
		expect(api.getPending).toHaveBeenCalledTimes(1);
		saveDialogOpen.value = false;
		await vi.advanceTimersByTimeAsync(0);
		expect(api.getPending).toHaveBeenCalledTimes(2);
		store.stop();
	});

	it('Show overrides the block (the operator asked), Minimise takes it back, a new question blocks again', async () => {
		const { store } = make(asking());
		store.setRecordingPhase('recording');
		store.restore();
		expect(store.runBlocked.value).toBe(false);
		store.minimise();
		expect(store.runBlocked.value).toBe(true);
		store.restore();
		store.start();
		await vi.advanceTimersByTimeAsync(0); // the first question of the run arrives
		expect(store.runBlocked.value).toBe(true);
		store.stop();
	});
});

describe('prompt mode from the store', () => {
	it('is a dialog when idle and a badge while recording', async () => {
		const { store } = make(fakeApi({ getPending: vi.fn(async () => pend([req(1)])) }));
		store.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(store.mode.value).toBe('dialog');
		store.setRecordingPhase('recording');
		expect(store.mode.value).toBe('badge');
		store.setRecordingPhase('finalizing');
		expect(store.mode.value).toBe('badge');
		store.setRecordingPhase(null);
		expect(store.mode.value).toBe('dialog');
		store.stop();
	});
	it('offers the oldest request first', async () => {
		const { store } = make(fakeApi({ getPending: vi.fn(async () => pend([req(4), req(9)])) }));
		store.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(store.head.value?.number).toBe(4);
		store.stop();
	});
});

describe('notifications', () => {
	it('tells the desktop shell about a new request once, and again when a snoozed one returns', async () => {
		const api = fakeApi({ getPending: vi.fn(async () => pend([req(1)])) });
		const { store, notify } = make(api);
		store.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toMatch(/dpremoli/);
		await vi.advanceTimersByTimeAsync(PENDING_POLL_MS);
		expect(notify).toHaveBeenCalledTimes(1);
		api.getPending.mockResolvedValueOnce(pend([]));
		await vi.advanceTimersByTimeAsync(PENDING_POLL_MS);
		await vi.advanceTimersByTimeAsync(PENDING_POLL_MS);
		expect(notify).toHaveBeenCalledTimes(2);
		store.stop();
	});
	it('a notify that throws does not break polling', async () => {
		const api = fakeApi({ getPending: vi.fn(async () => pend([req(1)])) });
		const store = createRigTestStore({ api, notify: () => { throw new Error('no bridge'); }, now: () => Date.now(), acceptContext: async () => ({ uploadBusy: false }) });
		store.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(store.state.pending).toHaveLength(1);
		store.stop();
	});
});

describe('Run now', () => {
	it('sends upload_busy, clears the request and picks up the run, polling for it for a few seconds', async () => {
		const pending = [req(1)];
		let runs: RigRun | null = null;
		const api = fakeApi({
			getPending: vi.fn(async () => pend([...pending])),
			getRun: vi.fn(async () => ok(runs)),
			accept: vi.fn(async () => { pending.length = 0; return ok({ ok: true }); }),
		});
		const store = createRigTestStore({
			api, notify: vi.fn(), now: () => Date.now(),
			acceptContext: async () => ({ uploadBusy: true, operator: 'Ada Lovelace', appVersion: '0.1.37' }),
		});
		store.setRecordingPhase(null);
		store.start();
		await vi.advanceTimersByTimeAsync(0);
		await store.accept(1);
		expect(api.accept).toHaveBeenCalledWith(1, { uploadBusy: true, operator: 'Ada Lovelace', appVersion: '0.1.37' });
		expect(store.state.pending).toEqual([]);
		// The recorder takes a moment to publish the run: the store keeps asking instead of waiting 30 s.
		runs = runOf();
		await vi.advanceTimersByTimeAsync(RUN_POLL_MS);
		expect(store.runActive.value).toBe(true);
		expect(store.mode.value).toBe('none');
		store.stop();
	});

	it('shows a 409 detail on that request and leaves it pending', async () => {
		const api = fakeApi({
			getPending: vi.fn(async () => pend([req(1)])),
			accept: vi.fn(async () => ({ kind: 'error', status: 409, detail: 'a recording is in progress' }) as ApiResult<unknown>),
		});
		const { store } = make(api);
		store.start();
		await vi.advanceTimersByTimeAsync(0);
		await store.accept(1);
		expect(store.state.errors[1]).toBe('a recording is in progress');
		expect(store.state.pending).toHaveLength(1);
		expect(store.state.busy[1]).toBeUndefined();
		// A later attempt clears the old message.
		api.accept.mockResolvedValueOnce(ok({ ok: true }));
		await store.accept(1);
		expect(store.state.errors[1]).toBeUndefined();
		store.stop();
	});

	it('ignores a second click while the first is in flight', async () => {
		let release!: (v: ApiResult<unknown>) => void;
		const api = fakeApi({ accept: vi.fn(() => new Promise((r) => { release = r; })) });
		const { store } = make(api);
		store.start();
		const first = store.accept(1);
		await store.accept(1);
		expect(api.accept).toHaveBeenCalledTimes(1);
		release(ok({ ok: true }));
		await first;
		store.stop();
	});
});

describe('snooze and decline', () => {
	it('snooze sends the computed until and refreshes the list', async () => {
		const { api, store } = make(fakeApi({ getPending: vi.fn(async () => pend([req(1)])) }));
		store.start();
		await vi.advanceTimersByTimeAsync(0);
		await store.snooze(1, { kind: 'minutes', minutes: 30 });
		expect(api.snooze).toHaveBeenCalledWith(1, '2026-10-11T12:30:00.000Z');
		expect(api.getPending).toHaveBeenCalledTimes(2);
		store.stop();
	});
	it('a bad time of day never reaches the backend', async () => {
		const { api, store } = make();
		await store.snooze(1, { kind: 'time', hhmm: 'noon' });
		expect(api.snooze).not.toHaveBeenCalled();
		expect(store.state.errors[1]).toBeTruthy();
	});
	it('decline sends the contract body; "other" without text is held back', async () => {
		const { api, store } = make();
		await store.decline(1, 'other', ' ');
		expect(api.decline).not.toHaveBeenCalled();
		await store.decline(1, 'machine_in_use', '');
		expect(api.decline).toHaveBeenCalledWith(1, { reason_code: 'machine_in_use' });
	});
});

describe('a run in progress', () => {
	it('pops the modal back up for a new question, announces it, and keeps a deliberately minimised one down', async () => {
		let current: RigRun = runOf();
		const api = fakeApi({ getRun: vi.fn(async () => ok(current)) });
		const { store, notify } = make(api);
		store.start();
		await vi.advanceTimersByTimeAsync(0);
		store.minimise();
		await vi.advanceTimersByTimeAsync(RUN_POLL_MS);
		expect(store.state.minimised).toBe(true);
		current = runOf({ question: q });
		await vi.advanceTimersByTimeAsync(RUN_POLL_MS);
		expect(store.state.minimised).toBe(false);
		expect(notify).toHaveBeenCalledWith('Rig test #1 needs you', 'Did the chip warn?');
		// Minimise with the question still open: it stays down and does not re-announce.
		notify.mockClear();
		store.minimise();
		await vi.advanceTimersByTimeAsync(RUN_POLL_MS * 3);
		expect(store.state.minimised).toBe(true);
		expect(notify).not.toHaveBeenCalled();
		store.stop();
	});

	it('keeps the finished run on screen until closed, then not again', async () => {
		let current: RigRun = runOf();
		const api = fakeApi({ getRun: vi.fn(async () => ok(current)) });
		const { store } = make(api);
		store.start();
		await vi.advanceTimersByTimeAsync(0);
		current = runOf({ state: 'done' });
		await vi.advanceTimersByTimeAsync(RUN_POLL_MS);
		expect(store.state.finished?.state).toBe('done');
		store.closeFinished();
		await vi.advanceTimersByTimeAsync(PENDING_POLL_MS);
		expect(store.state.finished).toBeNull();
		store.stop();
	});

	it('a run that was already over when the app opened is not replayed', async () => {
		const { store } = make(fakeApi({ getRun: vi.fn(async () => ok(runOf({ state: 'partial' }))) }));
		store.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(store.state.finished).toBeNull();
		store.stop();
	});

	it('answer sends the note only when there is one, and shows a refusal', async () => {
		const { api, store } = make();
		await store.answer(2, 'Yes', '  saw it ');
		expect(api.answer).toHaveBeenCalledWith(2, 'Yes', 'saw it');
		await store.answer(2, 'No', '   ');
		expect(api.answer).toHaveBeenLastCalledWith(2, 'No', undefined);
		api.answer.mockResolvedValueOnce({ kind: 'error', status: 409, detail: 'that step is no longer waiting' });
		await store.answer(2, 'Yes', '');
		expect(store.state.answerError).toBe('that step is no longer waiting');
		expect(store.state.answering).toBe(false);
	});

	it('cancel asks the backend and re-reads the run', async () => {
		const { api, store } = make();
		store.start();
		await vi.advanceTimersByTimeAsync(0);
		await store.cancel();
		expect(api.cancelRun).toHaveBeenCalledTimes(1);
		expect(api.getRun).toHaveBeenCalledTimes(2);
		store.stop();
	});
});
