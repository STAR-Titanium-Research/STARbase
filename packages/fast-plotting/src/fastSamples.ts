// The Samples -> Runs lists: group the FAST operations by their sample and narrow them by a sample and a
// search. Pure, so the rules are testable and the 10k-row list stays a cheap pass.

import type { Quality } from './fastMeta';

export interface RunRow {
	id: string;
	pass_code?: string | null;
	operation_date?: string | null;
	sintering_recipe_number?: string | null;
	/** The Conform run's feedstock, searched like the FAST recipe number. */
	conform_feedstock?: string | null;
	sample_id?: { sample_code?: string | null; nickname?: string | null; sample_id?: string | null } | null;
	material_id?: { common_name?: string | null } | null;
}
/** A row of the run list: the operation with what the list shows of its trace. */
export interface ListRun extends RunRow {
	sintering_max_temp_celsius?: number | null;
	sintering_max_force_kn?: number | null;
	quality: { level: Quality; label: string; hint: string };
}
export interface SampleGroup { key: string; code: string; sub: string; runs: number; }

/** Operations without a sample go under this key. */
export const NO_SAMPLE = '';

export const sampleKeyOf = (r: RunRow): string => r.sample_id?.sample_code || NO_SAMPLE;

/** One group per sample, in the order the newest run of each appears (rows are newest first). */
export function groupBySample(rows: RunRow[]): SampleGroup[] {
	const groups = new Map<string, SampleGroup>();
	for (const r of rows) {
		const key = sampleKeyOf(r);
		const g = groups.get(key);
		if (g) { g.runs++; continue; }
		const sub = [r.sample_id?.nickname, r.material_id?.common_name].filter((v) => v && String(v).trim()).join(' · ');
		groups.set(key, { key, code: key || 'No sample', sub, runs: 1 });
	}
	return [...groups.values()];
}

export function filterSamples(groups: SampleGroup[], query: string): SampleGroup[] {
	const q = query.trim().toLowerCase();
	return q ? groups.filter((g) => g.code.toLowerCase().includes(q) || g.sub.toLowerCase().includes(q)) : groups;
}

/** The runs of one sample (null: every sample) whose code, sample, recipe (FAST) or feedstock (Conform) contains the query. */
export function filterRuns<T extends RunRow>(rows: T[], sample: string | null, query: string): T[] {
	const q = query.trim().toLowerCase();
	if (sample === null && !q) return rows;
	return rows.filter((r) => (sample === null || sampleKeyOf(r) === sample)
		&& (!q || (r.pass_code || '').toLowerCase().includes(q)
			|| (r.sample_id?.sample_code || '').toLowerCase().includes(q)
			|| (r.sintering_recipe_number || '').toLowerCase().includes(q)
			|| (r.conform_feedstock || '').toLowerCase().includes(q)));
}
