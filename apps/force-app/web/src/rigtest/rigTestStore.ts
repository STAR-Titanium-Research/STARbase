// Shared state and polling for the rig-test UI. Mounted once by RigTestHost (AppShell), read by
// the prompt, the run modal, the bottom bar, the sidebar badge and Settings > Rig tests.
//
// Polling (the contract has no websocket in phase 1): pending requests every 30 s, the run every
// 1 s for as long as one is active. Both stop when the host unmounts. A backend without the
// routes (404) just shows nothing; a failed poll keeps what the UI already had.
//
// It also lends the operator's D1 sign-in to the recorder (rigTestSession.ts) on every pending poll.
//
// It is a factory so the tests can drive it with a fake api and fake timers; `rigTest` at the
// bottom is the app's one real instance.
import { computed, reactive, watch } from 'vue';
import { authStore } from '../authStore';
import { currentAcceptContext } from './acceptContext';
import { rigTestApi, type ApiResult, type RigTestApi } from './rigTestApi';
import { createSessionSync, type SessionSync } from './rigTestSession';
import { saveDialogOpen } from './saveDialogOpen';
import {
	justFinished, newRequests, promptMode, rigBlocked, questionKey, questionNotification, requestNotification,
	shouldReopen, snoozeUntil, declineBody,
	type AcceptContext, type DeclineCode, type Eligibility, type PendingList, type PhaseState, type RigRequest, type RigRun, type RunSummary,
	type SnoozeChoice, type SnoozedRequest,
} from './rigTestLogic';

export const PENDING_POLL_MS = 30_000;
export const RUN_POLL_MS = 1_000;
/** After Run now, keep asking for the run this long even if it hasn't appeared yet. */
export const RUN_APPEAR_GRACE_MS = 10_000;

export type Notify = (title: string, body: string) => void;
export interface RigTestDeps {
	api: RigTestApi; notify: Notify; now: () => number;
	/** Read at the moment of accepting: the upload state, the signed-in operator, the app version. */
	acceptContext: () => Promise<AcceptContext>;
	/** Lends the D1 token to the recorder (rigTestSession.ts). Absent in most tests. */
	session?: SessionSync;
	/** Calls back when the sign-in changes (token, offline); returns the unwatch. */
	onAuthChange?: (cb: () => void) => () => void;
}

const NO_ROUTES = 'This recorder is too old for rig tests';

