import { computed, onScopeDispose, ref } from 'vue';
import type { Ref, UnwrapNestedRefs } from 'vue';
import type { AccessApi } from '../access/accessApi';
import { useRequestGate } from '../composables/useRequestGate';
import type { IndexDef } from '../index/indexConfig';
import type { ChipOption } from '../index/indexView';
import { applyBulk, loadFieldOptions, previewBulk, undoBulk } from './bulkApi';
import type { BulkChoice, BulkEntry, BulkKind, PreviewRow, ToastModel } from './bulkModel';
import {
	applySkips, beginUndo, canApply, deadlineFor, dismissDelay, groupSkips, notRevertedIds, paramsFor, previewCounts, previewSkips, previewSummary,
	previewWarnings, resultText, startToast, tickToast, undoDone, undoFailed,
} from './bulkModel';

export interface BulkOptions {
	api: AccessApi;
	def: IndexDef;
	/** The ticked keys, in the order ticked. The dialog works on a copy taken when it opens. */
	picked: Ref<string[]>;
	/** The list changed (after an apply or an undo): reload it, and leave only `keep` ticked (the rows that were skipped). */
	onChanged: (keep: string[]) => void;
	/** The clock, in ms (a test passes its own). */
	now?: () => number;
}

export interface PreviewState {
	loading: boolean;
	rows: PreviewRow[] | null;
	error: string;
}
const IDLE: PreviewState = { loading: false, rows: null, error: '' };

interface DialogState {
	entry: BulkEntry;
	/** The ticked keys at the moment the dialog opened. */
	ids: string[];
	choice: BulkChoice;
	/** The picked link's display text, for the toast's words. */
	choiceLabel?: string;
}

/**
 * Bulk actions of one index page: the dialog (target, dry-run preview, apply) and the undo toasts. The preview of an older choice
 * never replaces the one for the latest (useRequestGate), and closing the dialog drops one still in flight. An action that is applied
 * stays applied whatever happens to the dialog; its toast is how it is undone for 60 seconds. Several toasts can be live at once,
 * one per action, each with its own countdown.
 */
