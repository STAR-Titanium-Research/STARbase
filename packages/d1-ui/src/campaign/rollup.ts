// Pure roll-up logic for the campaign overview (no Vue, no network), unit tested with vitest.
// Moved from d1-campaign-ops/src/overview.js with its behaviour unchanged.
//
// Inputs are the rows the panel reads through the Directus API (so the user's permissions already
// applied): the campaign_samples junction, the campaign's operations, its test sessions and the
// machining_force_analysis rows of those operations. Design:
// docs/superpowers/specs/2026-10-06-sample-timeline-and-campaign-overview-design.md

// The test lifecycle (statuses, chip order, "done") is defined once in ../status.ts.
import { TEST_DONE_STATUSES } from '../status';

const worst = (s: string[]) => ['error', 'processing', 'pending'].find((k) => s.includes(k));

// One operation can have several force files (one machining_force_analysis row each). Roll the rows
// up to one state, worst first: error > processing > pending > done > skipped, 'none' when no rows.
export function analysisState(rows: any[] | null | undefined): string {
	const s = (rows ?? []).map((r) => r?.status).filter(Boolean);
	if (!s.length) return 'none';
	return worst(s) ?? (s.includes('done') ? 'done' : 'skipped');
}

// Same for the Diagnostics build (`diag_status`, null until someone requests a build). A row with
// no diag_status is an unbuilt file ('none'), so an operation is only 'done' when every one of its
// files is built: error > processing > pending > none (some file not built yet) > done. 'none' too
// when there are no rows at all. Rows that can never be built do not count against it: a file whose
// analysis was skipped, and one whose analysis errored without ever getting a diag_status (the
// analysis column already shows that error), so one built file plus one skipped file reads 'done'.
export function diagState(rows: any[] | null | undefined): string {
	const buildable = (rows ?? []).filter(
		(r) => r?.status !== 'skipped' && !(r?.status === 'error' && r?.diag_status == null),
	);
	const s = buildable.map((r) => r?.diag_status ?? 'none');
	if (!s.length) return 'none';
	return worst(s) ?? (s.includes('none') ? 'none' : 'done');
}

// Whether an operation is part of the "force analysed n / m" progress, given its rolled-up
// analysis state (see analysisState). Force analysis only applies to machining operations (and
// anything that already has a file), so the denominator is those, not every operation of an
// imaging campaign. An operation whose files were all skipped is deliberately not analysed and is
// left out as well, otherwise the bar could never reach 100%. One definition for the campaign
// overview and the Project page's campaign cards.
export const countsTowardForceProgress = (op: { process_category?: string | null }, state: string): boolean =>
	(op.process_category === 'machining' || state !== 'none') && state !== 'skipped';

const first = (rows: any[], field: string) => (rows ?? []).map((r) => r?.[field]).find(Boolean) ?? null;

// The id of a related item that may arrive as an expanded object ({ sample_id, sample_code }) or a
// bare id, or be null/absent when the caller cannot read it.
export const relId = (v: any, pk: string): string | null => (v && typeof v === 'object' ? (v[pk] ?? null) : (v ?? null));
export const relCode = (v: any): string | null => (v && typeof v === 'object' ? (v.sample_code ?? null) : null);

// Junction rows whose sample came back null: the row is visible through the campaign but the
// sample is not (row-level visibility, ADR-0011). The campaign cards count junction rows, so the
// page reports these to match, instead of showing fewer samples than the card says.
export const hiddenSampleCount = (junction: any[] | null | undefined): number =>
	(junction ?? []).filter((j) => j && relId(j.sample_id, 'sample_id') === null).length;

export interface OverviewInput {
	samples?: any[];
	operations?: any[];
	tests?: any[];
	analyses?: any[];
}

