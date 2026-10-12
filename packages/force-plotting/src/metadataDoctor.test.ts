import { describe, expect, it } from 'vitest';
import { CROP_COVERAGE_MIN, diagnose, activeFindings, worstSeverity } from './metadataDoctor';

// A `machining_force_analysis` row with `operation_id` expanded — the shape both of
// ForceDashboard's queries already return. Defaults are a clean row: coverage 0.8, every
// paired field unset on BOTH sides (so no check fires), sample linked.
function row(over: Record<string, unknown> = {}, op: Record<string, unknown> = {}) {
	return {
		id: 'r1',
		status: 'done',
		n_raw: 1000,
		cut_start_idx: 100,
		cut_end_idx: 900,
		crop_start_idx_override: null,
		crop_end_idx_override: null,
		feed: null,
		depth_of_cut: null,
		surface_speed: null,
		cut_diameter: null,
		outer_diameter: null,
		trigger_time: null,
		doctor_dismissed: null,
		...over,
		operation_id: {
			operation_id: 'o1',
			pass_code: 'S-F1',
			operation_date: null,
			process_category: 'machining',
			operation_sequence: 1,
			machining_operation_subtype: 'F',
			machining_feed_mm_per_rev: null,
			machining_axial_depth_of_cut_mm: null,
			machining_cutting_speed_m_per_min: null,
			machining_workpiece_diameter_mm: null,
			sample_id: { sample_id: 's1', sample_code: 'S' },
			...op,
		},
	};
}

const ids = (r: unknown, optional?: string[]) => activeFindings(diagnose(r, optional)).map((f) => f.id).sort();

describe('diagnose / clean row', () => {
	it('reports nothing when both sides are unset and the crop is generous', () => {
		expect(diagnose(row())).toEqual([]);
	});
});

describe('diagnose / conflict vs missing', () => {
	it('flags a conflict when both sides are set and disagree', () => {
		const f = activeFindings(diagnose(row({ feed: 0.05 }, { machining_feed_mm_per_rev: 0.1 })));
		expect(f.map((x) => x.id)).toEqual(['conflict.feed']);
		expect(f[0].severity).toBe('error');
		expect(f[0].matValue).toBe(0.05);
		expect(f[0].dbValue).toBe(0.1);
		expect(f[0].field).toBe('machining_feed_mm_per_rev');
		expect(f[0].fix).toBe('adopt');
	});

	it('does not flag a conflict when the two sides agree within tolerance', () => {
		expect(ids(row({ feed: 0.05 }, { machining_feed_mm_per_rev: 0.05 }))).toEqual([]);
		// NUMERIC(8,4) round-trip noise must not register.
		expect(ids(row({ feed: 0.05 }, { machining_feed_mm_per_rev: 0.05000001 }))).toEqual([]);
	});

	it('flags a backfill (not a conflict) when the DB side is null', () => {
		const f = activeFindings(diagnose(row({ depth_of_cut: 0.2 })));
		expect(f.map((x) => x.id)).toEqual(['missing.doc']);
		expect(f[0].severity).toBe('info');
		expect(f[0].fix).toBe('adopt');
	});

	// Guards the null-vs-0 masking class of bug that commit 08e33c2 already fixed once in this
	// area: `null` is "never recorded", `0` is "recorded as zero". They are not the same value.
	it('never treats null as 0', () => {
		// DB records an explicit 0, .mat never recorded it -> nothing to compare.
		expect(ids(row({ feed: null }, { machining_feed_mm_per_rev: 0 }))).toEqual([]);
		// .mat records an explicit 0, DB is null -> a real backfill candidate.
		expect(ids(row({ feed: 0 }))).toEqual(['missing.feed']);
		// Both recorded, one 0 and one not -> a real conflict, not "equal because both falsy".
		expect(ids(row({ feed: 0 }, { machining_feed_mm_per_rev: 0.1 }))).toEqual(['conflict.feed']);
	});

	it('covers all four paired fields', () => {
		expect(ids(row(
			{ feed: 0.05, depth_of_cut: 0.2, surface_speed: 30, cut_diameter: 80 },
			{
				machining_feed_mm_per_rev: 0.1,
				machining_axial_depth_of_cut_mm: 0.3,
				machining_cutting_speed_m_per_min: 60,
				machining_workpiece_diameter_mm: 565,
			},
		))).toEqual(['conflict.diam', 'conflict.doc', 'conflict.feed', 'conflict.vc']);
	});

	// outer_diameter is the D1 override that exists BECAUSE CutDiameter is documented as
	// frequently wrong, and process_force.m uses it for the spiral geometry. Setting it IS the
	// correction, so re-flagging the pair would report work that is already done.
	it('suppresses conflict.diam once an outer_diameter override is recorded', () => {
		const over = { cut_diameter: 8, outer_diameter: 8 };
		expect(ids(row(over, { machining_workpiece_diameter_mm: 80 }))).toEqual([]);
		expect(ids(row({ cut_diameter: 8 }, { machining_workpiece_diameter_mm: 80 })))
			.toEqual(['conflict.diam']);
	});
});

