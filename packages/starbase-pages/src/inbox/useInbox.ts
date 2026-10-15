import { computed, ref } from 'vue';
import { useRequestGate, type HostApi } from '@d1/ui';
import {
	InboxApiError, acceptAll, dismissFiles, linkFiles, loadFiles, rescan, restoreFiles, undoBatch,
	type FilesQuery, type FoundFile, type LinkItem,
} from './inboxApi';
import { RESCAN_QUEUED_TEXT, acceptFilter, acceptPreview, acceptResultText, linkResultText, rateLimitMessage, undoResultText } from './inboxBulk';
import { listPlan, suggestionOf, type InboxFilters } from './inboxModel';

// The Inbox page's state and actions, over the typed client, with no lifecycle hooks (InboxView adds them) so it is tested with the fake
// server. It loads the picture rows and the "Other files" section as two lists (the second one collapsed: only its count is asked for
// until it is opened), drops a late answer (latest request wins), keeps what was shown when a reload fails, and says every outcome in
// one notice line that carries the Undo the action earned (one per batch).

export type NoticeUndo = { kind: 'batch'; id: string } | { kind: 'restore'; ids: string[] };
export interface Notice {
	tone: 'ok' | 'warn' | 'bad';
	text: string;
	undo?: NoticeUndo;
}

export type Outcome = { ok: true } | { ok: false; message: string };

export interface InboxDeps {
	api: HostApi;
	getFilters: () => InboxFilters;
	/** Something changed that the badge and Home count (a link, a dismissal, an undo): read the summary again. */
	onChanged?: () => void;
}

interface Part {
	rows: FoundFile[];
	total: number;
	acceptable: number | null;
}
const empty = (): Part => ({ rows: [], total: 0, acceptable: null });

