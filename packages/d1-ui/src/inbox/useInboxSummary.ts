import { computed, getCurrentScope, onScopeDispose, ref } from 'vue';
import type { ComputedRef, Ref } from 'vue';
import type { ExplorerHost } from '../host';
import { errorText } from '../format';
import { parseSummary, type InboxSummary } from './inboxSummary';

// The Inbox's counts, polled calmly for the sidebar badge and the Home panel (spec section 10, decision D8): GET /d1-inbox/summary as
// the caller. One state per host, so the sidebar's two modes and Home share one timer and one request. It reads once when the first
// component asks, again every few minutes while the tab is visible, and when the window gets focus back (not more than once every 30 s).
// A server with no d1-inbox yet (404), or an answer of 401 or 403, takes the Inbox out of the sidebar and Home instead of showing an
// error: the front end must work before the server side is deployed. Any other failure keeps the last numbers and is kept in `error`.
export const POLL_MS = 3 * 60_000;
export const FOCUS_MIN_MS = 30_000;
const TIMEOUT_MS = 15_000;

export interface InboxSummaryState {
	summary: Ref<InboxSummary | null>;
	/** The server cannot say (no endpoint, or not allowed): draw no Inbox entry and no Inbox panel. */
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

	function refresh(): Promise<void> {
		if (absent.value) return Promise.resolve();
		if (!inFlight) {
			inFlight = (async () => {
				try {
					const res = await host.api.get('/d1-inbox/summary', { timeout: TIMEOUT_MS });
					const next = parseSummary(res?.data);
					if (next) {
						summary.value = next;
						error.value = '';
					}
				} catch (e: any) {
					const status = e?.response?.status;
					if (status === 404 || status === 403 || status === 401) {
						absent.value = true;
						summary.value = null;
					} else {
						error.value = errorText(e, 'Could not read the Inbox.');
					}
				} finally {
					lastAt = Date.now();
					loaded.value = true;
					inFlight = null;
				}
			})();
		}
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
 * mounted, and stops with the last one. Outside a component it only returns the state (nothing polls).
 */
export function useInboxSummary(host: ExplorerHost): InboxSummaryState {
	let state = states.get(host);
	if (!state) {
		state = create(host);
		states.set(host, state);
	}
	const s = state;
	if (getCurrentScope()) {
		s.subscribers += 1;
		s.start();
		onScopeDispose(() => {
			s.subscribers -= 1;
			if (s.subscribers <= 0) s.stop();
		});
	}
	return s;
}