describe('diagnose / crop coverage', () => {
	// cut_end_idx is derived from Feed+Diameter spiral geometry (process_force.m), not from where
	// the force signal ends -- so a short window is evidence the metadata is wrong.
	it('fires below the threshold and not at or above it', () => {
		expect(CROP_COVERAGE_MIN).toBe(0.6);
		expect(ids(row({ n_raw: 1000, cut_start_idx: 0, cut_end_idx: 599 }))).toEqual(['crop.coverage']);
		expect(ids(row({ n_raw: 1000, cut_start_idx: 0, cut_end_idx: 600 }))).toEqual([]);
		expect(ids(row({ n_raw: 1000, cut_start_idx: 0, cut_end_idx: 601 }))).toEqual([]);
	});

	it('names Feed or Diameter as the likely cause', () => {
		const f = activeFindings(diagnose(row({ n_raw: 1000, cut_start_idx: 0, cut_end_idx: 100 })))[0];
		expect(f.severity).toBe('warn');
		expect(f.fix).toBe('crop');
		expect(f.detail).toMatch(/feed/i);
		expect(f.detail).toMatch(/diameter/i);
	});

	it('self-suppresses once a human has saved a crop override', () => {
		expect(ids(row({ n_raw: 1000, cut_start_idx: 0, cut_end_idx: 100, crop_start_idx_override: 0 })))
			.toEqual([]);
	});

	it('stays silent when the crop indices are missing', () => {
		expect(ids(row({ cut_start_idx: null, cut_end_idx: null }))).toEqual([]);
		expect(ids(row({ n_raw: null }))).toEqual([]);
		expect(ids(row({ n_raw: 0 }))).toEqual([]);
	});
});

describe('diagnose / sample link', () => {
	it('flags an unlinked operation', () => {
		const f = activeFindings(diagnose(row({}, { sample_id: null })));
		expect(f.map((x) => x.id)).toEqual(['link.sample']);
		expect(f[0].severity).toBe('warn');
	});
});

describe('diagnose / optional checks', () => {
	const stale = () => row({}, { pass_code: 'WRONG-F1' });

	it('leaves date.trigger off by default', () => {
		expect(ids(stale())).toEqual([]);
		expect(ids(row({ trigger_time: '2024-01-01T00:00:00Z' }, { operation_date: '2020-05-05' })))
			.toEqual([]);
	});

	// The database builds and owns the operation code now, so the dashboard no longer second-guesses
	// it: asking for the retired check is ignored.
	it('ignores a request for the retired name.stale check', () => {
		expect(ids(stale(), ['name.stale'])).toEqual([]);
		expect(ids(row(), ['name.stale'])).toEqual([]);
	});

	it('runs date.trigger when enabled, tolerating a same-day difference', () => {
		expect(ids(row({ trigger_time: '2024-01-01T09:00:00Z' }, { operation_date: '2020-05-05' }), ['date.trigger']))
			.toEqual(['date.trigger']);
		expect(ids(row({ trigger_time: '2024-01-01T09:00:00Z' }, { operation_date: '2024-01-01' }), ['date.trigger']))
			.toEqual([]);
		expect(ids(row({ trigger_time: null }, { operation_date: '2024-01-01' }), ['date.trigger'])).toEqual([]);
	});
});

describe('diagnose / dismissals', () => {
	const conflicting = (dismissed: unknown) =>
		row({ feed: 0.05, doctor_dismissed: dismissed }, { machining_feed_mm_per_rev: 0.1 });

	it('suppresses a finding whose signature still matches', () => {
		const sig = diagnose(conflicting(null))[0].sig;
		const f = diagnose(conflicting({ 'conflict.feed': { sig, at: '2026-09-13T00:00:00Z', by: 'u1' } }));
		expect(f).toHaveLength(1);
		expect(f[0].dismissed).toBe(true);
		expect(activeFindings(f)).toEqual([]);
	});

	// The whole point of storing `sig`: a dismissal must not outlive the values it was made about.
	it('lets the finding return once the compared values change', () => {
		const sig = diagnose(conflicting(null))[0].sig;
		const moved = row(
			{ feed: 0.07, doctor_dismissed: { 'conflict.feed': { sig, at: 'x', by: 'u1' } } },
			{ machining_feed_mm_per_rev: 0.1 },
		);
		expect(ids(moved)).toEqual(['conflict.feed']);
	});

	it('ignores a dismissal recorded against a different check', () => {
		const f = diagnose(conflicting({ 'crop.coverage': { sig: 'whatever', at: 'x', by: 'u1' } }));
		expect(activeFindings(f).map((x) => x.id)).toEqual(['conflict.feed']);
	});
});

