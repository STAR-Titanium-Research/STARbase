import { onScopeDispose, ref, watch } from 'vue';
import type { Ref, UnwrapNestedRefs } from 'vue';
import type { AccessApi } from '../access/accessApi';
import { useRequestGate } from '../composables/useRequestGate';
import { getBulk, listBulk, revertBulk } from './bulkApi';
import type { BulkActionRow, BulkActionSummary, RevertAnswer } from './bulkApi';
import { PAGE_SIZE, canRevert, listFailedText, mergePage, moreFailedText, revertFailedText, rowsFailedText } from './adminBulkModel';

export interface DetailState {
	open: boolean;
	loading: boolean;
	error: string;
	/** null until the rows have been read once. */
	rows: BulkActionRow[] | null;
}

export interface RevertDialog {
	action: BulkActionSummary;
	/** The revert is running. */
	busy: boolean;
	error: string;
	/** The answer, once it came: the dialog then lists what happened to each record. */
	result: RevertAnswer | null;
}

export interface AdminBulkOptions {
	api: AccessApi;
	/** True for a confirmed administrator only: while false nothing is requested and nothing is kept. */
	active: Ref<boolean>;
	pageSize?: number;
}

/**
 * The admin Home "Bulk actions" panel's state: the journal a page at a time (newest first; Show more asks for the next page by how many lines are
 * shown, and keeps a line once if a new action shifted the pages), one line's rows read when it is first opened, and the Revert dialog: confirm,
 * run, then the per-record result. After a revert the list is read again from the top and the reverted line's rows are read afresh. A late answer
 * never replaces a newer one (useRequestGate: one gate for the list and its pages, one counter per line for the rows). Inactive means no request.
 */
export function useAdminBulk(opts: AdminBulkOptions) {
	const size = opts.pageSize ?? PAGE_SIZE;
	const actions = ref<BulkActionSummary[]>([]);
	const hasMore = ref(false);
	const loading = ref(false);
	const loadingMore = ref(false);
	const error = ref('');
	const details = ref<Record<string, DetailState>>({});
	const revert = ref<RevertDialog | null>(null);
	/** True once the first page has been read (an empty journal is an answer too). */
	const loaded = ref(false);

	const listGate = useRequestGate();
	const detailToken = new Map<string, number>();
	let detailSeq = 0;

	/** The first page. A reload keeps the lines on screen until the new ones arrive, and keeps them if it fails. */
	async function load(): Promise<void> {
		if (!opts.active.value) return;
		const token = listGate.begin();
		loadingMore.value = false;
		loading.value = true;
		const res = await listBulk(opts.api, { limit: size });
		if (!listGate.isCurrent(token)) return;
		loading.value = false;
		if (!res.ok) {
			error.value = listFailedText(res.message);
			return;
		}
		actions.value = res.data.actions;
		hasMore.value = res.data.hasMore;
		loaded.value = true;
		error.value = '';
	}

	/** The next page. A failure is said once and leaves the lines shown. */
	async function more(): Promise<void> {
		if (!opts.active.value || !hasMore.value || loadingMore.value || loading.value) return;
		const token = listGate.begin();
		loadingMore.value = true;
		const res = await listBulk(opts.api, { limit: size, offset: actions.value.length });
		if (!listGate.isCurrent(token)) return;
		loadingMore.value = false;
		if (!res.ok) {
			error.value = moreFailedText(res.message);
			return;
		}
		actions.value = mergePage(actions.value, res.data.actions);
		hasMore.value = res.data.hasMore;
		error.value = '';
	}

	async function loadRows(id: string): Promise<void> {
		const token = ++detailSeq;
		detailToken.set(id, token);
		details.value = { ...details.value, [id]: { open: true, loading: true, error: '', rows: details.value[id]?.rows ?? null } };
		const res = await getBulk(opts.api, id);
		if (detailToken.get(id) !== token || !details.value[id]) return;
		details.value = {
			...details.value,
			[id]: res.ok ? { ...details.value[id], loading: false, error: '', rows: res.data.rows } : { ...details.value[id], loading: false, error: rowsFailedText(res.message) },
		};
	}

	/** Opens a line (its rows are read the first time) or closes it (they are kept for the next opening). */
	function toggle(id: string): void {
		const d = details.value[id];
		if (d?.open) {
			details.value = { ...details.value, [id]: { ...d, open: false } };
			return;
		}
		if (d?.rows) details.value = { ...details.value, [id]: { ...d, open: true } };
		else void loadRows(id);
	}

	/** Reads an open line's rows again (after an error). */
	const retryRows = (id: string): Promise<void> => loadRows(id);

	// ---- Revert ------------------------------------------------------------------------------------------------------

	/** Opens the confirm dialog for a line that may be reverted. */
	function openRevert(action: BulkActionSummary): void {
		if (!canRevert(action) || revert.value?.busy) return;
		revert.value = { action, busy: false, error: '', result: null };
	}

	/** Closes the dialog (not while the revert runs: its answer is shown here). */
	function closeRevert(): void {
		if (revert.value?.busy) return;
		revert.value = null;
	}

	/** Reverts the action. Whatever the answer, the list is read again: a revert writes a line of its own and changes the original's state. */
	async function confirmRevert(): Promise<void> {
		const r = revert.value;
		if (!r || r.busy || r.result) return;
		const id = r.action.action_id;
		revert.value = { ...r, busy: true, error: '' };
		const res = await revertBulk(opts.api, id);
		const cur = revert.value;
		if (cur && cur.action.action_id === id) revert.value = res.ok ? { ...cur, busy: false, error: '', result: res.data } : { ...cur, busy: false, error: revertFailedText(res.message) };
		// the original's rows now carry revert outcomes: read them afresh when next opened (now, if open)
		if (res.ok) {
			detailToken.delete(id);
			const d = details.value[id];
			if (d) {
				details.value = { ...details.value, [id]: { ...d, rows: null } };
				if (d.open) void loadRows(id);
			}
		}
		await load();
	}

	// ---- active ------------------------------------------------------------------------------------------------------

	watch(
		opts.active,
		(on) => {
			listGate.cancel();
			detailToken.clear();
			loading.value = false;
			loadingMore.value = false;
			if (!on) {
				actions.value = [];
				hasMore.value = false;
				details.value = {};
				revert.value = null;
				error.value = '';
				loaded.value = false;
				return;
			}
			void load();
		},
		{ immediate: true },
	);
	onScopeDispose(() => {
		listGate.cancel();
		detailToken.clear();
	});

	return { actions, hasMore, loading, loadingMore, loaded, error, details, revert, load, more, toggle, retryRows, openRevert, closeRevert, confirmRevert };
}

/** What `reactive(useAdminBulk(...))` hands the components: the refs read as plain values. */
export type AdminBulkState = UnwrapNestedRefs<ReturnType<typeof useAdminBulk>>;
