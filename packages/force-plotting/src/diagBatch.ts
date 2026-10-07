// "Apply recipe to selected": the pure half. `buildPatch` is THE request body a diagnostics build
// sends (PATCH /items/machining_force_analysis/:id), shared by the single Build / Bake button and
// the batch so the two cannot drift. `planBatch` decides, per selected cut, whether to queue,
// skip or refuse; `runBatch` walks the plan sequentially with a cancel check between items and
// returns the summary. The host orchestrator is the real queue (it claims 'pending' rows one at
// a time), so queueing is just that PATCH -- see
// docs/superpowers/specs/2026-10-06-diagnostics-campaign-design.md.
import { DEFAULT_RECIPE, recipesEquivalent, type Recipe } from './recipeChannels';
import type { DiagState } from './diagPicker';
import { validateRecipe } from './recipeIo';

/** Body of a build request. A Bake / batch carries the recipe (persisted so process_diag_row
 *  bakes it and the stored hash reflects it); a plain Build / Retry omits it and leaves
 *  diag_recipe untouched (NULL = the built-in default). */
export function buildPatch(recipe?: Recipe, now: Date = new Date()): Record<string, unknown> {
	const patch: Record<string, unknown> = { diag_status: 'pending', diag_requested_at: now.toISOString() };
	if (recipe) patch.diag_recipe = recipe;
	return patch;
}

export interface BatchRow {
	id: string;
	code: string;
	diag_status: DiagState;
	diag_path: string | null;
	diag_recipe: Recipe | null;
}

export type BatchAction = 'queue' | 'skip' | 'refuse';

export interface BatchItem {
	id: string;
	code: string;
	action: BatchAction;
	/** Why it is skipped or refused; empty for 'queue'. */
	reason: string;
}

export interface BatchOptions {
	/** Rebuild cuts already built with the same recipe. Off by default (idempotent). */
	rebuild?: boolean;
}

/** Same-recipe test used for idempotency. The authoritative `diag_recipe_hash` is computed in
 *  Python over the recipe's canonical JSON; recipesEquivalent compares exactly the identity-
 *  bearing parts (enabled steps' op / params / inputs), without reproducing Python's bytes. */
export function builtWithRecipe(row: BatchRow, recipe: Recipe): boolean {
	return row.diag_status === 'done' && !!row.diag_path
		&& recipesEquivalent(row.diag_recipe ?? DEFAULT_RECIPE, recipe);
}

export function planBatch(rows: BatchRow[], recipe: Recipe, opts: BatchOptions = {}): BatchItem[] {
	const bad = validateRecipe(recipe);
	return rows.map((r): BatchItem => {
		const item = (action: BatchAction, reason = ''): BatchItem => ({ id: r.id, code: r.code, action, reason });
		if (bad) return item('refuse', `recipe is not runnable: ${bad}`);
		if (r.diag_status === 'processing') return item('skip', 'already being analysed on the host');
		if (r.diag_status === 'pending') return item('skip', 'already queued');
		if (!opts.rebuild && builtWithRecipe(r, recipe)) return item('skip', 'already built with this recipe');
		return item('queue');
	});
}

export interface BatchSummary {
	queued: BatchItem[];
	skipped: BatchItem[];
	/** Planned refusals plus requests the server refused (reason says which). */
	refused: BatchItem[];
	/** Queue items never attempted because the run was cancelled or stopped. */
	notRun: BatchItem[];
	cancelled: boolean;
}

export interface BatchProgress { done: number; total: number; current: string | null }

export interface RunBatchArgs {
	plan: BatchItem[];
	recipe: Recipe;
	/** Makes the single-build request: PATCH the analysis row with `patch`. */
	request: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
	shouldCancel?: () => boolean;
	onProgress?: (p: BatchProgress) => void;
	now?: () => Date;
}

function refusalReason(e: unknown): { reason: string; fatal: boolean } {
	const x = e as { response?: { status?: number }; message?: string };
	if (x?.response?.status === 403) return { reason: "your role can't request builds", fatal: true };
	return { reason: x?.message || 'request failed', fatal: false };
}

/** Sequential on purpose: the host runs one bake at a time, and a cancel or a 403 should stop
 *  the very next request, not after a burst. A 403 stops the run (every later item would be
 *  refused the same way: the role can't update analysis rows). */
export async function runBatch(a: RunBatchArgs): Promise<BatchSummary> {
	const out: BatchSummary = { queued: [], skipped: [], refused: [], notRun: [], cancelled: false };
	const todo = a.plan.filter((i) => i.action === 'queue');
	for (const i of a.plan) {
		if (i.action === 'skip') out.skipped.push(i);
		else if (i.action === 'refuse') out.refused.push(i);
	}
	let stopped = false;
	for (let n = 0; n < todo.length; n++) {
		const item = todo[n];
		if (stopped || a.shouldCancel?.()) {
			if (!stopped) { out.cancelled = true; stopped = true; }
			out.notRun.push(item);
			continue;
		}
		a.onProgress?.({ done: n, total: todo.length, current: item.code });
		try {
			await a.request(item.id, buildPatch(a.recipe, a.now?.()));
			out.queued.push(item);
		} catch (e) {
			const { reason, fatal } = refusalReason(e);
			out.refused.push({ ...item, action: 'refuse', reason });
			if (fatal) stopped = true;
		}
	}
	a.onProgress?.({ done: todo.length, total: todo.length, current: null });
	return out;
}

/** One-line summary for the result banner. */
export function summaryLine(s: BatchSummary): string {
	const parts = [`${s.queued.length} queued`];
	if (s.skipped.length) parts.push(`${s.skipped.length} skipped`);
	if (s.refused.length) parts.push(`${s.refused.length} refused`);
	if (s.notRun.length) parts.push(`${s.notRun.length} not run${s.cancelled ? ' (cancelled)' : ''}`);
	return parts.join(', ');
}
