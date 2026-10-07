import { describe, expect, it } from 'vitest';
import {
	attachCampaigns, bucketOf, countByBucket, filterRows, groupRows, toPickerRow, windowGroups, type PickerRow,
} from './diagPicker';

function row(id: string, o: Partial<PickerRow> = {}): PickerRow {
	return {
		id, diag_status: null, diag_path: null, code: `P-${id}`, operation_id: `op-${id}`,
		sample_id: 's1', sample_label: 'S-001 · Alpha', campaign_id: 'c1', campaign_label: 'C1 Spring', ...o,
	};
}
const none = new Set<never>();

describe('bucketOf', () => {
	it('maps diag state to the three chips', () => {
		expect(bucketOf({ diag_status: 'done', diag_path: 'x' })).toBe('built');
		expect(bucketOf({ diag_status: 'done', diag_path: null })).toBe('needs');
		expect(bucketOf({ diag_status: 'error', diag_path: null })).toBe('error');
		expect(bucketOf({ diag_status: 'pending', diag_path: null })).toBe('needs');
		expect(bucketOf({ diag_status: 'processing', diag_path: null })).toBe('needs');
		expect(bucketOf({ diag_status: null, diag_path: null })).toBe('needs');
	});
	it('counts', () => {
		expect(countByBucket([
			row('1', { diag_status: 'done', diag_path: 'p' }), row('2'), row('3', { diag_status: 'error' }), row('4'),
		])).toEqual({ needs: 2, built: 1, error: 1 });
	});
});

describe('filterRows', () => {
	const rows = [
		row('1', { diag_status: 'done', diag_path: 'p', code: 'A-1' }),
		row('2', { code: 'B-2', sample_label: 'S-002 · Beta' }),
		row('3', { diag_status: 'error', code: 'C-3', campaign_label: null }),
	];
	it('returns everything for an empty query and no chips', () => {
		expect(filterRows(rows, '  ', none)).toHaveLength(3);
	});
	it('matches all terms across code, sample and campaign, case-insensitively', () => {
		expect(filterRows(rows, 'beta b-2', none).map((r) => r.id)).toEqual(['2']);
		expect(filterRows(rows, 'spring', none).map((r) => r.id)).toEqual(['1', '2']);
		expect(filterRows(rows, 'nomatch', none)).toEqual([]);
	});
	it('applies the state chips (several are OR-ed) together with the query', () => {
		expect(filterRows(rows, '', new Set(['error' as const])).map((r) => r.id)).toEqual(['3']);
		expect(filterRows(rows, '', new Set(['built' as const, 'error' as const])).map((r) => r.id)).toEqual(['1', '3']);
		expect(filterRows(rows, 'c-3', new Set(['built' as const]))).toEqual([]);
	});
});

describe('groupRows', () => {
	const rows = [
		row('1', { sample_id: 'sB', sample_label: 'B' }),
		row('2', { sample_id: null, sample_label: null }),
		row('3', { sample_id: 'sA', sample_label: 'A' }),
		row('4', { sample_id: 'sB', sample_label: 'B' }),
	];
	it('groups by sample in first-seen order with the no-sample group last', () => {
		const g = groupRows(rows, 'sample');
		expect(g.map((x) => x.label)).toEqual(['B', 'A', 'No sample']);
		expect(g[0].rows.map((r) => r.id)).toEqual(['1', '4']);
		expect(g[0].sub).toBe('C1 Spring');
	});
	it('groups by campaign', () => {
		const g = groupRows([row('1'), row('2', { campaign_id: null, campaign_label: null }), row('3', { campaign_id: 'c2', campaign_label: 'C2' })], 'campaign');
		expect(g.map((x) => x.label)).toEqual(['C1 Spring', 'C2', 'No campaign']);
	});
});

describe('windowGroups', () => {
	const groups = groupRows([row('1'), row('2'), row('3', { sample_id: 's2', sample_label: 'X' }), row('4', { sample_id: 's2', sample_label: 'X' })], 'sample');
	it('keeps everything when under the limit', () => {
		expect(windowGroups(groups, 10)).toEqual({ groups, hidden: 0 });
	});
	it('cuts mid-group and counts what is hidden', () => {
		const w = windowGroups(groups, 3);
		expect(w.groups.map((g) => g.rows.length)).toEqual([2, 1]);
		expect(w.hidden).toBe(1);
		expect(windowGroups(groups, 2)).toMatchObject({ hidden: 2 });
		expect(windowGroups(groups, 2).groups).toHaveLength(1);
	});
});

describe('toPickerRow', () => {
	it('flattens the nested Directus row', () => {
		const r = toPickerRow({
			id: 'a', diag_status: 'done', diag_path: 'p',
			operation_id: {
				operation_id: 'op1', pass_code: 'PC',
				sample_id: { sample_id: 's', sample_code: 'S-1', nickname: 'Nick' },
				campaign_id: { campaign_id: 'c', campaign_code: 'K1', name: 'Spring' },
			},
		});
		expect(r).toMatchObject({ code: 'PC', sample_label: 'S-1 · Nick', campaign_label: 'K1 Spring', sample_id: 's', campaign_id: 'c' });
	});
	it('tolerates missing relations and falls back to ids', () => {
		expect(toPickerRow({ id: 'a', diag_status: null, diag_path: null })).toMatchObject({
			code: 'a', sample_id: null, campaign_id: null, sample_label: null,
		});
	});
});

describe('attachCampaigns (campaign names fetched apart from the rows)', () => {
	const mk = (id: string, campaign: unknown) => ({
		id, diag_status: 'done' as const, diag_path: 'p',
		operation_id: { operation_id: `op-${id}`, pass_code: `P-${id}`, campaign_id: campaign as string | null },
	});
	const camps = [{ campaign_id: 'c1', campaign_code: 'K1', name: 'Spring' }];

	it('swaps the foreign key for the campaign record', () => {
		const [r] = attachCampaigns([mk('1', 'c1')], camps);
		expect(toPickerRow(r as never)).toMatchObject({ campaign_id: 'c1', campaign_label: 'K1 Spring' });
	});
	it('a campaign the role cannot see, or no campaign, is "no campaign", not a broken row', () => {
		const rows = attachCampaigns([mk('1', 'c-hidden'), mk('2', null)], camps);
		expect(rows.map((r) => toPickerRow(r as never).campaign_id)).toEqual([null, null]);
	});
	it('when the campaigns query failed (null) every row still loads, grouped by sample only', () => {
		const rows = attachCampaigns([mk('1', 'c1'), mk('2', 'c2')], null);
		const picker = rows.map((r) => toPickerRow(r as never));
		expect(picker.map((r) => r.code)).toEqual(['P-1', 'P-2']);
		expect(picker.every((r) => r.campaign_id === null && r.campaign_label === null)).toBe(true);
	});
	it('leaves rows without an operation alone and does not mutate its input', () => {
		const input = [mk('1', 'c1'), { id: 'x', diag_status: 'done' as const, diag_path: null }];
		const out = attachCampaigns(input as never[], camps);
		expect(out[1]).toBe(input[1]);
		expect((input[0] as any).operation_id.campaign_id).toBe('c1');
	});
});
