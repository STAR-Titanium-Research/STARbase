import { computed, ref } from 'vue';
import { useRequestGate, type HostApi } from '@d1/ui';
import {
	InboxApiError, acceptAll, dismissFiles, linkFiles, loadFiles, relinkFile, rescan, restoreFiles, undoBatch,
	type FilesQuery, type FoundFile, type LinkItem, type Skipped,
} from './inboxApi';
import {
	RESCAN_QUEUED_TEXT, acceptFilter, acceptPairs, acceptPreview, acceptResultText, isAcceptable, linkResultText, mayReadDocuments, rateLimitMessage, teamRaceText, undoRefusalText, undoResultText,
	type AcceptPair,
} from './inboxBulk';
import { listPlan, nameOf, suggestionOf, type InboxFilters } from './inboxModel';
import { SCAN_ALREADY_TEXT, SCAN_NOT_LINKED, scanAddedText, scanErrorText, scanLinkItem, type ScanAddForm } from './inboxScan';

// The confirm of Accept all: what the dry run said (the count, the files and where they go, what it would leave), and whether it is still asking.
export interface AcceptDialog {
	open: boolean;
	loading: boolean;
	error: string;
	count: number;
	hasMore: boolean;
	skipped: Skipped[];
	/** How many files the dry run would leave in all (`skipped` holds at most the first 200). */
	skippedTotal: number;
	pairs: AcceptPair[];
	/** The pairs are the server's own list (not an example from the rows on screen). */
	pairsExact: boolean;
	/** The files the dry run listed, when it listed them all: Confirm asks for exactly these. */
	ids: string[] | null;
	mayRead: boolean;
}
const closedAccept = (): AcceptDialog => ({ open: false, loading: false, error: '', count: 0, hasMore: false, skipped: [], skippedTotal: 0, pairs: [], pairsExact: false, ids: null, mayRead: false });
/** Pairs shown in the confirm; the rest are counted. */
export const PAIRS_SHOWN = 5;


// The Inbox page's state and actions, over the typed client, with no lifecycle hooks (InboxView adds them) so it is tested with the fake
// server. It loads the picture rows and the "Other files" section as two lists (the second one collapsed: only its count is asked for
// until it is opened), drops a late answer (latest request wins), keeps what was shown when a reload fails, and says every outcome in
// one notice line that carries the Undo the action earned (one per batch).

export type NoticeUndo = { kind: 'batch'; id: string } | { kind: 'restore'; ids: string[] };
export interface Notice {
	tone: 'ok' | 'warn' | 'bad';
	text: string;
	undo?: NoticeUndo;
	/** A rule was just added (Ignore this folder): the notice offers to remove it again (useIgnoredFolders). Nothing is restored. */
	removeRule?: string;
}