export function useBulkActions(opts: BulkOptions) {
	const now = opts.now ?? (() => Date.now());
	const dialog = ref<DialogState | null>(null);
	const preview = ref<PreviewState>(IDLE);
	const applying = ref(false);
	const applyError = ref('');
	const fieldOptions = ref<ChipOption[]>([]);
	const optionsState = ref<{ loading: boolean; error: string }>({ loading: false, error: '' });
	const toasts = ref<ToastModel[]>([]);

	const previewGate = useRequestGate();
	const optionsGate = useRequestGate();
	// Per action: the code of every row, so an undo can name the rows it left alone.
	const codes = new Map<string, Map<string, string>>();
	const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();
	let clock: ReturnType<typeof setInterval> | null = null;

	// ---- the dialog ------------------------------------------------------------------------------------------------

	async function runPreview(): Promise<void> {
		const d = dialog.value;
		const params = d ? paramsFor(d.entry, d.choice) : null;
		if (!d || !params) {
			previewGate.cancel();
			preview.value = IDLE;
			return;
		}
		const token = previewGate.begin();
		preview.value = { loading: true, rows: null, error: '' };
		const res = await previewBulk(opts.api, opts.def.collection, d.entry.kind as BulkKind, d.ids, params);
		if (!previewGate.isCurrent(token)) return;
		preview.value = res.ok ? { loading: false, rows: res.data, error: '' } : { loading: false, rows: null, error: res.message };
	}

	async function loadOptions(entry: BulkEntry): Promise<void> {
		fieldOptions.value = [];
		optionsState.value = { loading: false, error: '' };
		if (entry.field?.kind !== 'relation') return;
		const token = optionsGate.begin();
		optionsState.value = { loading: true, error: '' };
		const res = await loadFieldOptions(opts.api, entry.field);
		if (!optionsGate.isCurrent(token)) return;
		if (res.ok) fieldOptions.value = res.data;
		optionsState.value = { loading: false, error: res.ok ? '' : res.message };
	}

	/** Opens the dialog for a menu entry on the rows ticked now. Restrict and Unrestrict have no target, so their preview starts at once. */
	function open(entry: BulkEntry): void {
		if (entry.kind === 'print') return;
		dialog.value = { entry, ids: [...opts.picked.value], choice: null };
		applyError.value = '';
		preview.value = IDLE;
		void loadOptions(entry);
		void runPreview();
	}

	function close(): void {
		previewGate.cancel();
		optionsGate.cancel();
		dialog.value = null;
		preview.value = IDLE;
		applyError.value = '';
	}

	/** The target step's answer (a field value; null clears the field). Asks for a fresh preview. */
	function choose(value: string | boolean | null, label?: string): void {
		if (!dialog.value) return;
		dialog.value = { ...dialog.value, choice: { value }, choiceLabel: label };
		applyError.value = '';
		void runPreview();
	}

	const counts = computed(() => previewCounts(preview.value.rows ?? []));
	const summary = computed(() => (preview.value.rows ? previewSummary(counts.value) : ''));
	const skipGroups = computed(() => groupSkips(previewSkips(preview.value.rows ?? [])));
	const warnings = computed(() => previewWarnings(preview.value.rows ?? []));
	const ready = computed(() => !!preview.value.rows && !preview.value.loading && canApply(counts.value) && !applying.value);

	// ---- apply and the toasts ----------------------------------------------------------------------------------------

	async function apply(): Promise<void> {
		const d = dialog.value;
		if (!d || !ready.value) return;
		const params = paramsFor(d.entry, d.choice);
		if (!params) return;
		applying.value = true;
		applyError.value = '';
		const res = await applyBulk(opts.api, opts.def.collection, d.entry.kind as BulkKind, d.ids, params);
		applying.value = false;
		if (!res.ok) {
			if (dialog.value === d) applyError.value = res.message;
			return;
		}
		// Applied is applied: the toast is made whether or not the dialog is still open.
		const { actionId, undoUntil, results } = res.data;
		const applied = results.filter((r) => r.outcome === 'applied').length;
		const skipped = applySkips(results);
		const at = now();
		codes.set(actionId, new Map(results.map((r) => [r.id, r.code])));
		toasts.value = [...toasts.value, startToast(actionId, resultText(d.entry, opts.def, applied, d.choice, d.choiceLabel), deadlineFor(undoUntil, at), skipped, at)];
		if (dialog.value === d) close();
		afterChange();
		opts.onChanged(skipped.map((r) => r.id));
	}

	const find = (actionId: string): ToastModel | undefined => toasts.value.find((t) => t.actionId === actionId);
	function replace(next: ToastModel): void {
		toasts.value = toasts.value.map((t) => (t.actionId === next.actionId ? next : t));
		afterChange();
	}

	async function undo(actionId: string): Promise<void> {
		const t = find(actionId);
		if (!t) return;
		const busy = beginUndo(t);
		if (busy === t) return;
		replace(busy);
		const res = await undoBulk(opts.api, actionId);
		const cur = find(actionId);
		if (!res.ok) {
			if (cur) replace(undoFailed(cur, res.message, now()));
			return;
		}
		if (cur) replace(undoDone(cur, res.data.results, codes.get(actionId) ?? new Map()));
		opts.onChanged(notRevertedIds(res.data.results));
	}

	function dismiss(actionId: string): void {
		const timer = dismissTimers.get(actionId);
		if (timer) clearTimeout(timer);
		dismissTimers.delete(actionId);
		codes.delete(actionId);
		toasts.value = toasts.value.filter((t) => t.actionId !== actionId);
		afterChange();
	}

	// One clock for every toast while any is counting down; a finished toast with nothing to read goes by itself.
	function afterChange(): void {
		const pending = toasts.value.some((t) => t.phase === 'pending');
		if (pending && !clock) {
			clock = setInterval(() => {
				toasts.value = toasts.value.map((t) => tickToast(t, now()));
				afterChange();
			}, 1000);
		} else if (!pending && clock) {
			clearInterval(clock);
			clock = null;
		}
		for (const t of toasts.value) {
			const delay = dismissDelay(t);
			if (delay !== null && !dismissTimers.has(t.actionId)) dismissTimers.set(t.actionId, setTimeout(() => dismiss(t.actionId), delay));
		}
	}

	onScopeDispose(() => {
		previewGate.cancel();
		optionsGate.cancel();
		if (clock) clearInterval(clock);
		for (const timer of dismissTimers.values()) clearTimeout(timer);
	});

	return {
		dialog, preview, applying, applyError, fieldOptions, optionsState, toasts, counts, summary, skipGroups, warnings, ready,
		open, close, choose, apply, undo, dismiss,
	};
}

/** What `reactive(useBulkActions(...))` hands the components: the refs read as plain values. */
export type BulkState = UnwrapNestedRefs<ReturnType<typeof useBulkActions>>;
