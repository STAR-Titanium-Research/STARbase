// Metadata Doctor — consistency checks for a force-capture operation.
//
// Two records describe the same cut and can silently disagree:
//   * `machining_force_analysis` — the .mat file's own `metadata` struct, extracted read-only by
//     scripts/matlab/process_force.m (feed, depth_of_cut, surface_speed, cut_diameter, …);
//   * `manufacturing_operations.machining_*` — the D1 record (the database builds the operation
//     name, `pass_code`, from these itself; the dashboard no longer checks or writes it).
//
// This module is pure and framework-agnostic: it takes one
// already-fetched row and returns findings. It performs no I/O and knows nothing about Vue, the
// API, or how a fix is applied — every surface (the list's severity dot, the Doctor panel) is a
// view over the same `diagnose()` output, so a check is defined exactly once.
//
// NOTE: there is deliberately NO surface-speed/diameter/rpm physics check. `Vc = pi*D*rpm/1000`
// holds only at one radius, and these are facing cuts under constant-surface-speed where rpm ramps
// as the tool moves inward — it flags 129 of 189 archive rows and means nothing. `crop.coverage`
// below captures the same "Feed or Diameter is wrong" signal without the CSS assumption.

/** Crop windows covering less than this fraction of the recording are flagged. */
export const CROP_COVERAGE_MIN = 0.6;

/** A day, in ms — the tolerance for the optional trigger_time/operation_date check. */
const ONE_DAY_MS = 86_400_000;

export type DoctorSeverity = 'error' | 'warn' | 'info';

/** What a surface can offer to do about a finding. `crop` has no auto-fix — it opens the editor. */
export type DoctorFix = 'adopt' | 'crop' | 'link';

export interface Finding {
	/** Stable check id, e.g. `conflict.feed`. Also the key a dismissal is recorded under. */
	id: string;
	severity: DoctorSeverity;
	/** Short label for a list row. */
	title: string;
	/** One sentence naming the problem, including the numbers. */
	detail: string;
	/** The .mat side of a compared pair, when the check compares one. */
	matValue?: number | string | null;
	/** The D1 side of a compared pair, when the check compares one. */
	dbValue?: number | string | null;
	/** `manufacturing_operations` column an `adopt` fix writes. */
	field?: string;
	fix?: DoctorFix;
	/**
	 * Deterministic signature of the values this finding compared. A dismissal only suppresses a
	 * finding whose recomputed `sig` still matches, so muting cannot outlive the values it was
	 * made about — if they change, the finding returns.
	 */
	sig: string;
	/** False for the noisy checks, which a surface must opt into. */
	defaultOn: boolean;
	/** True when `doctor_dismissed` holds a matching signature for this check. */
	dismissed: boolean;
}

/** One dismissal as stored in `machining_force_analysis.doctor_dismissed`. */
export interface Dismissal {
	sig: string;
	at: string;
	by?: string | null;
}

interface Pair {
	key: string;
	label: string;
	unit: string;
	/** Column on `machining_force_analysis` (read out of the .mat). */
	mat: string;
	/** Column on `manufacturing_operations` (the D1 record). */
	db: string;
}

const PAIRS: Pair[] = [
	{ key: 'feed', label: 'Feed', unit: 'mm/rev', mat: 'feed', db: 'machining_feed_mm_per_rev' },
	{ key: 'doc', label: 'Depth of cut', unit: 'mm', mat: 'depth_of_cut', db: 'machining_axial_depth_of_cut_mm' },
	{ key: 'vc', label: 'Cutting speed', unit: 'm/min', mat: 'surface_speed', db: 'machining_cutting_speed_m_per_min' },
	{ key: 'diam', label: 'Diameter', unit: 'mm', mat: 'cut_diameter', db: 'machining_workpiece_diameter_mm' },
];

const SEVERITY_RANK: Record<DoctorSeverity, number> = { error: 3, warn: 2, info: 1 };

/**
 * Directus returns NUMERIC columns as strings, so every comparison has to coerce. `null`,
 * `undefined` and `''` mean "never recorded" and must NEVER collapse to 0 — an explicitly
 * recorded zero is a different fact (the null-vs-0 masking bug fixed in 08e33c2).
 */