export function createRigTestStore(deps: RigTestDeps) {
	const { api, notify } = deps;
	const state = reactive({
		/** false once the backend answers 404: an older recorder with no rig-test routes. */
		available: true,
		pending: [] as RigRequest[],
		/** Requests the operator snoozed, with when they come back (Settings > Rig tests). */
		snoozed: [] as SnoozedRequest[],
		/** The backend says it is recording, saving or recovering (GET /pending `busy`). */
		backendBusy: false,
		run: null as RigRun | null,
		/** The run that just ended, shown as a summary until the operator closes it. */
		finished: null as RigRun | null,
		minimised: false,
		/** From the shell's /record/status poll; 'unknown' until its first answer. */
		recordingPhase: 'unknown' as PhaseState,
		/** The operator pressed Show/Run now: the modal may open even while a cut is in progress. */
		forced: false,
		eligibility: null as Eligibility | null,
		history: [] as RunSummary[],
		/** Per request: what the last Run now / Snooze / Decline was refused with. */
		errors: {} as Record<number, string>,
		busy: {} as Record<number, 'accept' | 'snooze' | 'decline'>,
		answering: false,
		answerError: '',
		cancelError: '',
		/** Title and link of requests seen in the pending list, for the run modal's heading. */
		known: {} as Record<number, { title: string; url: string }>,
	});

	const runActive = computed(() => state.run?.state === 'running');
	const blockInputs = () => ({ phase: state.recordingPhase, saveDialogOpen: saveDialogOpen.value });
	/** A cut is being recorded or saved (or we can't tell yet): nothing may pop over the page. */
	const blocked = computed(() => rigBlocked({ ...blockInputs(), backendBusy: state.backendBusy }));
	const mode = computed(() => promptMode(state.pending.length, runActive.value, blocked.value));
	/** The run modal's version: the backend's flag is left out (it may mean "a run is going"), and
	 *  Show / Run now override it, because the operator asked for the modal. */
	const runBlocked = computed(() => rigBlocked(blockInputs()) && !state.forced);
	/** The request the dialog offers: oldest first, one at a time. */
	const head = computed(() => state.pending[0] ?? null);

	let stopped = true;
	let pendingTimer: ReturnType<typeof setInterval> | null = null;
	let unwatchSave: (() => void) | null = null;
	let unwatchAuth: (() => void) | null = null;
	let runTimer: ReturnType<typeof setTimeout> | null = null;
	let runBusy = false;
	let expectRunUntil = 0;
	let pendingBusy = false;
	const seen = new Set<number>();

	function safeNotify(n: { title: string; body: string } | null): void {
		if (!n) return;
		try { notify(n.title, n.body); } catch { /* no bridge, or the shell refused: the prompt is on screen anyway */ }
	}

	function applyPending(p: PendingList, askedAt?: number): void {
		for (const r of newRequests(seen, p.requests)) safeNotify(requestNotification(r));
		seen.clear();
		for (const r of p.requests) seen.add(r.number);
		for (const r of [...p.requests, ...p.snoozed]) state.known[r.number] = { title: r.title, url: r.url };
		state.pending = p.requests;
		state.snoozed = p.snoozed;
		state.backendBusy = p.busy;
		void deps.session?.sync({ session: p.session, hardwareOk: p.hardwareOk, relay: p.relay, askedAt });
	}

	function applyRun(next: RigRun | null): void {
		const prev = state.run;
		if (justFinished(prev, next)) state.finished = next;
		if (next?.state === 'running' && (!prev || prev.number !== next.number)) state.finished = null;
		if (shouldReopen(prev, next)) state.minimised = false;
		const k = questionKey(next);
		if (k && k !== questionKey(prev) && next) {
			state.forced = false; // a new question waits for the cut to be saved
			safeNotify(questionNotification(next));
		}
		state.run = next;
	}

	async function refreshPending(): Promise<void> {
		if (stopped || pendingBusy) return;
		pendingBusy = true;
		try {
			const askedAt = deps.session?.stamp(); // taken before the request leaves (see SessionView.askedAt)
			const r = await api.getPending();
			if (stopped) return;
			if (r.kind === 'ok') { state.available = true; applyPending(r.data, askedAt); }
			else if (r.kind === 'missing') { state.available = false; applyPending({ requests: [], snoozed: [], busy: false, session: false, hardwareOk: null, relay: 'not_configured' }, askedAt); }
		} finally { pendingBusy = false; }
	}

	async function refreshRun(): Promise<void> {
		if (stopped) return;
		if (runTimer) { clearTimeout(runTimer); runTimer = null; }
		if (runBusy) return;
		runBusy = true;
		try {
			const r = await api.getRun();
			if (stopped) return;
			if (r.kind === 'ok') applyRun(r.data);
			else if (r.kind === 'missing') applyRun(null);
		} finally { runBusy = false; }
		if (!stopped && (state.run?.state === 'running' || deps.now() < expectRunUntil)) {
			runTimer = setTimeout(() => { void refreshRun(); }, RUN_POLL_MS);
		}
	}

	const refreshAll = () => Promise.all([refreshPending(), refreshRun()]).then(() => undefined);

	/** Begin polling; returns the function that stops it (the host's unmount). */
	function start(): () => void {
		stopped = false;
		void refreshAll();
		pendingTimer = setInterval(() => { void refreshAll(); }, PENDING_POLL_MS);
		// The Save dialog closing ends a cut: re-read now, so `busy` (up to 30 s old) doesn't keep a
		// waiting request a badge after the operator has finished.
		unwatchSave = watch(saveDialogOpen, (open) => { if (!open) void refreshPending(); });
		unwatchAuth = deps.onAuthChange?.(() => { void refreshPending(); }) ?? null;
		return stop;
	}
	function stop(): void {
		stopped = true;
		unwatchSave?.(); unwatchSave = null;
		unwatchAuth?.(); unwatchAuth = null;
		void deps.session?.release();
		if (pendingTimer) { clearInterval(pendingTimer); pendingTimer = null; }
		if (runTimer) { clearTimeout(runTimer); runTimer = null; }
	}

	function refused(r: ApiResult<unknown>): string {
		return r.kind === 'error' ? r.detail : r.kind === 'missing' ? NO_ROUTES : '';
	}

	/** Shared shape of Run now / Snooze / Decline: mark busy, clear the old error, show a refusal
	 *  inline, and re-read the list on success. */
	async function act(n: number, what: 'accept' | 'snooze' | 'decline', send: () => Promise<ApiResult<unknown>>): Promise<boolean> {
		if (state.busy[n]) return false;
		state.busy[n] = what;
		delete state.errors[n];
		try {
			const r = await send();
			if (r.kind !== 'ok') { state.errors[n] = refused(r); return false; }
			return true;
		} finally { delete state.busy[n]; }
	}

	async function accept(n: number): Promise<void> {
		if (!(await act(n, 'accept', async () => api.accept(n, await deps.acceptContext())))) return;
		state.minimised = false;
		state.forced = true;
		expectRunUntil = deps.now() + RUN_APPEAR_GRACE_MS;
		await refreshAll();
	}

	async function snooze(n: number, choice: SnoozeChoice): Promise<void> {
		const until = snoozeUntil(choice, new Date(deps.now()));
		if (!until) { state.errors[n] = 'Enter a time such as 17:00'; return; }
		if (await act(n, 'snooze', () => api.snooze(n, until))) await refreshPending();
	}

	async function decline(n: number, code: DeclineCode | null, text: string): Promise<void> {
		const body = declineBody(code, text);
		if (!body) { state.errors[n] = 'Say why (a few words)'; return; }
		if (await act(n, 'decline', () => api.decline(n, body))) await refreshPending();
	}

	async function answer(step: number, option: string, note: string): Promise<void> {
		if (state.answering) return;
		state.answering = true;
		state.answerError = '';
		try {
			const r = await api.answer(step, option, note.trim() || undefined);
			if (r.kind !== 'ok') state.answerError = refused(r);
		} finally { state.answering = false; }
		await refreshRun();
	}

	async function cancel(): Promise<void> {
		state.cancelError = '';
		const r = await api.cancelRun();
		if (r.kind !== 'ok') state.cancelError = refused(r);
		await refreshRun();
	}

	async function refreshEligibility(): Promise<void> {
		const r = await api.getEligibility();
		if (r.kind === 'ok') state.eligibility = r.data;
		else if (r.kind === 'missing') state.eligibility = null;
	}

	async function refreshHistory(): Promise<void> {
		const r = await api.getHistory();
		if (r.kind === 'ok') state.history = r.data;
	}

	return {
		state, runActive, mode, head, runBlocked,
		start, stop, refreshPending, refreshRun, refreshAll, refreshEligibility, refreshHistory,
		accept, snooze, decline, answer, cancel,
		setRecordingPhase(p: PhaseState) {
			const was = state.recordingPhase;
			state.recordingPhase = p;
			// A cut just ended: ask now whether the recorder is still busy (see the Save dialog watch).
			if (p === null && (was === 'recording' || was === 'finalizing')) void refreshPending();
		},
		minimise() { state.minimised = true; state.forced = false; },
		restore() { state.minimised = false; state.forced = true; },
		closeFinished() { state.finished = null; },
	};
}

function desktopNotify(title: string, body: string): void {
	// Only the Electron shell has the bridge; the browser build has no window.forceApp.
	void window.forceApp?.notify?.(title, body)?.catch?.(() => {});
}

/** Lends this window's D1 sign-in to the recorder. Only the main window mounts RigTestHost, so
 *  only it ever sends the token. */
const sessionSync = createSessionSync({
	api: rigTestApi,
	auth: {
		online: () => !authStore.state.offline && !!authStore.state.accessToken,
		accessToken: () => authStore.state.accessToken,
		expiresAt: () => authStore.state.expiresAt,
		refresh: () => authStore.refresh(),
	},
	now: () => Date.now(),
});

/** The app's one store. */
export const rigTest = createRigTestStore({
	api: rigTestApi, notify: desktopNotify, now: () => Date.now(), acceptContext: currentAcceptContext,
	session: sessionSync,
	onAuthChange: (cb) => watch(() => [authStore.state.accessToken, authStore.state.offline], cb),
});
