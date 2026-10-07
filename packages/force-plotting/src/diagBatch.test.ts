import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RECIPE, type Recipe } from './recipeChannels';
import { buildPatch, builtWithRecipe, planBatch, runBatch, summaryLine, type BatchRow } from './diagBatch';

const clone = (r: Recipe): Recipe => JSON.parse(JSON.stringify(r));
const tuned = clone(DEFAULT_RECIPE);
tuned.steps[4].params.k = 40;

function row(id: string, o: Partial<BatchRow> = {}): BatchRow {
	return { id, code: `P-${id}`, diag_status: null, diag_path: null, diag_recipe: null, ...o };
}
const built = (id: string, recipe: Recipe | null) => row(id, { diag_status: 'done', diag_path: 'p', diag_recipe: recipe });

describe('buildPatch', () => {
	const now = new Date('2026-10-06T10:00:00Z');
	it('matches the single Bake request (pending + timestamp + recipe)', () => {
		expect(buildPatch(tuned, now)).toEqual({
			diag_status: 'pending', diag_requested_at: '2026-10-06T10:00:00.000Z', diag_recipe: tuned,
		});
	});
	it('leaves diag_recipe out for a plain Build / Retry', () => {
		expect(buildPatch(undefined, now)).toEqual({ diag_status: 'pending', diag_requested_at: '2026-10-06T10:00:00.000Z' });
	});
});

describe('planBatch', () => {
	it('queues unbuilt, errored and differently-baked cuts', () => {
		const plan = planBatch([row('a'), row('b', { diag_status: 'error' }), built('c', DEFAULT_RECIPE)], tuned);
		expect(plan.map((p) => p.action)).toEqual(['queue', 'queue', 'queue']);
	});
	it('skips a cut already built with an equivalent recipe (NULL recipe = default)', () => {
		const plan = planBatch([built('a', null), built('b', clone(tuned)), built('c', tuned)], DEFAULT_RECIPE);
		expect(plan.map((p) => p.action)).toEqual(['skip', 'queue', 'queue']);
		expect(plan[0].reason).toMatch(/already built/);
	});
	it('ignores step ids and disabled steps when comparing', () => {
		const other = clone(DEFAULT_RECIPE);
		other.steps[0].id = 'zz';
		other.steps[6].params.bandwidth_frac = 0.9; // envelope is off
		expect(builtWithRecipe(built('a', other), DEFAULT_RECIPE)).toBe(true);
	});
	it('rebuilds already-built cuts only when asked', () => {
		const rows = [built('a', null)];
		expect(planBatch(rows, DEFAULT_RECIPE, { rebuild: true })[0].action).toBe('queue');
	});
	it('a done row with no diag_path is not "built"', () => {
		expect(planBatch([row('a', { diag_status: 'done', diag_recipe: null })], DEFAULT_RECIPE)[0].action).toBe('queue');
	});
	it('skips queued and processing cuts even when rebuilding', () => {
		const plan = planBatch([row('a', { diag_status: 'pending' }), row('b', { diag_status: 'processing' })], tuned, { rebuild: true });
		expect(plan.map((p) => p.action)).toEqual(['skip', 'skip']);
		expect(plan[0].reason).toMatch(/queued/);
	});
	it('refuses everything for an unrunnable recipe, with the reason', () => {
		const r = clone(DEFAULT_RECIPE);
		r.steps[3].on = false;
		const plan = planBatch([row('a'), built('b', null)], r);
		expect(plan.every((p) => p.action === 'refuse')).toBe(true);
		expect(plan[0].reason).toMatch(/not runnable/);
	});
});

describe('runBatch', () => {
	const plan = () => planBatch([row('a'), built('b', null), row('c'), row('d')], DEFAULT_RECIPE);

	it('requests each queued cut in order with the shared patch and summarises', async () => {
		const calls: string[] = [];
		const request = vi.fn(async (id: string, patch: Record<string, unknown>) => {
			calls.push(id);
			expect(patch).toMatchObject({ diag_status: 'pending', diag_recipe: DEFAULT_RECIPE });
		});
		const progress: number[] = [];
		const s = await runBatch({ plan: plan(), recipe: DEFAULT_RECIPE, request, onProgress: (p) => progress.push(p.done) });
		expect(calls).toEqual(['a', 'c', 'd']);
		expect(s.queued.map((i) => i.id)).toEqual(['a', 'c', 'd']);
		expect(s.skipped.map((i) => i.id)).toEqual(['b']);
		expect(progress).toEqual([0, 1, 2, 3]);
		expect(summaryLine(s)).toBe('3 queued, 1 skipped');
	});
	it('stops between items on cancel and reports the rest as not run', async () => {
		let n = 0;
		const request = vi.fn(async () => { n++; });
		const s = await runBatch({ plan: plan(), recipe: DEFAULT_RECIPE, request, shouldCancel: () => n >= 1 });
		expect(request).toHaveBeenCalledTimes(1);
		expect(s.cancelled).toBe(true);
		expect(s.queued.map((i) => i.id)).toEqual(['a']);
		expect(s.notRun.map((i) => i.id)).toEqual(['c', 'd']);
		expect(summaryLine(s)).toBe('1 queued, 1 skipped, 2 not run (cancelled)');
	});
	it('records a server refusal and carries on', async () => {
		const request = vi.fn(async (id: string) => { if (id === 'a') throw new Error('boom'); });
		const s = await runBatch({ plan: plan(), recipe: DEFAULT_RECIPE, request });
		expect(s.refused).toEqual([expect.objectContaining({ id: 'a', reason: 'boom' })]);
		expect(s.queued.map((i) => i.id)).toEqual(['c', 'd']);
	});
	it('stops on 403 (the role cannot request builds) instead of refusing every row separately', async () => {
		const request = vi.fn(async () => { throw Object.assign(new Error('x'), { response: { status: 403 } }); });
		const s = await runBatch({ plan: plan(), recipe: DEFAULT_RECIPE, request });
		expect(request).toHaveBeenCalledTimes(1);
		expect(s.refused[0].reason).toMatch(/your role can't request builds/);
		expect(s.notRun.map((i) => i.id)).toEqual(['c', 'd']);
		expect(s.cancelled).toBe(false);
	});
	it('makes no requests when everything is skipped or refused', async () => {
		const request = vi.fn();
		const s = await runBatch({ plan: planBatch([built('a', null)], DEFAULT_RECIPE), recipe: DEFAULT_RECIPE, request });
		expect(request).not.toHaveBeenCalled();
		expect(s.queued).toEqual([]);
	});
});
