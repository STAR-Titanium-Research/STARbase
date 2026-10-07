// Pure logic behind the Diagnostics page's operation picker: which state bucket a cut is in,
// the search + state-chip filter, grouping by sample or campaign, and the "show N at a time"
// window. No DOM and no host, so the grouping and filtering are unit-tested.

export type DiagState = 'done' | 'pending' | 'processing' | 'error' | null;

/** The three filter chips. 'building' rows (pending / processing) count as needs-build: nothing
 *  usable exists for them yet. */
export type PickerBucket = 'needs' | 'built' | 'error';

export interface PickerRow {
	id: string;
	diag_status: DiagState;
	diag_path: string | null;
	/** Pass code, falling back to the operation id. */
	code: string;
	operation_id: string | null;
	sample_id: string | null;
	sample_label: string | null;
	campaign_id: string | null;
	campaign_label: string | null;
}

export const BUCKETS: PickerBucket[] = ['needs', 'built', 'error'];
export const BUCKET_LABEL: Record<PickerBucket, string> = {
	needs: 'Needs build', built: 'Built', error: 'Error',
};

export function bucketOf(r: Pick<PickerRow, 'diag_status' | 'diag_path'>): PickerBucket {
	if (r.diag_status === 'error') return 'error';
	if (r.diag_status === 'done' && r.diag_path) return 'built';
	return 'needs';
}

export function countByBucket(rows: PickerRow[]): Record<PickerBucket, number> {
	const out: Record<PickerBucket, number> = { needs: 0, built: 0, error: 0 };
	for (const r of rows) out[bucketOf(r)]++;
	return out;
}

/** Case-insensitive match on every whitespace-separated term against code, operation, sample
 *  and campaign text. An empty `buckets` set means "all states". */
export function filterRows(rows: PickerRow[], query: string, buckets: ReadonlySet<PickerBucket>): PickerRow[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	return rows.filter((r) => {
		if (buckets.size && !buckets.has(bucketOf(r))) return false;
		if (!terms.length) return true;
		const hay = [r.code, r.operation_id, r.sample_label, r.campaign_label].filter(Boolean).join(' ').toLowerCase();
		return terms.every((t) => hay.includes(t));
	});
}

export type GroupBy = 'sample' | 'campaign';

export interface PickerGroup {
	key: string;
	label: string;
	/** The campaign a sample group sits in (sample grouping only), for the header. */
	sub: string | null;
	rows: PickerRow[];
}

export const NO_SAMPLE = 'No sample';
export const NO_CAMPAIGN = 'No campaign';

/** Groups keep first-seen order of the input (the page sorts newest first), except the
 *  "none" group, which goes last. Rows keep their input order inside a group. */
export function groupRows(rows: PickerRow[], by: GroupBy): PickerGroup[] {
	const map = new Map<string, PickerGroup>();
	for (const r of rows) {
		const key = (by === 'sample' ? r.sample_id : r.campaign_id) ?? '';
		let g = map.get(key);
		if (!g) {
			const none = by === 'sample' ? NO_SAMPLE : NO_CAMPAIGN;
			const label = key ? (by === 'sample' ? r.sample_label : r.campaign_label) || none : none;
			g = { key, label, sub: by === 'sample' ? r.campaign_label : null, rows: [] };
			map.set(key, g);
		}
		g.rows.push(r);
	}
	const groups = [...map.values()];
	return [...groups.filter((g) => g.key), ...groups.filter((g) => !g.key)];
}

/** Keep whole rows up to `limit` in total, cutting the last group short. `hidden` is how many
 *  rows were left out, for the "Show more" button. */
export function windowGroups(groups: PickerGroup[], limit: number): { groups: PickerGroup[]; hidden: number } {
	let left = Math.max(0, limit);
	const out: PickerGroup[] = [];
	let hidden = 0;
	for (const g of groups) {
		if (left <= 0) { hidden += g.rows.length; continue; }
		if (g.rows.length <= left) { out.push(g); left -= g.rows.length; continue; }
		out.push({ ...g, rows: g.rows.slice(0, left) });
		hidden += g.rows.length - left;
		left = 0;
	}
	return { groups: out, hidden };
}

export interface CampaignInfo { campaign_id: string; campaign_code?: string | null; name?: string | null }

/** The campaign of each row, as the picker wants it. The operation's `campaign_id` is requested as
 * the plain foreign key (a nested `campaign_id.*` read is a 403 for a role that cannot read the
 * campaigns table, which would empty the whole picker), and the campaign records come from a
 * separate query that is allowed to fail. `campaigns` null = that query failed: every row's
 * campaign becomes null and the picker falls back to grouping by sample. */
export function attachCampaigns<T extends { operation_id?: { campaign_id?: unknown } | null }>(
	rows: T[], campaigns: CampaignInfo[] | null,
): T[] {
	const byId = new Map((campaigns ?? []).map((c) => [c.campaign_id, c]));
	return rows.map((r) => {
		const op = r.operation_id;
		if (!op || typeof op.campaign_id !== 'string') return r;
		return { ...r, operation_id: { ...op, campaign_id: byId.get(op.campaign_id) ?? null } };
	});
}

/** Directus nested row -> PickerRow. Tolerates missing relations. */
export function toPickerRow(r: {
	id: string; diag_status: DiagState; diag_path: string | null;
	operation_id?: {
		operation_id?: string; pass_code?: string;
		sample_id?: { sample_id?: string; sample_code?: string; nickname?: string } | null;
		/** An unresolved foreign key (a string) counts as no campaign: see attachCampaigns. */
		campaign_id?: { campaign_id?: string; campaign_code?: string | null; name?: string | null } | string | null;
	} | null;
}): PickerRow {
	const op = r.operation_id ?? null;
	const s = op?.sample_id ?? null;
	const c = op?.campaign_id && typeof op.campaign_id === 'object' ? op.campaign_id : null;
	const sampleLabel = s ? [s.sample_code, s.nickname].filter(Boolean).join(' · ') : '';
	const campLabel = c ? (c.campaign_code ? `${c.campaign_code} ${c.name ?? ''}`.trim() : c.name ?? '') : '';
	return {
		id: r.id,
		diag_status: r.diag_status,
		diag_path: r.diag_path,
		code: op?.pass_code || op?.operation_id || r.id,
		operation_id: op?.operation_id ?? null,
		sample_id: s?.sample_id ?? null,
		sample_label: sampleLabel || null,
		campaign_id: c?.campaign_id ?? null,
		campaign_label: campLabel || null,
	};
}