export function buildOverview({ samples = [], operations = [], tests = [], analyses = [] }: OverviewInput) {
	const byOp = new Map<string, any[]>();
	for (const a of analyses) {
		const k = relId(a.operation_id, 'operation_id');
		if (!k) continue;
		let list = byOp.get(k);
		if (!list) byOp.set(k, (list = []));
		list.push(a);
	}

	const opRows = operations.map((o) => {
		const rows = byOp.get(o.operation_id) ?? [];
		return {
			operation_id: o.operation_id,
			pass_code: o.pass_code ?? null,
			process_category: o.process_category ?? null,
			sample_id: relId(o.sample_id, 'sample_id'),
			sample_code: relCode(o.sample_id),
			analysis: analysisState(rows),
			analysis_error: first(rows.filter((r) => r.status === 'error'), 'error_message'),
			diag: diagState(rows),
			diag_error: first(rows.filter((r) => r.diag_status === 'error'), 'diag_error'),
		};
	});

	// Samples: the junction rows, plus any sample that only appears through an operation or test of
	// this campaign (flagged `member: false` so it can be added to the list).
	interface SampleRow {
		sample_id: string;
		sample_code: string | null;
		member: boolean;
		operations: number;
		tests: number;
	}
	const sampleMap = new Map<string, SampleRow>();
	const touch = (id: string | null, code: string | null, member: boolean): SampleRow | null => {
		if (!id) return null;
		let s = sampleMap.get(id);
		if (!s) {
			s = { sample_id: id, sample_code: code ?? null, member: false, operations: 0, tests: 0 };
			sampleMap.set(id, s);
		}
		if (code && !s.sample_code) s.sample_code = code;
		if (member) s.member = true;
		return s;
	};
	for (const j of samples) touch(relId(j.sample_id, 'sample_id'), relCode(j.sample_id), true);
	for (const o of opRows) {
		const s = touch(o.sample_id, o.sample_code, false);
		if (s) s.operations++;
	}
	const testRows = tests.map((t) => ({
		session_id: t.session_id,
		test_type: t.test_type ?? null,
		status: t.status ?? null,
		session_date: t.session_date ?? null,
		sample_id: relId(t.sample_id, 'sample_id'),
		sample_code: relCode(t.sample_id),
	}));
	for (const t of testRows) {
		const s = touch(t.sample_id, t.sample_code, false);
		if (s) s.tests++;
	}
	const sampleRows = [...sampleMap.values()].sort((a, b) =>
		String(a.sample_code ?? '').localeCompare(String(b.sample_code ?? ''), undefined, { numeric: true }),
	);

	const forceOps = opRows.filter((o) => countsTowardForceProgress(o, o.analysis));
	const countBy = (rows: any[], key: string) => {
		const out: Record<string, number> = {};
		for (const r of rows) {
			const k = r[key] ?? 'unknown';
			out[k] = (out[k] ?? 0) + 1;
		}
		return out;
	};
	const analysed = forceOps.filter((o) => o.analysis === 'done').length;
	const diagBuilt = forceOps.filter((o) => o.diag === 'done').length;
	const testsComplete = testRows.filter((t) => TEST_DONE_STATUSES.includes(t.status)).length;
	const pct = (n: number, d: number) => (d ? Math.round((100 * n) / d) : 0);

	return {
		counts: {
			samples: sampleRows.length,
			/** Junction rows whose sample the reader may not see: not in `samples`, but on the card count. */
			hiddenSamples: hiddenSampleCount(samples),
			operations: opRows.length,
			tests: testRows.length,
			testsByStatus: countBy(testRows, 'status'),
			analysisByState: countBy(forceOps, 'analysis'),
			diagByState: countBy(forceOps, 'diag'),
		},
		progress: {
			forceOps: forceOps.length,
			analysed,
			analysedPct: pct(analysed, forceOps.length),
			diagBuilt,
			diagBuiltPct: pct(diagBuilt, forceOps.length),
			testsComplete,
			testsCompletePct: pct(testsComplete, testRows.length),
		},
		sampleRows,
		opRows,
		testRows,
	};
}

export type Overview = ReturnType<typeof buildOverview>;