function numOrNull(v: unknown): number | null {
	if (v === '' || v == null) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/**
 * Relative tolerance with a small absolute floor, so a value round-tripped through NUMERIC(8,4)
 * doesn't read as a conflict while a genuine 0.05-vs-0.1 disagreement does.
 */
function nearlyEqual(a: number, b: number): boolean {
	return Math.abs(a - b) <= 0.005 * Math.max(Math.abs(a), Math.abs(b), 0.01);
}

/** Trim trailing-zero noise for display: 0.0500 -> "0.05". */
function fmt(n: number): string {
	return String(parseFloat(n.toPrecision(6)));
}

function dismissalFor(row: any, id: string): Dismissal | null {
	const d = row?.doctor_dismissed;
	if (!d || typeof d !== 'object') return null;
	const entry = (d as Record<string, unknown>)[id];
	if (!entry || typeof entry !== 'object') return null;
	const sig = (entry as Dismissal).sig;
	return typeof sig === 'string' ? (entry as Dismissal) : null;
}

/**
 * Every consistency problem on one `machining_force_analysis` row (with `operation_id` expanded).
 * An empty array means the operation is internally consistent.
 *
 * `optional` opts into the default-off checks by id (`date.trigger`); the default-on
 * checks always run. Findings are returned including dismissed ones, each carrying `dismissed`, so
 * a surface can show and undo them — use `activeFindings()` for the ones that still need action.
 */
export function diagnose(row: any, optional?: Iterable<string>): Finding[] {
	if (!row) return [];
	const op = row.operation_id ?? null;
	const on = new Set(optional ?? []);
	const out: Finding[] = [];

	const push = (f: Omit<Finding, 'dismissed'>) => {
		const d = dismissalFor(row, f.id);
		out.push({ ...f, dismissed: d != null && d.sig === f.sig });
	};

	// ---- Sample link.
	const sample = op?.sample_id ?? null;
	if (op && !sample) {
		push({
			id: 'link.sample', severity: 'warn', title: 'Not linked to a sample',
			detail: 'This operation has no physical sample linked, so it will not group with the rest of the sample’s passes.',
			fix: 'link', sig: 'link:none', defaultOn: true,
		});
	}

	// ---- Paired fields: .mat vs D1.
	for (const p of PAIRS) {
		// outer_diameter is the D1 override that exists BECAUSE CutDiameter is documented as
		// frequently wrong, and process_force.m uses it for the spiral geometry. Setting it IS the
		// correction — re-flagging the pair would report work that is already done.
		if (p.key === 'diam' && numOrNull(row.outer_diameter) != null) continue;

		const matV = numOrNull(row[p.mat]);
		const dbV = numOrNull(op?.[p.db]);
		if (matV == null) continue;                       // nothing recorded in the .mat to compare

		if (dbV == null) {
			push({
				id: `missing.${p.key}`, severity: 'info', title: `${p.label} missing in D1`,
				detail: `The .mat records ${p.label.toLowerCase()} ${fmt(matV)} ${p.unit}, but the operation record has no value.`,
				matValue: matV, dbValue: null, field: p.db, fix: 'adopt',
				sig: `${p.key}:${fmt(matV)}|`, defaultOn: true,
			});
		} else if (!nearlyEqual(matV, dbV)) {
			push({
				id: `conflict.${p.key}`, severity: 'error', title: `${p.label} conflict`,
				detail: `The .mat records ${fmt(matV)} ${p.unit} but the operation record says ${fmt(dbV)} ${p.unit}.`,
				matValue: matV, dbValue: dbV, field: p.db, fix: 'adopt',
				sig: `${p.key}:${fmt(matV)}|${fmt(dbV)}`, defaultOn: true,
			});
		}
	}

	// ---- Crop coverage. cut_end_idx is NOT where the force signal ends: process_force.m integrates
	// the FRM spiral inward from Diam/2 at a rate set by Feed and rpm, and cutend is the first
	// sample where rho drops below the inner radius. The window length is therefore a function of
	// Feed and Diameter — which is why a short crop is evidence the metadata is wrong.
	// Self-suppresses once a human has saved a crop override: that is the review.
	const nRaw = numOrNull(row.n_raw);
	const cs = numOrNull(row.cut_start_idx);
	const ce = numOrNull(row.cut_end_idx);
	if (nRaw != null && nRaw > 0 && cs != null && ce != null && numOrNull(row.crop_start_idx_override) == null) {
		const coverage = (ce - cs) / nRaw;
		if (coverage < CROP_COVERAGE_MIN) {
			const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
			push({
				id: 'crop.coverage', severity: 'warn', title: 'Crop covers little of the recording',
				detail: `The cut window spans ${pct(coverage)} of the recording (samples ${cs}–${ce} of ${nRaw}). The window end is derived from Feed and Diameter, so a short one usually means one of those is wrong rather than that the cut was short.`,
				fix: 'crop', sig: `crop:${cs}|${ce}|${nRaw}`, defaultOn: true,
			});
		}
	}

	// ---- Optional: recording date vs operation date. Informational only — docs/force-file-standards
	// §7 records that dates in filenames and pass codes are frequently wrong, so a difference here
	// does not establish which side is at fault.
	if (on.has('date.trigger') && op) {
		const trig = row.trigger_time ? new Date(row.trigger_time) : null;
		const opDate = op.operation_date ? new Date(op.operation_date) : null;
		if (trig && opDate && !Number.isNaN(trig.getTime()) && !Number.isNaN(opDate.getTime())
			&& Math.abs(trig.getTime() - opDate.getTime()) > ONE_DAY_MS) {
			const iso = (d: Date) => d.toISOString().slice(0, 10);
			push({
				id: 'date.trigger', severity: 'info', title: 'Recording date differs from the operation date',
				detail: `The .mat was recorded ${iso(trig)} but the operation is dated ${iso(opDate)}.`,
				matValue: iso(trig), dbValue: iso(opDate),
				sig: `date:${iso(trig)}|${iso(opDate)}`, defaultOn: false,
			});
		}
	}

	return out;
}

/** The findings that still need action — everything `diagnose()` returned that isn't dismissed. */
export function activeFindings(findings: Finding[]): Finding[] {
	return findings.filter((f) => !f.dismissed);
}

/** Highest severity among the non-dismissed findings, or null when there is nothing to report. */
export function worstSeverity(findings: Finding[]): DoctorSeverity | null {
	let best: DoctorSeverity | null = null;
	for (const f of activeFindings(findings)) {
		if (!best || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best]) best = f.severity;
	}
	return best;
}
