/**
 * Per-browser, per-user question history and saved questions, kept in localStorage. Keys are
 * namespaced by the Directus user id so users sharing one browser do not see each other's lists.
 *
 * Only the question text and a timestamp are stored, never result rows. Every storage access is
 * wrapped in try/catch: private windows and blocked site data make localStorage throw.
 */
export interface StoredQuestion {
	question: string;
	/** Epoch milliseconds when it was asked or saved. */
	at: number;
}

export const HISTORY_KEY = 'd1-ask-db:history';
export const SAVED_KEY = 'd1-ask-db:saved';
/** History keeps the newest N questions; the saved list is capped at a generous M. */
export const HISTORY_LIMIT = 20;
export const SAVED_LIMIT = 100;

/**
 * Only the first question of a conversation goes to Recent: a follow-up ("only aluminium") means
 * nothing without the turns before it, so "Run again" on it would lose its context. Pass the
 * number of context messages the request carries (the completed turns), not the transcript
 * length: a first question that errored left no context, so its rephrased retry still starts the
 * conversation and is recorded.
 */
export const startsConversation = (contextMessages: number) => contextMessages === 0;

export const SAVED_FULL_MESSAGE = `Saved list is full (${SAVED_LIMIT}) \u2014 remove one first`;

/**
 * Pin or unpin a question. A full list refuses a new pin rather than silently dropping the
 * oldest one; unpinning is always allowed.
 */
export function toggleSavedQuestion(
	list: StoredQuestion[],
	question: string,
	now: number,
	limit: number = SAVED_LIMIT,
): { list: StoredQuestion[]; result: 'saved' | 'removed' | 'full' } {
	if (hasQuestion(list, question)) return { list: removeQuestion(list, question), result: 'removed' };
	if (list.length >= limit) return { list, result: 'full' };
	return { list: addQuestion(list, question, now), result: 'saved' };
}

/** Storage key for a list, scoped to the user; the bare key only when there is no user id. */
export const scopedKey = (base: string, userId?: string | null) => (userId ? `${base}:${userId}` : base);

const norm = (q: string) => q.trim().replace(/\s+/g, ' ').toLowerCase();

/** Newest first, one entry per question (case and spacing ignored), cut to `limit` if given. */
export function addQuestion(
	list: StoredQuestion[],
	question: string,
	now: number,
	limit?: number,
): StoredQuestion[] {
	const text = question.trim();
	if (!text) return list;
	const key = norm(text);
	const next = [{ question: text, at: now }, ...list.filter((e) => norm(e.question) !== key)];
	return limit === undefined ? next : next.slice(0, limit);
}

export function removeQuestion(list: StoredQuestion[], question: string): StoredQuestion[] {
	const key = norm(question);
	return list.filter((e) => norm(e.question) !== key);
}

export function hasQuestion(list: StoredQuestion[], question: string): boolean {
	const key = norm(question);
	return list.some((e) => norm(e.question) === key);
}

/** Parse stored JSON defensively: anything malformed is dropped rather than thrown. */
export function parseStored(raw: string | null): StoredQuestion[] {
	if (!raw) return [];
	try {
		const data = JSON.parse(raw);
		if (!Array.isArray(data)) return [];
		return data
			.filter((e) => e && typeof e.question === 'string' && e.question.trim())
			.map((e) => ({ question: e.question as string, at: Number.isFinite(e.at) ? (e.at as number) : 0 }));
	} catch {
		return [];
	}
}

/** Union of two lists: one entry per question, newest first, cut to `limit` if given. */
export function mergeLists(a: StoredQuestion[], b: StoredQuestion[], limit?: number): StoredQuestion[] {
	const seen = new Set<string>();
	const out: StoredQuestion[] = [];
	for (const e of [...a, ...b].sort((x, y) => y.at - x.at)) {
		const key = norm(e.question);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(e);
	}
	return limit === undefined ? out : out.slice(0, limit);
}

export function loadList(key: string): StoredQuestion[] {
	try {
		return parseStored(window.localStorage.getItem(key));
	} catch {
		return [];
	}
}

/** Best effort: a full or unavailable store just means the list lasts until the page closes. */
export function saveList(key: string, list: StoredQuestion[]): void {
	try {
		window.localStorage.setItem(key, JSON.stringify(list));
	} catch {
		// ignore
	}
}

/**
 * Read-modify-write against storage: re-read the stored list (another tab may have changed it),
 * apply `change`, write it back and return it. `current` is the in-memory list, used only when
 * storage is unreadable.
 */
export function updateList(
	key: string,
	current: StoredQuestion[],
	change: (fresh: StoredQuestion[]) => StoredQuestion[],
): StoredQuestion[] {
	let fresh = current;
	try {
		fresh = parseStored(window.localStorage.getItem(key));
	} catch {
		// unreadable: keep working from the in-memory list
	}
	const next = change(fresh);
	saveList(key, next);
	return next;
}

/**
 * Delete the lists written before keys were per-user (the bare keys). They are not handed to
 * anyone: on a shared PC that would give one person's questions to whoever opens the module
 * next. Only runs once a user id is known, so a signed-in session never reads them.
 */
export function dropLegacy(userId: string | null | undefined): void {
	if (!userId) return;
	for (const base of [HISTORY_KEY, SAVED_KEY]) {
		try {
			window.localStorage.removeItem(base);
		} catch {
			// ignore
		}
	}
}
