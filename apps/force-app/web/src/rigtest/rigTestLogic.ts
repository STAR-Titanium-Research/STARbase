// Every decision the rig-test UI makes, as plain functions (no Vue, no fetch, no clock reads), so
// they can be unit-tested. The store (rigTestStore.ts) feeds them state; the components only render
// what they return. The wire types mirror the REST contract in
// docs/superpowers/plans/2026-10-11-rig-test-requests-phase1.md ("Contract between B and C").

// ---- wire types -------------------------------------------------------------------------------

export type StepKind = 'ask' | 'note';

export interface RigStep {
	index: number;
	item_id: string;
	kind: StepKind;
	text: string;
	options?: string[];
	pass?: string[];
	est_s: number;
	after?: number;
}

export interface RigItem { id: string; title: string; steps: RigStep[] }

export interface RigRequest {
	number: number;
	title: string;
	url: string;
	requested_by: string;
	created_at: string;
	items: RigItem[];
	estimate_s: { full: number; automated: number };
	needs_operator_steps: number;
	error?: string;
}

export type RunState = 'running' | 'done' | 'partial' | 'cancelled' | 'timed_out';
export type StepStatus =
	| 'pending' | 'active' | 'pass' | 'fail' | 'no_response' | 'skipped_dependency' | 'cancelled' | 'error';

export interface RunStep {
	index: number;
	item_id: string;
	kind: StepKind;
	text: string;
	status: StepStatus;
	answer?: string;
	note?: string;
}

export interface RunQuestion { step: number; text: string; options: string[]; expires_at: string }

export interface RigRun {
	number: number;
	/** The request's title and issue link; '' from a backend that doesn't send them yet. */
	title: string;
	url: string;
	state: RunState;
	started_at: string;
	deadline_at: string;
	elapsed_s: number;
	estimate_s: number;
	steps: RunStep[];
	current?: number;
	question?: RunQuestion;
}

/** One row of GET /rig-tests/history. The contract names `RunSummary` without spelling it out, so
 *  everything but `number` and `state` is optional and read defensively (see summaryCounts). */
export interface RunSummary {
	number: number;
	state: string;
	title?: string;
	url?: string;
	started_at?: string;
	finished_at?: string;
	counts?: Record<string, number>;
	items?: { id?: string; result?: string }[];
	steps?: { status?: string }[];
}

/** A snoozed request: `snoozed_until` is an ISO 8601 instant, or "after_recording". */
export interface SnoozedRequest extends RigRequest { snoozed_until: string }

/** GET /rig-tests/pending. `busy`: the recorder is recording, saving or recovering a capture. */
export interface PendingList { requests: RigRequest[]; snoozed: SnoozedRequest[]; busy: boolean }

export type RelayState = 'ok' | 'unreachable' | 'not_configured' | 'unknown' | 'token_rejected';

export interface Eligibility {
	eligible: boolean;
	rig_id: string;
	reason?: string;
	relay: RelayState;
}

// ---- parsing (the backend may be an older or newer build than this UI expects) -----------------

const RUN_STATES: RunState[] = ['running', 'done', 'partial', 'cancelled', 'timed_out'];
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);

/** The run from GET /rig-tests/run, or null for `{state: "idle"}` and for anything unrecognised. */
export function parseRun(raw: unknown): RigRun | null {
	const r = raw as Record<string, any> | null;
	if (!r || typeof r !== 'object' || !RUN_STATES.includes(r.state)) return null;
	const steps: RunStep[] = Array.isArray(r.steps)
		? r.steps.map((s: any, i: number) => ({
			index: num(s?.index, i), item_id: str(s?.item_id), kind: s?.kind === 'note' ? 'note' : 'ask',
			text: str(s?.text), status: str(s?.status, 'pending') as StepStatus,
			answer: typeof s?.answer === 'string' ? s.answer : undefined,
			note: typeof s?.note === 'string' ? s.note : undefined,
		}))
		: [];
	const q = r.question;
	const question: RunQuestion | undefined = q && typeof q === 'object' && typeof q.expires_at === 'string'
		? {
			step: num(q.step), text: str(q.text),
			options: Array.isArray(q.options) ? q.options.filter((o: unknown): o is string => typeof o === 'string') : [],
			expires_at: q.expires_at,
		}
		: undefined;
	return {
		number: num(r.number), title: str(r.title), url: str(r.url), state: r.state, started_at: str(r.started_at), deadline_at: str(r.deadline_at),
		elapsed_s: num(r.elapsed_s), estimate_s: num(r.estimate_s), steps,
		current: typeof r.current === 'number' ? r.current : undefined, question,
	};
}

