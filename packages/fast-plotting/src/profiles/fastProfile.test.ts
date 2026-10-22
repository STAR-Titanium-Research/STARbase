import { describe, expect, it } from 'vitest';
import { fastProfile } from './fastProfile';
import { buildDetailRows, buildOpMeta, buildStats, dataQuality } from '../fastMeta';

// The FAST plotter before profiles existed: these literals are copied from FastDashboard.vue as it was, so a
// change to the FAST profile that alters /plot/fast fails here.
const LIST_FIELDS = ['operation_id', 'pass_code', 'operation_date', 'operator_name',
	'sintering_max_temp_celsius', 'sintering_max_force_kn', 'sintering_recipe_number',
	'sample_id.sample_code', 'sample_id.nickname', 'material_id.common_name', 'equipment_id.equipment_name',
	'fast_run.status', 'fast_run.n_rows'];
const DETAIL_FIELDS = ['*', 'equipment_id.equipment_name', 'method_id.method_name',
	'material_id.common_name', 'sample_id.sample_code', 'sample_id.nickname', 'sample_id.sample_id',
	'fast_recipe_id.id', 'fast_recipe_id.name', 'fast_recipe_id.program_nr',
	'fast_recipe_id.machine', 'fast_recipe_id.group_name', 'fast_recipe_id.source_file',
	'fast_recipe_id.target_temp_c', 'fast_recipe_id.target_force_kn', 'fast_recipe_id.hold_time_min'];
const SEED_GROUP_ORDER = ['temp', 'force', 'power', 'pressure', 'position', 'vacuum', 'speed', 'voltage', 'current', 'flow'];

describe('fastProfile equals what the FAST plotter hard-wired', () => {
	it('keeps the layout key, the list query and the seed groups', () => {
		expect(fastProfile.key).toBe('fast');
		expect(fastProfile.layoutKey).toBe('d1-fast-dashboard-v1');
		expect(fastProfile.listQuery.category).toBe('sintering');
		expect(fastProfile.listQuery.fields).toEqual(LIST_FIELDS);
		expect(fastProfile.detailFields).toEqual(DETAIL_FIELDS);
		expect(fastProfile.seedGroups).toEqual(SEED_GROUP_ORDER);
		expect(fastProfile.heading).toBe('FAST Analysis');
		expect(fastProfile.title).toBe('FAST plotter');
	});
	it('has the three tabs and none of the Conform-only hooks', () => {
		expect(fastProfile.tabs).toEqual(['stats', 'detail', 'recipe']);
		for (const hook of ['upload', 'startMs', 'windows', 'setWindowFromView', 'linkExisting', 'summaryTiles'] as const) {
			expect(fastProfile[hook], hook).toBeUndefined();
		}
	});
	it('derives the same metadata, stats and quality as fastMeta', () => {
		const op = { pass_code: 'X', operation_date: '2025-03-17T10:00:00Z', sintering_max_temp_celsius: 1200, sample_id: { sample_code: 'S1' }, fast_run: [{ status: 'done', n_rows: 500 }] };
		const run = { status: 'done', summary: { peak_temp_c: 1210.4, dwell_s: 600 }, n_rows: 500 };
		expect(fastProfile.buildOpMeta(op, run)).toEqual(buildOpMeta(op));
		expect(fastProfile.buildStats(op, run)).toEqual(buildStats(op, run));
		expect(fastProfile.detailRows(op, run)).toEqual(buildDetailRows(op, run));
		expect(fastProfile.quality(op)).toEqual(dataQuality(op));
	});
	it('words the list meta, the empty plot and the empty tab as before', () => {
		expect(fastProfile.listMeta({ sintering_max_temp_celsius: 1200.4, sintering_max_force_kn: 30.04 })).toEqual(['1200 °C', '30 kN']);
		expect(fastProfile.listMeta({})).toEqual([]);
		expect(fastProfile.plotMessage(null, 0)).toBe('No trace was imported for this run.');
		expect(fastProfile.plotMessage({ status: 'done' }, 0)).toBe('No trace to plot.');
		expect(fastProfile.plotMessage({ status: 'error', error_message: 'bad' }, 0)).toBe('Import failed: bad');
		expect(fastProfile.plotMessage({ status: 'pending', updated_at: '2025-01-01T00:00:00Z' }, Date.parse('2025-01-01T00:01:00Z')))
			.toBe('Still importing. Is the FAST importer running on the host?');
		expect(fastProfile.plotMessage({ status: 'pending', updated_at: '2025-01-01T00:00:00Z' }, Date.parse('2025-01-01T00:00:10Z'))).toBe('The trace is being imported.');
		expect(fastProfile.noTraceMessage({ status: 'error' })).toBe('The trace import failed.');
		expect(fastProfile.noTraceMessage(null)).toBe('No trace was imported for this run.');
	});
});