/** A refusal may name the form control it is about (a 400 from adding a surface scan): `field`. */
export type Outcome = { ok: true } | { ok: false; message: string; field?: string };

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
/** The server stops counting what Accept all would link at about this many: from here the number on the button is a floor, so it is not shown. */
const ACCEPT_COUNT_CAP = 500;
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
	/** The Undo that is running (a batch id): a second click on any Undo waits for it. */
	const undoing = ref<string | null>(null);

	/** How many files Accept all would link under the whole filter (the server's count, asked apart so the rows are not kept waiting); null until known. */
	const acceptCount = ref<number | null>(null);
	const countGate = useRequestGate();

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
	async function loadAcceptCount(): Promise<void> {
		const filters = deps.getFilters();
		const token = countGate.begin();
		if (filters.tab !== 'new' && filters.tab !== 'older') {
			acceptCount.value = null;
			return;
		}
		try {
			const page = await loadFiles(api, { ...acceptFilter(filters), tab: filters.tab, limit: 1, offset: 0, acceptable: 1 });
			if (countGate.isCurrent(token)) acceptCount.value = page.acceptable;
		} catch {
			// no count: the button falls back to the rows on screen
			if (countGate.isCurrent(token)) acceptCount.value = null;
		}
	}

	async function load(): Promise<void> {
		otherOpen.value = listPlan(deps.getFilters()).openOther;
		otherFull.value = false;
		await Promise.all([loadMain(), loadOther(), loadAcceptCount()]);
	}

	async function toggleOther(open: boolean): Promise<void> {
		otherOpen.value = open;
		if (open && !otherFull.value) await loadOther();
	}

	const loadMoreMain = () => loadMain(true);
	const loadMoreOther = () => loadOther(true);

	function drop(ids: string[]): void {
		const gone = new Set(ids);
		if (acceptCount.value !== null) {
			const left = [...main.value.rows, ...other.value.rows].filter((f) => gone.has(f.candidate_id) && isAcceptable(f)).length;
			acceptCount.value = Math.max(0, acceptCount.value - left);
		}
		for (const part of [main, other]) {
			const before = part.value.rows.length;
			part.value = { ...part.value, rows: part.value.rows.filter((f) => !gone.has(f.candidate_id)) };
			part.value.total = Math.max(0, part.value.total - (before - part.value.rows.length));
		}
	}

	// One write per file at a time: a second click while the first runs (a double click, Enter held down) does nothing.
	async function run<T extends Outcome>(ids: string[], work: () => Promise<T>): Promise<T | Outcome> {
		if (ids.some(isBusy)) return { ok: false, message: 'That file is already being changed.' };
		busy.value = [...busy.value, ...ids];
		try {
			return await work();
		} finally {
			busy.value = busy.value.filter((id) => !ids.includes(id));
		}
	}

	/** A refused or failed write: its own words, and a fresh list (a 409 means the row changed under us). */
	async function failed(e: unknown, fallback: string, said?: { message: string; field: string | null }): Promise<Outcome> {
		const text = said?.message ?? message(e, fallback);
		say({ tone: 'bad', text });
		if (e instanceof InboxApiError && (e.status === 409 || e.status === 404)) void load();
		return said?.field ? { ok: false, message: text, field: said.field } : { ok: false, message: text };
	}

	async function link(file: FoundFile, collection: string, recordId: string): Promise<Outcome> {
		// a surface scan is ADDED to an insert or an edge (addScan); the endpoint refuses it as a link to anything else, so it is never sent
		if (file.kind === 'surface_scan') return { ok: false, message: SCAN_NOT_LINKED };
		const items: LinkItem[] = [{ candidate_id: file.candidate_id, collection, record_id: recordId }];
		return run([file.candidate_id], async () => {
			try {
				const r = await linkFiles(api, items);
				drop([file.candidate_id]);
				// the same person repeating a link: the server made no batch and linked nothing new (linked 0, link_batch_id null)
				say({ tone: 'ok', text: r.linked > 0 ? linkResultText(r.linked) : 'That file was already linked.', undo: r.link_batch_id ? { kind: 'batch', id: r.link_batch_id } : undefined });
				deps.onChanged?.();
				return { ok: true } as const;
			} catch (e) {
				const race = teamRaceText(file, e);
				return failed(e, 'Could not link that file.', race ? { message: race, field: null } : undefined);
			}
		});
	}

	/** Link a file to the record its path names (only a file whose suggestion the page can link). */
	async function linkSuggested(file: FoundFile): Promise<Outcome> {
		const s = suggestionOf(file);
		if (!s?.target || !file.suggested_record_id) return { ok: false, message: 'This file has no record to link to.' };
		return link(file, s.target.collection, file.suggested_record_id);
	}

	/**
	 * Add a surface scan: the found file to an insert or an edge, with the condition the person chose. Nothing is sent until the form can be (an item
	 * and a condition), and a second click while the first runs does nothing. The answer says where it went (and offers one Undo for the batch), or that
	 * the same person had already added it (no batch, no Undo); a refusal is said in the words of scanErrorText.
	 */
	async function addScan(file: FoundFile, form: ScanAddForm): Promise<Outcome> {
		if (file.kind !== 'surface_scan') return { ok: false, message: scanErrorText(new InboxApiError('', { status: 409, code: 'NOT_A_SURFACE_SCAN' })).message };
		const item = scanLinkItem(file, form);
		if (!item || !form.item) return { ok: false, message: 'Choose the insert or edge and the condition first.' };
		const label = form.item.label;
		return run([file.candidate_id], async () => {
			try {
				const r = await linkFiles(api, [item]);
				drop([file.candidate_id]);
				// the same person repeating the same add: the server made no batch and added nothing new (linked 0, link_batch_id null)
				say({ tone: 'ok', text: r.linked > 0 ? scanAddedText(label) : SCAN_ALREADY_TEXT, undo: r.link_batch_id ? { kind: 'batch', id: r.link_batch_id } : undefined });
				deps.onChanged?.();
				return { ok: true } as const;
			} catch (e) {
				return failed(e, 'Could not add that surface scan.', scanErrorText(e));
			}
		});
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
	// The button is enabled when the files on screen include one it would link, or when there are more files than the page holds (the first page
	// may hold none while a later one does). Clicking it asks the server what it WOULD do (a dry run), and Confirm stays off until that answers;
	// Confirm then links what the dry run listed when it listed them, else the same filter.
	const preview = computed(() => {
		const plan = listPlan(deps.getFilters());
		const mainAll = !plan.main || main.value.rows.length >= main.value.total;
		// a collapsed Other files section holds no rows at all: its documents may be accepted too, so the count is not the whole until it is opened
		const otherAll = !plan.other || other.value.total === 0 || (otherFull.value && other.value.rows.length >= other.value.total);
		const shown = acceptPreview([...main.value.rows, ...other.value.rows], mainAll && otherAll);
		// the server's count for the same filter Accept all uses (images and documents alike) is the count, when it is known and under the cap
		return acceptCount.value === null ? shown : { ...shown, count: acceptCount.value, exact: acceptCount.value < ACCEPT_COUNT_CAP };
	});
	/** A list is still loading or growing: its count would be stale, so Accept all waits for it. */
	const listBusy = computed(() => loading.value || otherLoading.value || moreLoading.value);
	const canAcceptAll = computed(() => {
		const tab = deps.getFilters().tab;
		const maybe = preview.value.count > 0 || !preview.value.exact;
		const anything = main.value.total + other.value.total > 0;
		return (tab === 'new' || tab === 'older') && anything && maybe && !accepting.value && !listBusy.value && !acceptDialog.value.loading;
	});

	const acceptDialog = ref<AcceptDialog>(closedAccept());
	let acceptToken = 0;

	/** Where a row on screen would go, for naming the pairs of the preview. */
	const knownRow = (id: string) => {
		const f = [...main.value.rows, ...other.value.rows].find((r) => r.candidate_id === id);
		return f ? { file: nameOf(f.rel_path), record: f.suggested_label } : null;
	};

	async function openAccept(): Promise<void> {
		if (!canAcceptAll.value) return;
		const token = ++acceptToken;
		const filters = deps.getFilters();
		acceptDialog.value = { ...closedAccept(), open: true, loading: true, mayRead: mayReadDocuments(filters) };
		try {
			const r = await acceptAll(api, acceptFilter(filters), { dryRun: true });
			if (token !== acceptToken) return;
			// The dry run's list is only trusted when it covers the whole count: Confirm then asks for exactly those files.
			const listed = r.ids.length > 0 && r.ids.length === r.acceptable;
			const named = listed ? acceptPairs(r.ids, r.items, knownRow) : null;
			const fromRows = [...main.value.rows, ...other.value.rows].filter(isAcceptable).slice(0, PAIRS_SHOWN).map((f) => ({ file: nameOf(f.rel_path), record: f.suggested_label ?? 'a record' }));
			// Where the files go: the server's own list when the page can name every file in it; else a few of the files on screen, said to be examples.
			const pairs = named && named.pairs.length > 0 ? named.pairs : fromRows;
			acceptDialog.value = {
				...acceptDialog.value, loading: false, count: r.acceptable, hasMore: r.has_more, skipped: r.skipped, skippedTotal: r.skippedTotal, pairs, pairsExact: !!named?.all && pairs.length > 0,
				ids: listed ? r.ids : null,
			};
		} catch (e) {
			if (token !== acceptToken) return;
			acceptDialog.value = { ...acceptDialog.value, loading: false, error: message(e, 'Could not check which files would be linked.') };
		}
	}

	function closeAccept(): void {
		acceptToken += 1;
		acceptDialog.value = closedAccept();
	}

	/** Confirm: link what was previewed. Does nothing while the preview is loading, empty, or a run is already going. */
	async function confirmAccept(): Promise<Outcome> {
		const d = acceptDialog.value;
		if (!d.open || d.loading || d.error || d.count < 1 || accepting.value) return { ok: false, message: 'Nothing to confirm yet.' };
		accepting.value = true;
		try {
			const r = await acceptAll(api, acceptFilter(deps.getFilters()), d.ids ? { candidateIds: d.ids } : {});
			closeAccept();
			say({
				tone: r.linked > 0 ? 'ok' : 'warn',
				text: r.linked > 0 ? acceptResultText(r.linked, r.skippedTotal) : 'Nothing was linked: no found file matched exactly one record you can edit.',
				undo: r.linked > 0 && r.link_batch_id ? { kind: 'batch', id: r.link_batch_id } : undefined,
			});
			await load();
			deps.onChanged?.();
			return { ok: true };
		} catch (e) {
			closeAccept();
			return failed(e, 'Could not accept the files.');
		} finally {
			accepting.value = false;
		}
	}

	/** The Undo of a notice or a batch. One at a time: a second click while one runs does nothing. */
	async function undo(u: NoticeUndo): Promise<Outcome> {
		const key = u.kind === 'batch' ? u.id : u.ids.join(',');
		if (undoing.value !== null) return { ok: false, message: 'An undo is already running.' };
		undoing.value = key;
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
			const refused = undoRefusalText(e);
			return failed(e, 'Could not undo that.', refused ? { message: refused, field: null } : undefined);
		} finally {
			undoing.value = null;
		}
	}

	/**
	 * Change the record a LINKED file is on: ONE request (POST /relink), which undoes that file's link and links it to the new record in a single transaction, so a
	 * refusal (a record the person may not edit, one that is gone, a link that is not theirs to undo) changes nothing: the file stays where it was, with its
	 * imaging corrections. The page offers it only for a batch of one. Choosing the record the file is already on does nothing.
	 */
	async function relink(file: FoundFile, collection: string, recordId: string): Promise<Outcome> {
		if (!file.link_batch_id) return { ok: false, message: 'This file has no link to change.' };
		if (file.linked_collection === collection && file.linked_record_id === recordId) return { ok: true };
		return run([file.candidate_id], async () => {
			try {
				const r = await relinkFile(api, { candidate_id: file.candidate_id, collection, record_id: recordId });
				say({ tone: 'ok', text: linkResultText(r.linked), undo: r.link_batch_id ? { kind: 'batch', id: r.link_batch_id } : undefined });
				// the file is on its new record: the Recently linked list names it there
				await load();
				deps.onChanged?.();
				return { ok: true } as const;
			} catch (e) {
				const race = teamRaceText(file, e);
				return failed(e, 'Could not change the link.', race ? { message: race, field: null } : undefined);
			}
		});
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
		preview, acceptCount, canAcceptAll, isBusy, undoing, listBusy, acceptDialog,
		load, toggleOther, loadMoreMain, loadMoreOther, link, relink, linkSuggested, addScan, dismiss, restore, openAccept, closeAccept, confirmAccept, undo, rescanNow,
		say,
		dismissNotice: () => say(null),
		cancel: () => {
			mainGate.cancel();
			otherGate.cancel();
		},
	};
}
