// Offline-resilient write queue for run records. Writes go through the Directus `api` (bearer);
// if the DB is unreachable (offline or network error) the record is persisted to localStorage and
// retried on the `online` event + a periodic timer. A 4xx (validation/permission) surfaces the
// error but keeps the item for manual retry. This gives the recording flow offline resilience:
// capture locally now, sync the run record when the network returns.
import { computed, reactive, ref } from 'vue';
import { api } from '../directusClient';
import { authStore } from '../authStore';
import { resolveOwnerPersonId, syncerFields } from '../recorder';

const LS_KEY = 'force-app.sync.queue';

export interface QueuedRun {
	id: string;
	collection: string;
	payload: Record<string, any>;
	createdAt: number;
	attempts: number;
	lastError?: string;
	/** Directus user id that recorded this run (from recorded_metadata), when known. */
	recordedBy?: string;
	/** Who that is, for display ("waiting for ... to sign in"). */
	recordedByLabel?: string;
	/** Set by "Upload as me": another user's record the current user chose to sync anyway. */
	syncAsMe?: boolean;
}

// Mirror of what is in localStorage, so the counts below are reactive.
const queued = ref<QueuedRun[]>([]);

// A record syncs automatically only under the account that recorded it (or one nobody is recorded
// for, i.e. from before this field existed). Directus stamps audit_logs / user_created with whoever
// owns the token that performs the write, so letting whoever signs in next push everyone's queued
// records would silently re-attribute them. Another user can still do it deliberately ("Upload as
// me", Settings > Local Captures); the recorder then stays in recorded_metadata either way.
function mayAutoSync(item: QueuedRun): boolean {
	const me = authStore.state.user?.id;
	return !item.recordedBy || item.syncAsMe === true || item.recordedBy === me;
}

export const syncStatus = reactive({
	pending: 0,
	syncing: false,
	lastError: null as string | null,
	lastSyncedAt: null as number | null,
	// Derived, not cached: they depend on who is signed in and whether the session is offline, both
	// of which change without the queue itself being touched.
	/** Queued, but this session is offline-only (no Directus token): needs a sign-in while connected. */
	needsSignIn: computed(() => queued.value.length > 0 && authStore.state.offline),
	/** Queued records recorded by someone else, left for that user's next sign-in. */
	waitingForOthers: computed(() => queued.value.filter((x) => !mayAutoSync(x)).length),
});

function recount(q: QueuedRun[]): void {
	queued.value = q;
	syncStatus.pending = q.length;
}

function load(): QueuedRun[] {
	try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
function save(q: QueuedRun[]) { localStorage.setItem(LS_KEY, JSON.stringify(q)); recount(q); }

// Enqueue a run record and attempt to flush immediately.
export async function logRun(payload: Record<string, any>, collection = 'manufacturing_operations'): Promise<void> {
	const q = load();
	const rm = payload.recorded_metadata ?? {};
	q.push({
		id: crypto.randomUUID(), collection, payload, createdAt: Date.now(), attempts: 0,
		recordedBy: rm.recorded_by_user_id || undefined,
		recordedByLabel: rm.recorded_by_name || rm.recorded_by_email || undefined,
	});
	save(q);
	await flush();
}

let flushing = false;
export async function flush(): Promise<void> {
	if (flushing) return;
	if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
	// An offline session has no token, so every write would 401. Say why and wait for a re-sign-in.
	if (authStore.state.offline) { recount(load()); return; }
	flushing = true;
	syncStatus.syncing = true;
	try {
		// Re-read the queue on every iteration, and again after each await, rather than holding one
		// array for the whole run. The POST is an await point, so the user can discard or reorder an
		// item (Settings > Local Captures) while it is in flight — writing back a copy captured
		// before that would undo their edit, resurrecting an item they had just deleted.
		for (;;) {
			const q = load();
			recount(q);
			// First item this sign-in may sync; ones recorded by someone else wait for them.
			const item = q.find(mayAutoSync);
			if (!item) break;
			try {
				let payload = item.payload;
				if (item.collection === 'manufacturing_operations') {
					payload = { ...payload, recorded_metadata: { ...payload.recorded_metadata, ...syncerFields() } };
					// No person link was stamped at record time: resolve the recorder's now. A failed lookup
					// throws into the handler below and leaves the record queued (never owned by the uploader).
					if (payload.owner_person_id == null) payload.owner_person_id = await resolveOwnerPersonId(payload.recorded_metadata);
				}
				await api.post(`/items/${item.collection}`, payload);
				save(load().filter((x) => x.id !== item.id));   // success — drop just this one
				syncStatus.lastSyncedAt = Date.now();
				syncStatus.lastError = null;
			} catch (e: any) {
				const status = e?.response?.status;
				const cur = load();
				const live = cur.find((x) => x.id === item.id);
				if (!live) break;   // discarded mid-flight — nothing to record against
				live.attempts++;
				live.lastError = e?.message || 'write failed';
				if (status && status >= 400 && status < 500 && status !== 429) {
					// permanent (validation/permission): keep for manual retry but stop the run and surface it
					// live.lastError! : assigned a non-empty string three lines up, but the
					// JSON.stringify() call in this same expression invalidates TS's narrowing
					// of the property (the call could in principle mutate `live`).
					syncStatus.lastError = `${status}: ${(JSON.stringify(e?.response?.data?.errors?.[0]?.message ?? '') || live.lastError!).slice(0, 160)}`;
				}
				// Either way stop: a permanent failure needs attention, and a transient one is
				// retried by the timer / online event.
				save(cur);
				break;
			}
		}
	} finally {
		flushing = false;
		syncStatus.syncing = false;
	}
}

// ---- Queue inspection (Settings > Local Captures) ----
// The topbar only ever showed a count, so a run stuck behind a validation error was invisible:
// no way to see which one, why, or to clear it. These expose the queue for that UI.
export function listQueue(): QueuedRun[] {
	return load();
}

/** Sync a record another user recorded, under the current sign-in, instead of waiting for them. */
export async function uploadQueuedAsMe(id: string): Promise<boolean> {
	const q = load();
	const it = q.find((x) => x.id === id);
	if (!it) return false;
	it.syncAsMe = true;
	save(q);
	return retryQueued(id);
}

/** Drop one item permanently. Its capture stays on disk; only the pending DB write is abandoned. */
export function discardQueued(id: string): void {
	save(load().filter((x) => x.id !== id));
}

/**
 * Move an item to the front and flush, so a fixed permanent failure can be retried on demand.
 * Returns false if a sync was already running, in which case nothing was attempted here — the
 * item is still promoted, so the in-progress run reaches it next.
 */
export async function retryQueued(id: string): Promise<boolean> {
	const q = load();
	const i = q.findIndex((x) => x.id === id);
	if (i < 0) return false;
	// flush() stops at the first permanent failure, so a poisoned head would block everything
	// behind it — promoting the requested item is what makes a targeted retry possible at all.
	const [item] = q.splice(i, 1);
	q.unshift(item);
	save(q);
	// Deliberately NOT clearing lastError up front. flush() is a no-op while another run holds the
	// guard, so wiping the diagnosis here would repaint the row as a healthy "queued" item with no
	// error and nothing actually retried. The error is cleared by a successful write (the item
	// disappears) or replaced by the next failure.
	if (flushing) return false;
	syncStatus.lastError = null;
	await flush();
	return true;
}

// Wire background retries once.
let started = false;
export function startSync(): void {
	if (started) return;
	started = true;
	recount(load());
	window.addEventListener('online', () => { void flush(); });
	setInterval(() => { if (syncStatus.pending > 0) void flush(); }, 15000);
	void flush();
}