function parseRequestList(list: unknown): RigRequest[] {
	if (!Array.isArray(list)) return [];
	return list.filter((x) => x && typeof x.number === 'number').map((x: any) => ({
		number: x.number, title: str(x.title, `Request #${x.number}`), url: str(x.url),
		requested_by: str(x.requested_by), created_at: str(x.created_at),
		items: Array.isArray(x.items)
			? x.items.map((i: any) => ({ id: str(i?.id), title: str(i?.title), steps: Array.isArray(i?.steps) ? i.steps : [] }))
			: [],
		estimate_s: { full: num(x.estimate_s?.full), automated: num(x.estimate_s?.automated) },
		needs_operator_steps: num(x.needs_operator_steps),
		error: typeof x.error === 'string' && x.error ? x.error : undefined,
	}));
}

export function parseRequests(raw: unknown): RigRequest[] {
	return parseRequestList((raw as { requests?: unknown })?.requests);
}

/** GET /rig-tests/pending. An older backend sends only `requests`: no snoozed list, not busy. */
export function parsePending(raw: unknown): PendingList {
	const r = (raw ?? {}) as { requests?: unknown; snoozed?: unknown; busy?: unknown };
	const rawSnoozed = (Array.isArray(r.snoozed) ? r.snoozed : []).filter((x) => x && typeof x.number === 'number');
	const snoozed = parseRequestList(rawSnoozed).map((x, i) => ({ ...x, snoozed_until: str(rawSnoozed[i].snoozed_until) }));
	return { requests: parseRequests(raw), snoozed, busy: r.busy === true };
}

export function parseHistory(raw: unknown): RunSummary[] {
	const list = (raw as { runs?: unknown })?.runs;
	return Array.isArray(list)
		? list.filter((x) => x && typeof x.number === 'number').map((x) => ({ ...x, state: str(x.state, 'unknown') }))
		: [];
}

// ---- prompt: dialog or badge -------------------------------------------------------------------

/** Recording phases from the shell's /record/status poll (recordingBanner.ts); null = not recording. */
export type RecordingPhase = 'recording' | 'finalizing' | null;
/** The same, plus 'unknown' until the shell's first status answer arrives. */
export type PhaseState = RecordingPhase | 'unknown';
export type PromptMode = 'none' | 'dialog' | 'badge';

export interface BlockInputs {
	phase: PhaseState;
	/** The recording Save dialog is open (the cut is over but the operator hasn't decided yet). */
	saveDialogOpen: boolean;
	/** GET /pending `busy`: the recorder itself says it is recording, saving or recovering. */
	backendBusy?: boolean;
}

/** Whether anything that would pop over the page must hold back: a cut is being recorded or saved,
 *  the Save dialog is open, the backend says it is busy, or we don't know yet (the shell has not
 *  answered, e.g. right after a reload). Unknown counts as busy: a missed prompt shows as a badge
 *  a moment later, a prompt over a live cut costs the operator the cut. */
export function rigBlocked(b: BlockInputs): boolean {
	return b.phase !== null || b.saveDialogOpen || !!b.backendBusy;
}

/** What the "your admin has requested tests" prompt looks like right now.
 *  - Nothing pending, or a run already going: nothing (the run modal is the whole story).
 *  - Blocked (see rigBlocked): only a badge. A dialog must never cover the Record page mid-cut, nor
 *    take focus from the Save dialog.
 *  - Otherwise: the dialog, one request at a time. */
export function promptMode(pendingCount: number, runActive: boolean, blocked: boolean): PromptMode {
	if (pendingCount <= 0 || runActive) return 'none';
	return blocked ? 'badge' : 'dialog';
}

// ---- text --------------------------------------------------------------------------------------

/** "12 min" for most runs, "1 h 35 min" past 90 minutes. Never "0 min". */
export function formatApproxDuration(seconds: number): string {
	const mins = Math.max(1, Math.round(seconds / 60));
	if (mins <= 90) return `${mins} min`;
	const h = Math.floor(mins / 60);
	const m = mins % 60;
	return m ? `${h} h ${m} min` : `${h} h`;
}