describe('worstSeverity', () => {
	it('ranks error over warn over info and ignores dismissed findings', () => {
		expect(worstSeverity(diagnose(row()))).toBeNull();
		expect(worstSeverity(diagnose(row({ depth_of_cut: 0.2 })))).toBe('info');
		expect(worstSeverity(diagnose(row({}, { sample_id: null })))).toBe('warn');
		expect(worstSeverity(diagnose(row({ feed: 0.05 }, { machining_feed_mm_per_rev: 0.1 })))).toBe('error');

		const conflict = diagnose(row({ feed: 0.05 }, { machining_feed_mm_per_rev: 0.1 }));
		const dismissed = diagnose(row(
			{ feed: 0.05, doctor_dismissed: { 'conflict.feed': { sig: conflict[0].sig, at: 'x', by: 'u' } }, depth_of_cut: 0.2 },
			{ machining_feed_mm_per_rev: 0.1 },
		));
		expect(worstSeverity(dismissed)).toBe('info');
	});
});

// Real rows pulled from the live DB while this feature was designed. They pin the checks to data
// that actually exists rather than to invented numbers.
describe('diagnose / real archive rows', () => {
	it('11-RK-MO-2023-10-16-O3: four backfills, generous crop, no name check', () => {
		const r = row(
			{ n_raw: 519680, cut_start_idx: 173500, cut_end_idx: 519680,
				feed: 0.1, depth_of_cut: 0.1, surface_speed: 100, cut_diameter: 51.5 },
			{ pass_code: '11-RK-MO-2023-10-16-O3-100MPM_0.1feed_0.25DoC',
				machining_operation_subtype: null, operation_sequence: 3,
				sample_id: { sample_id: 's', sample_code: '11-RK-MO-2023-10-16' } },
		);
		// coverage = (519680-173500)/519680 = 0.666 -> above threshold, no crop finding.
		expect(ids(r)).toEqual(['missing.diam', 'missing.doc', 'missing.feed', 'missing.vc']);
	});

	it('10-AA-MF-2023-3-31-F25: bad crop, and the diameter conflict is already overridden', () => {
		const r = row(
			{ n_raw: 5864960, cut_start_idx: 742600, cut_end_idx: 1708402,
				feed: 0.05, depth_of_cut: 0.05, surface_speed: 30, cut_diameter: 8, outer_diameter: 8 },
			{ pass_code: '10-AA-MF-2023-3-31-F25-30MPM_0.05feed_0.05DoC',
				machining_operation_subtype: 'MT-F', operation_sequence: 25,
				machining_feed_mm_per_rev: 0.05, machining_axial_depth_of_cut_mm: 0.05,
				machining_cutting_speed_m_per_min: 30, machining_workpiece_diameter_mm: 80,
				sample_id: { sample_id: 's', sample_code: '10-AA-MF-2023-3-31' } },
		);
		// coverage = 0.165. The 8-vs-80 diameter disagreement is suppressed by outer_diameter=8.
		expect(ids(r)).toEqual(['crop.coverage']);
	});

	// The Oe565 facing disc. Under constant-surface-speed, pi*D*mean_rpm/1000 reads 614 against a
	// recorded Vc of 30 -- which is why no Vc/diameter/rpm physics check exists. This row must
	// report the bad crop and NOTHING about surface speed.
	it('122-AA-MM-2025-6-5-F11: bad crop only, no physics finding', () => {
		const r = row(
			{ n_raw: 182922240, cut_start_idx: 155214000, cut_end_idx: 175009539,
				feed: 0.1, depth_of_cut: 0.1, surface_speed: 30, cut_diameter: 565, max_rpm: 500, mean_rpm: 345.8 },
			{ pass_code: '122-AA-MM-2025-6-5-F11-30MPM_0.1feed_0.1DoC',
				machining_operation_subtype: 'MT-F', operation_sequence: 11,
				machining_feed_mm_per_rev: 0.1, machining_axial_depth_of_cut_mm: 0.1,
				machining_cutting_speed_m_per_min: 30, machining_workpiece_diameter_mm: 565,
				sample_id: { sample_id: 's', sample_code: '122-AA-MM-2025-6-2' } },
		);
		expect(ids(r)).toEqual(['crop.coverage']);
		expect(activeFindings(diagnose(r)).every((f) => !/speed|rpm/i.test(f.id))).toBe(true);
	});

	// Same operation, second .mat: the sample code is 122-AA-MM-2025-6-2 while the name says -6-5,
	// the documented stale-SampleName case. The retired name check no longer reports it.
	it('122-AA-MM-2025-6-5-F11 second file: conflict, backfills, bad crop', () => {
		const r = row(
			{ n_raw: 182922240, cut_start_idx: 155214000, cut_end_idx: 158113316,
				feed: 0.1, depth_of_cut: null, surface_speed: null, cut_diameter: 80 },
			{ pass_code: '122-AA-MM-2025-6-5-F11-30MPM_0.1feed_0.1DoC',
				machining_operation_subtype: 'MT-F', operation_sequence: 11,
				machining_feed_mm_per_rev: 0.1, machining_axial_depth_of_cut_mm: 0.1,
				machining_cutting_speed_m_per_min: 30, machining_workpiece_diameter_mm: 565,
				sample_id: { sample_id: 's', sample_code: '122-AA-MM-2025-6-2' } },
		);
		expect(ids(r)).toEqual(['conflict.diam', 'crop.coverage']);
		expect(worstSeverity(diagnose(r))).toBe('error');
	});
});
