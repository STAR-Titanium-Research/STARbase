import { computed, getCurrentInstance, getCurrentScope, onBeforeUnmount, onMounted, onScopeDispose, ref } from 'vue';
import type { ComputedRef, Ref } from 'vue';
import type { ExplorerHost } from '../host';
import { errorText } from '../format';
import { parseSummary, type InboxSummary } from './inboxSummary';

// The Inbox's counts, polled calmly for the sidebar badge and the Home panel (spec section 10, decision D8): GET /d1-inbox/summary as
// the caller. One state per host, so the sidebar's two modes and Home share one timer and one request. It reads once when the first
// component asks, again every few minutes while the tab is visible, and when the window gets focus back (not more than once every 30 s).
// A server with no d1-inbox yet (404) takes the Inbox out of the sidebar and Home for good, instead of showing an error: the front end must
// work before the server side is deployed. A 401 or 403 hides it until a later read succeeds. Any other failure keeps the last numbers and is
// kept in `error`.
export const POLL_MS = 3 * 60_000;
export const FOCUS_MIN_MS = 30_000;
const TIMEOUT_MS = 15_000;

export interface InboxSummaryState {
	summary: Ref<InboxSummary | null>;
	/** The server cannot say (no endpoint, or the caller is refused): draw no Inbox entry and no Inbox panel. A refusal is asked again later; a 404 is not. */
	absent: Ref<boolean>;
	/** The last failure other than "absent"; cleared by the next good read. */
	error: Ref<string>;
	loaded: Ref<boolean>;
	newCount: ComputedRef<number>;
	olderMatches: ComputedRef<number>;
	/** Read now (after linking or undoing, so the badge follows). Joins a read already in flight. */
	refresh: () => Promise<void>;
}

interface Internal extends InboxSummaryState {
	subscribers: number;
	start(): void;
	stop(): void;
}

const states = new WeakMap<ExplorerHost, Internal>();

function create(host: ExplorerHost): Internal {
	const summary = ref<InboxSummary | null>(null);
	const absent = ref(false);
	const error = ref('');
	const loaded = ref(false);
	let inFlight: Promise<void> | null = null;
	let lastAt = 0;
	let timer: ReturnType<typeof setInterval> | null = null;

	// A refusal (401 or 403) hides the Inbox but is not permanent (a session can lapse and come back, a role can change): the next poll, focus
	// or explicit refresh asks again. Only a 404 (this server has no d1-inbox) is final for the page's life.
	let missing = false;
	let dirty = false;

	async function readOnce(): Promise<void> {
		try {
			const res = await host.api.get('/d1-inbox/summary', { timeout: TIMEOUT_MS });
			const next = parseSummary(res?.data);
			if (next) {
				summary.value = next;
				error.value = '';
				absent.value = false;
			}
		} catch (e: any) {
			const status = e?.response?.status;
			if (status === 404) {
				missing = true;
				absent.value = true;
				summary.value = null;
			} else if (status === 403 || status === 401) {
				absent.value = true;
				summary.value = null;
			} else {
				error.value = errorText(e, 'Could not read the Inbox.');
			}
		} finally {
			lastAt = Date.now();
			loaded.value = true;
		}
	}

	/**
	 * Read now. A read already in flight is not enough after a write (it may have started before the write): asking while one runs makes it read
	 * once more when it settles, and the returned promise resolves after that second read. Any number of asks during one read share that one more.
	 */
	function refresh(): Promise<void> {
		if (missing) return Promise.resolve();
		if (inFlight) {
			dirty = true;
			return inFlight;
		}
		inFlight = (async () => {
			do {
				dirty = false;
				await readOnce();
			} while (dirty && !missing);
		})().finally(() => {
			inFlight = null;
		});
		return inFlight;
	}

	const sinceLast = () => Date.now() - lastAt;
	const onVisible = () => {
		if (!document.hidden && sinceLast() >= FOCUS_MIN_MS) void refresh();
	};
	const onFocus = () => {
		if (sinceLast() >= FOCUS_MIN_MS) void refresh();
	};

	return {
		summary,
		absent,
		error,
		loaded,
		newCount: computed(() => summary.value?.newCount ?? 0),
		olderMatches: computed(() => summary.value?.olderMatches ?? 0),
		refresh,
		subscribers: 0,
		start() {
			if (timer) return;
			void refresh();
			timer = setInterval(() => {
				if (!document.hidden) void refresh();
			}, POLL_MS);
			window.addEventListener('focus', onFocus);
			document.addEventListener('visibilitychange', onVisible);
		},
		stop() {
			if (timer) clearInterval(timer);
			timer = null;
			window.removeEventListener('focus', onFocus);
			document.removeEventListener('visibilitychange', onVisible);
		},
	};
}

/**
 * The shared Inbox counts for this host. Call it from a component's setup: the poll runs while at least one component that called it is
 * mounted, and stops with the last one. Outside a component or an effect scope it only returns the state (nothing polls).
 */
export function useInboxSummary(host: ExplorerHost): InboxSummaryState {
	let state = states.get(host);
	if (!state) {
		state = create(host);
		states.set(host, state);
	}
	const s = state;
	const attach = () => {
		s.subscribers += 1;
		s.start();
	};
	const detach = () => {
		s.subscribers -= 1;
		if (s.subscribers <= 0) s.stop();
	};
	// In a component the poll starts when it is mounted in the browser (a server render never mounts, so it never touches window);
	// in a bare effect scope (a test, a store) it starts at once.
	if (getCurrentInstance()) {
		onMounted(attach);
		onBeforeUnmount(detach);
	} else if (getCurrentScope()) {
		attach();
		onScopeDispose(detach);
	}
	return s;
}