/** "about 12 min, 3 steps need you" (or "about 4 min, nothing needed from you"). */
export function estimateText(estimateSeconds: number, operatorSteps: number): string {
	const when = `about ${formatApproxDuration(estimateSeconds)}`;
	if (operatorSteps <= 0) return `${when}, nothing needed from you`;
	return `${when}, ${operatorSteps} ${operatorSteps === 1 ? 'step needs' : 'steps need'} you`;
}

/** A request or run time for display; '' when it doesn't parse. */
export function formatWhen(iso: string | undefined): string {
	const t = iso ? Date.parse(iso) : NaN;
	return Number.isFinite(t) ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

/** m:ss, for the answer countdown. */
export function formatClock(totalSeconds: number): string {
	const s = Math.max(0, Math.floor(totalSeconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Whole seconds until `expiresAt` (ISO 8601), never negative; 0 for an unparsable time. */
export function secondsLeft(expiresAt: string, nowMs: number): number {
	const t = Date.parse(expiresAt);
	return Number.isFinite(t) ? Math.max(0, Math.ceil((t - nowMs) / 1000)) : 0;
}

// ---- run progress ------------------------------------------------------------------------------

const OPEN_STATUSES: StepStatus[] = ['pending', 'active'];

export function stepsDone(run: RigRun): number {
	return run.steps.filter((s) => !OPEN_STATUSES.includes(s.status)).length;
}

export interface Progress { done: number; total: number; stepFraction: number; timeFraction: number }

/** Both bars of the modal: steps settled / total, and elapsed / estimate (capped at 1: a run that
 *  overruns its estimate shows a full bar, not an overflowing one). */
export function progress(run: RigRun): Progress {
	const total = run.steps.length;
	const done = stepsDone(run);
	return {
		done, total,
		stepFraction: total ? done / total : 0,
		timeFraction: run.estimate_s > 0 ? Math.min(1, Math.max(0, run.elapsed_s / run.estimate_s)) : 0,
	};
}

/** 1-based position of the step being worked on (the first unsettled one when `current` is unset). */
export function currentPosition(run: RigRun): number {
	if (run.current !== undefined) {
		const at = run.steps.findIndex((s) => s.index === run.current);
		if (at >= 0) return at + 1;
	}
	const open = run.steps.findIndex((s) => OPEN_STATUSES.includes(s.status));
	return open >= 0 ? open + 1 : run.steps.length;
}

/** "about 6 min", "under a minute" once the estimate is (nearly) spent. */
export function timeLeft(run: RigRun): string {
	const left = run.estimate_s - run.elapsed_s;
	return left <= 30 ? 'under a minute' : `about ${Math.max(1, Math.round(left / 60))} min`;
}

/** The minimised bar: "Rig test #231, step 4/9, about 6 min left". */
export function minimisedText(run: RigRun): string {
	return `Rig test #${run.number}, step ${currentPosition(run)}/${run.steps.length}, ${timeLeft(run)} left`;
}

export interface StepMark { icon: string; label: string; tone: 'ok' | 'bad' | 'dim' | 'active' | 'warn' }

/** The ✓ ✗ – mark beside each step in the list. Icons are Material Symbols names. */
export function stepMark(status: StepStatus): StepMark {
	switch (status) {
		case 'pass': return { icon: 'check_circle', label: 'passed', tone: 'ok' };
		case 'fail': return { icon: 'cancel', label: 'failed', tone: 'bad' };
		case 'error': return { icon: 'error', label: 'error', tone: 'bad' };
		case 'no_response': return { icon: 'timer_off', label: 'no response', tone: 'warn' };
		case 'skipped_dependency': return { icon: 'remove_circle_outline', label: 'skipped', tone: 'dim' };
		case 'cancelled': return { icon: 'block', label: 'cancelled', tone: 'dim' };
		case 'active': return { icon: 'play_circle', label: 'in progress', tone: 'active' };
		default: return { icon: 'radio_button_unchecked', label: 'waiting', tone: 'dim' };
	}
}

// ---- POST /accept --------------------------------------------------------------------------------

/** What the recorder is told when the operator accepts: whether an upload is running (it
 *  contends with a test for the machine and the network), who accepted, and which app build. */
export interface AcceptContext { uploadBusy: boolean; operator?: string; appVersion?: string }

/** An upload is busy if the run-record queue is flushing or any capture file is going up. */
export function isUploadBusy(syncing: boolean, filesInFlight: number): boolean {
	return syncing || filesInFlight > 0;
}

/** The signed-in user's initials ("Ada Lovelace" -> "A.L.") for the result that is posted on the
 *  GitHub issue. The repository is public, so neither the full name nor the email goes there.
 *  Undefined when there is no name. (The recorder reduces whatever it gets to initials as well.) */
export function operatorInitials(user: { first_name?: string | null; last_name?: string | null } | null | undefined): string | undefined {
	const initials = [user?.first_name, user?.last_name]
		.map((x) => Array.from((x ?? '').trim()).find((ch) => /\p{L}/u.test(ch)))
		.filter((ch): ch is string => !!ch)
		.map((ch) => `${ch.toUpperCase()}.`)
		.join('');
	return initials || undefined;
}

/** The desktop shell's version; the version bundled into this build when there is no shell (the
 *  browser-served app); undefined when neither is known. */
export function appVersionOf(shellVersion: string | undefined, bundledVersion: string | undefined): string | undefined {
	return shellVersion?.trim() || bundledVersion?.trim() || undefined;
}

/** The body of POST /accept: the optional fields are left out, not sent empty. */
export function acceptBody(ctx: AcceptContext): { mode: 'full'; upload_busy: boolean; operator?: string; app_version?: string } {
	return {
		mode: 'full', upload_busy: ctx.uploadBusy,
		...(ctx.operator ? { operator: ctx.operator } : {}),
		...(ctx.appVersion ? { app_version: ctx.appVersion } : {}),
	};
}

// ---- Settings > Rig tests ----------------------------------------------------------------------

/** `u` as a link target only if it is an http(s) URL, else '' (a `javascript:` or `data:` URL from
 *  a request or a result file must never reach an `href`). */
export function httpUrl(u: unknown): string {
	if (typeof u !== 'string') return '';
	try {
		const p = new URL(u);
		return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : '';
	} catch {
		return '';
	}
}

export interface RelayInfo { text: string; tone: 'ok' | 'bad' | 'dim'; icon: string }

/** How Settings shows the relay. "unknown" is a backend that hasn't asked the relay yet (just
 *  started), which must not read as "reachable". */
export function relayInfo(relay: RelayState | undefined): RelayInfo {
	switch (relay) {
		case 'ok': return { text: 'Request relay reachable', tone: 'ok', icon: 'cloud_done' };
		case 'unreachable': return { text: 'Request relay unreachable: new requests cannot arrive', tone: 'bad', icon: 'cloud_off' };
		case 'unknown': return { text: 'Request relay not checked yet', tone: 'dim', icon: 'cloud_sync' };
		case 'token_rejected': return { text: 'The relay rejected this PC\'s rig token: it must match the one set on the server', tone: 'bad', icon: 'key_off' };
		default: return { text: 'Request relay not configured on this PC', tone: 'dim', icon: 'cloud_off' };
	}
}

/** "until Oct 11, 5:00 PM", or "until the next recording is saved" for an after-recording snooze. */
export function snoozedUntilText(until: string): string {
	if (until === 'after_recording') return 'Snoozed until the next recording is saved';
	const when = formatWhen(until);
	return when ? `Snoozed until ${when}` : 'Snoozed';
}

// ---- run modal vs. bar -------------------------------------------------------------------------

export type RunView = 'none' | 'modal' | 'bar';

/** A finished run is shown once (as a summary in the modal) until closed. While running, the modal
 *  or, when the operator minimised it, the bar. When blocked (see rigBlocked) the modal holds back
 *  the same way the prompt does: a running test shows as the bar only, a finished summary waits. */
export function runView(run: RigRun | null, minimised: boolean, hasFinished: boolean, blocked = false): RunView {
	if (hasFinished) return blocked ? 'none' : 'modal';
	if (!run || run.state !== 'running') return 'none';
	return minimised || blocked ? 'bar' : 'modal';
}

/** The tag on the bar when a question is open. */
export function barAskText(blocked: boolean): string {
	return blocked ? 'Waiting for you \u2014 after this cut' : 'Waiting for you';
}

/** Identity of the open question, so the modal reopens once per question rather than on every poll. */
export function questionKey(run: RigRun | null): string | null {
	return run?.state === 'running' && run.question ? `${run.number}:${run.question.step}` : null;
}

/** Whether the modal should pop back up: a different run started, or a new question appeared. */
export function shouldReopen(prev: RigRun | null, next: RigRun | null): boolean {
	if (!next || next.state !== 'running') return false;
	if (!prev || prev.state !== 'running' || prev.number !== next.number) return true;
	const k = questionKey(next);
	return k !== null && k !== questionKey(prev);
}

/** The poll that sees a run end: running in the previous poll, over now. Only a run seen ending is
 *  announced, so reloading the app hours later doesn't replay an old result. */
export function justFinished(prev: RigRun | null, next: RigRun | null): boolean {
	return !!prev && prev.state === 'running' && !!next && next.number === prev.number && next.state !== 'running';
}

export function finishedText(state: RunState): string {
	switch (state) {
		case 'done': return 'Rig test finished: every step passed';
		case 'partial': return 'Rig test finished: some steps did not pass';
		case 'cancelled': return 'Rig test cancelled';
		case 'timed_out': return 'Rig test ran out of time';
		default: return 'Rig test';
	}
}

// ---- snooze / decline --------------------------------------------------------------------------

export type SnoozeChoice =
	| { kind: 'minutes'; minutes: number }
	| { kind: 'time'; hhmm: string }
	| { kind: 'after_recording' };

export const SNOOZE_PRESETS: { label: string; choice: SnoozeChoice }[] = [
	{ label: 'In 30 minutes', choice: { kind: 'minutes', minutes: 30 } },
	{ label: 'In 2 hours', choice: { kind: 'minutes', minutes: 120 } },
	{ label: 'After this recording', choice: { kind: 'after_recording' } },
];

/** The `until` of POST /snooze: an ISO 8601 instant, or "after_recording". Null for a time of day
 *  that doesn't parse. A time that has already passed today means the same time tomorrow. */
export function snoozeUntil(choice: SnoozeChoice, now: Date): string | null {
	if (choice.kind === 'after_recording') return 'after_recording';
	if (choice.kind === 'minutes') return new Date(now.getTime() + choice.minutes * 60_000).toISOString();
	const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(choice.hhmm.trim());
	if (!m) return null;
	const at = new Date(now);
	at.setHours(Number(m[1]), Number(m[2]), 0, 0);
	if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
	return at.toISOString();
}

export type DeclineCode = 'about_to_record' | 'machine_in_use' | 'rig_not_set_up' | 'not_today' | 'other';

export const DECLINE_REASONS: { code: DeclineCode; label: string }[] = [
	{ code: 'about_to_record', label: 'About to record / mid-session' },
	{ code: 'machine_in_use', label: 'Someone else is using the machine' },
	{ code: 'rig_not_set_up', label: 'Rig not set up (no tool or sensor)' },
	{ code: 'not_today', label: 'Not today, ask tomorrow' },
	{ code: 'other', label: 'Other…' },
];

export const DECLINE_TEXT_MAX = 300;

/** The body of POST /decline, or null while it isn't sendable ("other" needs its text; the other
 *  reasons never carry text). */
export function declineBody(code: DeclineCode | null, text: string): { reason_code: DeclineCode; text?: string } | null {
	if (!code) return null;
	if (code !== 'other') return { reason_code: code };
	const t = text.trim().slice(0, DECLINE_TEXT_MAX);
	return t ? { reason_code: 'other', text: t } : null;
}

// ---- history -----------------------------------------------------------------------------------

/** pass / fail counts for a history row, from whichever of `counts`, `items` or `steps` the
 *  backend sends. */
export function summaryCounts(s: RunSummary): { pass: number; fail: number } {
	if (s.counts) return { pass: num(s.counts.pass), fail: num(s.counts.fail) + num(s.counts.error) };
	const results = s.items?.map((i) => i.result) ?? s.steps?.map((x) => x.status) ?? [];
	return {
		pass: results.filter((r) => r === 'pass').length,
		fail: results.filter((r) => r === 'fail' || r === 'error').length,
	};
}

// ---- desktop notifications ---------------------------------------------------------------------

/** The desktop shell refuses anything longer (preload/main validate <= 200 chars). */
export const NOTIFY_MAX = 200;
export function clip(s: string, max = NOTIFY_MAX): string {
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Requests in `next` whose number isn't in `known`. */
export function newRequests(known: ReadonlySet<number>, next: RigRequest[]): RigRequest[] {
	return next.filter((r) => !known.has(r.number));
}

export function requestNotification(r: RigRequest): { title: string; body: string } {
	return {
		title: clip(`Rig test requested by ${r.requested_by || 'your admin'}`),
		body: clip(`#${r.number} ${r.title} (${estimateText(r.estimate_s.full, r.needs_operator_steps)})`),
	};
}

export function questionNotification(run: RigRun): { title: string; body: string } | null {
	if (!run.question) return null;
	return { title: clip(`Rig test #${run.number} needs you`), body: clip(run.question.text) };
}
