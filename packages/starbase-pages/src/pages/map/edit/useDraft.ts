// The draft of edit mode as a composable (spec §5.2, §8): loads and keeps the draft through `d1-build`, undo and redo over
// its bodies, Checks (the client's and the last answer of the server) and the two actions that write records, Create and
// Mark done. Talks to the server only through `useExplorerHost().api` (a fake one is passed in tests).
//
// Saving: every change is kept on the server automatically, one PATCH 800 ms after the last change, with the version the
// draft was read at (OCC). A 409 means the draft changed elsewhere (another tab): it is reloaded, the local undo history is
// dropped and `notice` says so. A failed save keeps the change in the page and is tried again with the next one.

import { computed, getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue';
import {
	errorText, useExplorerHost, type Check, type CheckResponse, type CreateResponse, type DraftBody, type DraftListEntry, type DraftRecord, type HostApi,
	type MarkDoneBody, type MarkDoneResponse,
} from '@d1/ui';
import { blocking, checks as clientChecks, mergeChecks, onCanvas, type CheckCtx } from './checks';
import { apply as reduce, emptyBody, type DraftAction } from './draft';
import { canRedo, canUndo, clear, createHistory, push, redo, undo, type History } from './history';
import { withSampleCodes } from './inherit';
import { defaultName } from './summary';

export const SAVE_DELAY_MS = 800;
export const CHANGED_ELSEWHERE = 'This draft changed in another tab; reloaded.';
export const NETWORK_MESSAGE = 'Could not reach the server; nothing was created.';

/** What Create or Mark done answered when it did not do it. */
export type Refusal =
	| { ok: false; reason: 'checks'; checks: Check[]; message: string }
	| { ok: false; reason: 'write'; key: string; message: string }
	| { ok: false; reason: 'conflict' | 'error'; message: string }
	| { ok: false; reason: 'network'; message: string };

export type CreateOutcome = ({ ok: true } & CreateResponse['data']) | Refusal;
export type MarkDoneOutcome = ({ ok: true } & MarkDoneResponse['data']) | Refusal;

export interface UseDraftOptions {
	/** The API the draft talks through; the Explorer host's by default. */
	api?: HostApi;
	/** What the client checks and the sample codes need (field definitions, loaded records, material and method codes). Read on every check. */
	ctx?: () => CheckCtx;
	/** The name a new draft gets when none is given. */
	nameFor?: (body: DraftBody) => string;
	/** Milliseconds between the last change and the save. */
	delay?: number;
}

const status = (e: any): number | undefined => e?.response?.status;
const extension = (e: any) => e?.response?.data?.errors?.[0]?.extensions as { code?: string; checks?: Check[]; key?: string } | undefined;

/** A failed Create or Mark done as the page shows it. */
export function refusalOf(e: any): Refusal {
	if (!e?.response) return { ok: false, reason: 'network', message: NETWORK_MESSAGE };
	const message = errorText(e, 'The server refused it.');
	const ext = extension(e);
	if (status(e) === 409 && ext?.code === 'CHECKS') return { ok: false, reason: 'checks', checks: ext.checks ?? [], message };
	if (ext?.code === 'WRITE_FAILED' && ext.key) return { ok: false, reason: 'write', key: ext.key, message };
	if (status(e) === 409) return { ok: false, reason: 'conflict', message };
	return { ok: false, reason: 'error', message };
}

export function useDraft(options: UseDraftOptions = {}) {
	const api: HostApi = options.api ?? useExplorerHost().api;
	const ctxOf = options.ctx ?? (() => ({}));
	const delay = options.delay ?? SAVE_DELAY_MS;

	/** True only once `GET /d1-build/drafts` answered: false while unknown, and false for good when it 404s (no d1-build here). */
	const available = ref(false);
	const probed = ref(false);
	const probeError = ref('');
	/** My drafts (id, name, when, what is in it), as the last probe or refresh read them. */
	const drafts = shallowRef<DraftListEntry[]>([]);

	const draftId = ref<string | null>(null);
	const name = ref('');
	const version = ref(0);
	const history = shallowRef<History<DraftBody>>(createHistory(emptyBody()));
	const body = computed(() => history.value.present);
	const loading = ref(false);
	/** A save is waiting for its delay or on the wire. */
	const saving = ref(false);
	const saveError = ref('');
	/** Said once, then cleared by the page: "This draft changed in another tab; reloaded." */
	const notice = ref('');
	const serverChecks = shallowRef<Check[]>([]);
	const creating = ref(false);

	// ---- saving ----------------------------------------------------------------------------------

	let timer: ReturnType<typeof setTimeout> | null = null;
	let inFlight: Promise<void> | null = null;
	let dirty = false;
	let nameDirty = false;

	function schedule() {
		if (!draftId.value) return;
		dirty = true;
		saving.value = true;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => void flush(), delay);
	}

	/** Sends what is waiting now, then anything that changed while it was on the wire. Resolves when the server has the latest. */
	async function flush(): Promise<void> {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		while (inFlight) await inFlight;
		if (!dirty || !draftId.value) {
			saving.value = false;
			return;
		}
		const id = draftId.value;
		const sent = history.value.present;
		const sentName = name.value;
		const withName = nameDirty;
		dirty = false;
		nameDirty = false;
		inFlight = (async () => {
			try {
				const res = await api.patch(`/d1-build/drafts/${encodeURIComponent(id)}`, { body: sent, ...(withName ? { name: sentName } : {}), version: version.value });
				if (draftId.value !== id) return;
				const next = res.data?.data?.version;
				version.value = typeof next === 'number' ? next : version.value + 1;
				saveError.value = '';
			} catch (e) {
				if (draftId.value !== id) return;
				if (status(e) === 409) {
					await reload(id);
					return;
				}
				// Kept in the page: the next change sends it again.
				dirty = true;
				nameDirty = nameDirty || withName;
				saveError.value = status(e) === 404 ? 'This draft no longer exists on the server.' : (e as any)?.response ? errorText(e, 'Could not keep the draft.') : 'Could not reach the server; your changes are kept here.';
			}
		})();
		try {
			await inFlight;
		} finally {
			inFlight = null;
		}
		if (dirty && !saveError.value) return flush();
		saving.value = dirty;
	}

	/** The draft as the server has it, after a conflict: the page's changes and its undo history are dropped. */
	async function reload(id: string): Promise<void> {
		dirty = false;
		nameDirty = false;
		const res = await api.get(`/d1-build/drafts/${encodeURIComponent(id)}`);
		take(res.data?.data as DraftRecord);
		notice.value = CHANGED_ELSEWHERE;
		saveError.value = '';
	}

	function take(rec: DraftRecord) {
		draftId.value = rec.id;
		name.value = rec.name;
		version.value = rec.version;
		history.value = clear(rec.body);
	}

	// ---- the list, opening, starting, discarding ------------------------------------------------------

	/** Asks whether `d1-build` is there and reads my drafts. Edit mode stays hidden when it is not. */
	async function probe(): Promise<boolean> {
		try {
			const res = await api.get('/d1-build/drafts');
			drafts.value = (res.data?.data ?? []) as DraftListEntry[];
			available.value = true;
			probeError.value = '';
		} catch (e) {
			available.value = false;
			// 404: this server has no d1-build (STARbase deployed before d1-server). Anything else is a failure to ask.
			probeError.value = status(e) === 404 ? '' : errorText(e, 'Could not reach the server.');
		}
		probed.value = true;
		return available.value;
	}

	/** The list of my drafts again (after Create, discard or a rename). */
	async function refresh(): Promise<DraftListEntry[]> {
		try {
			drafts.value = ((await api.get('/d1-build/drafts')).data?.data ?? []) as DraftListEntry[];
		} catch {
			/* the last list stands */
		}
		return drafts.value;
	}

	let opening = 0;
	/** Opens one of my drafts, and has the server re-read the records in it (stale, gone, no longer attachable). */
	async function open(id: string): Promise<boolean> {
		const token = ++opening;
		loading.value = true;
		try {
			await flush();
			const res = await api.get(`/d1-build/drafts/${encodeURIComponent(id)}`);
			if (token !== opening) return false;
			take(res.data?.data as DraftRecord);
			serverChecks.value = [];
			notice.value = '';
			saveError.value = '';
			await checkNow();
			return true;
		} catch (e) {
			if (token !== opening) return false;
			saveError.value = status(e) === 404 || status(e) === 403 ? 'That draft is not there any more.' : errorText(e, 'Could not open the draft.');
			return false;
		} finally {
			if (token === opening) loading.value = false;
		}
	}

	/** Starts a new draft on the server (a blank canvas, or from `from`) and opens it. */
	async function start(from: { body?: DraftBody; name?: string } = {}): Promise<string | null> {
		const first = from.body ?? emptyBody();
		const title = from.name ?? options.nameFor?.(first) ?? defaultName(first);
		try {
			await flush();
			const res = await api.post('/d1-build/drafts', { name: title, body: first });
			const rec = res.data?.data as DraftRecord;
			take(rec);
			serverChecks.value = [];
			notice.value = '';
			saveError.value = '';
			return rec.id;
		} catch (e) {
			saveError.value = errorText(e, 'Could not start a draft.');
			return null;
		}
	}

	/** Throws the draft away on the server. */
	async function discard(): Promise<boolean> {
		const id = draftId.value;
		if (!id) return true;
		try {
			await api.delete(`/d1-build/drafts/${encodeURIComponent(id)}`);
		} catch (e) {
			if (status(e) !== 404) {
				saveError.value = errorText(e, 'Could not discard the draft.');
				return false;
			}
		}
		forget();
		await refresh();
		return true;
	}

	/** Lets go of the open draft without telling the server (it was created, or discarded). */
	function forget() {
		if (timer) clearTimeout(timer);
		timer = null;
		dirty = false;
		nameDirty = false;
		saving.value = false;
		draftId.value = null;
		name.value = '';
		version.value = 0;
		history.value = clear(emptyBody());
		serverChecks.value = [];
	}

	// ---- editing -------------------------------------------------------------------------------------

	/** Does one action on the draft. A change is undoable and kept on the server; an action that changes nothing is no step. */
	function apply(action: DraftAction): DraftBody {
		const next = reduce(history.value.present, action);
		if (next !== history.value.present) {
			history.value = push(history.value, next);
			schedule();
		}
		return next;
	}

	function undoStep() {
		const before = history.value;
		history.value = undo(before);
		if (history.value !== before) schedule();
	}
	function redoStep() {
		const before = history.value;
		history.value = redo(before);
		if (history.value !== before) schedule();
	}

	/** Renames the draft (not an undoable step: the name is not part of the body). */
	function rename(next: string) {
		const text = next.trim();
		if (!text || text === name.value) return;
		name.value = text;
		nameDirty = true;
		schedule();
	}

	// ---- checks --------------------------------------------------------------------------------------

	/** The client's checks and the server's last answer, blocking first, each message once. */
	const checks = computed<Check[]>(() => mergeChecks(clientChecks(body.value, ctxOf()), serverChecks.value.filter((c) => onCanvas(body.value, c))));
	const missing = computed(() => blocking(checks.value).length);

	/** Has the server check the draft: it re-reads the existing records, which the client cannot. */
	async function checkNow(): Promise<Check[]> {
		const id = draftId.value;
		if (!id) return [];
		try {
			await flush();
			const res = await api.post(`/d1-build/drafts/${encodeURIComponent(id)}/check`, {});
			if (draftId.value !== id) return [];
			serverChecks.value = ((res.data as CheckResponse | undefined)?.data?.checks ?? []) as Check[];
		} catch {
			/* the client's checks stand; Create checks again */
		}
		return serverChecks.value;
	}

	// ---- Create and Mark done -------------------------------------------------------------------------

	/**
	 * Turns the whole draft into records, all or none. The new samples' codes are composed first (they carry today's date),
	 * the draft is kept on the server, then created. On success the draft is gone: the page gets the ids and codes made
	 * (and the sample ids for the labels link), and the history is cleared so undo never deletes records.
	 */
	async function create(): Promise<CreateOutcome> {
		const id = draftId.value;
		if (!id) return { ok: false, reason: 'error', message: 'There is no draft to create.' };
		if (creating.value) return { ok: false, reason: 'error', message: 'Create is already running.' };
		creating.value = true;
		try {
			const coded = withSampleCodes(history.value.present, ctxOf());
			if (coded !== history.value.present) {
				history.value = { ...history.value, present: coded };
				schedule();
			}
			await flush();
			if (saveError.value) return { ok: false, reason: 'error', message: saveError.value };
			if (draftId.value !== id) return { ok: false, reason: 'error', message: CHANGED_ELSEWHERE };
			const res = await api.post(`/d1-build/drafts/${encodeURIComponent(id)}/create`, {});
			const data = (res.data as CreateResponse).data;
			forget();
			await refresh();
			return { ok: true, ...data };
		} catch (e) {
			const refusal = refusalOf(e);
			if (refusal.reason === 'checks') serverChecks.value = refusal.checks;
			return refusal;
		} finally {
			creating.value = false;
		}
	}

	/** Marks one planned operation or test done now (it is not a draft change, so it works with no draft open). */
	async function markDone(input: MarkDoneBody): Promise<MarkDoneOutcome> {
		try {
			const res = await api.post('/d1-build/mark-done', input);
			return { ok: true, ...(res.data as MarkDoneResponse).data };
		} catch (e) {
			return refusalOf(e);
		}
	}

	if (getCurrentScope()) {
		// Leaving the page with a change on its way: send it (the answer has nobody to tell).
		onScopeDispose(() => {
			if (dirty && draftId.value) void flush();
		});
	}

	return {
		// whether edit mode exists on this server, and my drafts
		available, probed, probeError, drafts, probe, refresh,
		// the open draft
		draftId, name, version, body, loading, saving, saveError, notice,
		open, start, discard, forget, rename, flush,
		// editing
		apply, undo: undoStep, redo: redoStep,
		canUndo: computed(() => canUndo(history.value)),
		canRedo: computed(() => canRedo(history.value)),
		// checks
		checks, missing, checkNow,
		// writing records
		creating, create, markDone,
	};
}

export type DraftApi = ReturnType<typeof useDraft>;