export function createInbox(deps: InboxDeps) {
	const { api } = deps;
	const mainGate = useRequestGate();
	const otherGate = useRequestGate();

	const main = ref<Part>(empty());
	const other = ref<Part>(empty());
	const loading = ref(true);
	const otherLoading = ref(false);
	const moreLoading = ref(false);
	const error = ref('');
	const otherError = ref('');
	const otherOpen = ref(false);
	/** The Other files rows are only fetched once the section is opened (before that, only its count). */
	const otherFull = ref(false);
	const notice = ref<Notice | null>(null);
	const busy = ref<string[]>([]);
	const accepting = ref(false);
	const rescanning = ref(false);

	const isBusy = (id: string) => busy.value.includes(id);
	const say = (n: Notice | null) => (notice.value = n);
	const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

	async function loadMain(append = false): Promise<void> {
		const plan = listPlan(deps.getFilters());
		if (!plan.main) {
			main.value = empty();
			loading.value = false;
			return;
		}
		const token = mainGate.begin();
		const query: FilesQuery = { ...plan.main, offset: append ? main.value.rows.length : 0 };
		if (append) moreLoading.value = true;
		else loading.value = main.value.rows.length === 0;
		try {
			const page = await loadFiles(api, query);
			if (!mainGate.isCurrent(token)) return;
			main.value = { rows: append ? [...main.value.rows, ...page.rows] : page.rows, total: page.total, acceptable: page.acceptable };
			error.value = '';
		} catch (e) {
			if (!mainGate.isCurrent(token)) return;
			// A failed reload keeps what was shown, with the reason.
			error.value = message(e, 'Could not load your Inbox.');
		} finally {
			if (mainGate.isCurrent(token)) {
				loading.value = false;
				moreLoading.value = false;
			}
		}
	}

	async function loadOther(append = false): Promise<void> {
		const plan = listPlan(deps.getFilters());
		if (!plan.other) {
			other.value = empty();
			return;
		}
		if (plan.openOther) otherOpen.value = true;
		const full = otherOpen.value;
		const token = otherGate.begin();
		// Collapsed: one row is enough to learn the count (meta.total) and the acceptable count.
		const query: FilesQuery = { ...plan.other, limit: full ? plan.other.limit : 1, offset: append ? other.value.rows.length : 0 };
		otherLoading.value = true;
		try {
			const page = await loadFiles(api, query);
			if (!otherGate.isCurrent(token)) return;
			other.value = { rows: full ? (append ? [...other.value.rows, ...page.rows] : page.rows) : [], total: page.total, acceptable: page.acceptable };
			otherFull.value = full;
			otherError.value = '';
		} catch (e) {
			if (!otherGate.isCurrent(token)) return;
			otherError.value = message(e, 'Could not load the other files.');
		} finally {
			if (otherGate.isCurrent(token)) otherLoading.value = false;
		}
	}

	/** (Re)load both lists for the current filters. */
	async function load(): Promise<void> {
		otherOpen.value = listPlan(deps.getFilters()).openOther;
		otherFull.value = false;
		await Promise.all([loadMain(), loadOther()]);
	}

	async function toggleOther(open: boolean): Promise<void> {
		otherOpen.value = open;
		if (open && !otherFull.value) await loadOther();
	}

	const loadMoreMain = () => loadMain(true);
	const loadMoreOther = () => loadOther(true);

	function drop(ids: string[]): void {
		const gone = new Set(ids);
		for (const part of [main, other]) {
			const before = part.value.rows.length;
			part.value = { ...part.value, rows: part.value.rows.filter((f) => !gone.has(f.candidate_id)) };
			part.value.total = Math.max(0, part.value.total - (before - part.value.rows.length));
		}
	}

	async function run<T>(ids: string[], work: () => Promise<T>): Promise<T> {
		busy.value = [...busy.value, ...ids];
		try {
			return await work();
		} finally {
			busy.value = busy.value.filter((id) => !ids.includes(id));
		}
	}

	/** A refused or failed write: its own words, and a fresh list (a 409 means the row changed under us). */
	async function failed(e: unknown, fallback: string): Promise<Outcome> {
		const text = message(e, fallback);
		say({ tone: 'bad', text });
		if (e instanceof InboxApiError && (e.status === 409 || e.status === 404)) void load();
		return { ok: false, message: text };
	}

	async function link(file: FoundFile, collection: string, recordId: string): Promise<Outcome> {
		const items: LinkItem[] = [{ candidate_id: file.candidate_id, collection, record_id: recordId }];
		return run([file.candidate_id], async () => {
			try {
				const r = await linkFiles(api, items);
				drop([file.candidate_id]);
				say({ tone: 'ok', text: linkResultText(r.linked), undo: r.link_batch_id ? { kind: 'batch', id: r.link_batch_id } : undefined });
				deps.onChanged?.();
				return { ok: true } as const;
			} catch (e) {
				return failed(e, 'Could not link that file.');
			}
		});
	}

	/** Link a file to the record its path names (only a file whose suggestion the page can link). */
	async function linkSuggested(file: FoundFile): Promise<Outcome> {
		const s = suggestionOf(file);
		if (!s?.target || !file.suggested_record_id) return { ok: false, message: 'This file has no record to link to.' };
		return link(file, s.target.collection, file.suggested_record_id);
	}

	async function dismiss(file: FoundFile): Promise<Outcome> {
		return run([file.candidate_id], async () => {
			try {
				await dismissFiles(api, [file.candidate_id]);
				drop([file.candidate_id]);
				say({ tone: 'ok', text: 'Dismissed 1 found file. It stays under Dismissed.', undo: { kind: 'restore', ids: [file.candidate_id] } });
				deps.onChanged?.();
				return { ok: true } as const;
			} catch (e) {
				return failed(e, 'Could not dismiss that file.');
			}
		});
	}

	async function restore(file: FoundFile): Promise<Outcome> {
		return run([file.candidate_id], async () => {
			try {
				await restoreFiles(api, [file.candidate_id]);
				drop([file.candidate_id]);
				say({ tone: 'ok', text: 'Restored 1 found file to your Inbox.' });
				deps.onChanged?.();
				return { ok: true } as const;
			} catch (e) {
				return failed(e, 'Could not restore that file.');
			}
		});
	}

	// ---- Accept all ----
	const preview = computed(() => {
		const f = deps.getFilters();
		const plan = listPlan(f);
		const parts = [plan.main ? main.value : null, plan.other ? other.value : null].filter((p): p is Part => p !== null);
		// The server's count over the whole filter, when every part has one; else the rows on screen.
		const counts = parts.map((p) => p.acceptable);
		const server = counts.length > 0 && counts.every((c): c is number => c !== null) ? counts.reduce((a, b) => a + b, 0) : null;
		return acceptPreview([...main.value.rows, ...other.value.rows], server);
	});
	const canAcceptAll = computed(() => {
		const tab = deps.getFilters().tab;
		return (tab === 'new' || tab === 'older') && preview.value.count > 0 && !accepting.value;
	});

	async function acceptAllNow(): Promise<Outcome> {
		accepting.value = true;
		try {
			const r = await acceptAll(api, acceptFilter(deps.getFilters()));
			say({
				tone: r.linked > 0 ? 'ok' : 'warn',
				text: r.linked > 0 ? acceptResultText(r.linked, r.skipped.length) : 'Nothing was linked: no found file matched exactly one record you can edit.',
				undo: r.linked > 0 && r.link_batch_id ? { kind: 'batch', id: r.link_batch_id } : undefined,
			});
			await load();
			deps.onChanged?.();
			return { ok: true };
		} catch (e) {
			return failed(e, 'Could not accept the files.');
		} finally {
			accepting.value = false;
		}
	}

	async function undo(u: NoticeUndo): Promise<Outcome> {
		try {
			if (u.kind === 'batch') {
				const n = await undoBatch(api, u.id);
				say({ tone: 'ok', text: undoResultText(n) });
			} else {
				await restoreFiles(api, u.ids);
				say({ tone: 'ok', text: 'Restored to your Inbox.' });
			}
			await load();
			deps.onChanged?.();
			return { ok: true };
		} catch (e) {
			return failed(e, 'Could not undo that.');
		}
	}

	async function rescanNow(): Promise<Outcome> {
		rescanning.value = true;
		try {
			await rescan(api);
			say({ tone: 'ok', text: RESCAN_QUEUED_TEXT });
			return { ok: true };
		} catch (e) {
			if (e instanceof InboxApiError && e.status === 429) {
				const secs = Number(e.extensions?.retry_after_seconds);
				const text = rateLimitMessage(Number.isFinite(secs) ? secs : null);
				say({ tone: 'warn', text });
				return { ok: false, message: text };
			}
			return failed(e, 'Could not ask for a rescan.');
		} finally {
			rescanning.value = false;
		}
	}

	return {
		main, other, loading, otherLoading, moreLoading, error, otherError, otherOpen, notice, busy, accepting, rescanning,
		preview, canAcceptAll, isBusy,
		load, toggleOther, loadMoreMain, loadMoreOther, link, linkSuggested, dismiss, restore, acceptAllNow, undo, rescanNow,
		dismissNotice: () => say(null),
		cancel: () => {
			mainGate.cancel();
			otherGate.cancel();
		},
	};
}
