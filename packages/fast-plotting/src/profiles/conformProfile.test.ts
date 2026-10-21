import { describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import { conformProfile, type ConformRunBundle } from './conformProfile';
import { seedTiles } from '../fastTiles';

const LOG_START = '2025-03-17T09:00:00Z';
const log = {
	log_id: 'log-1', directus_files_id: 'f-1', equipment_id: 'eq-1', source_filename: 'run.csv', log_start: LOG_START, log_end: '2025-03-17T11:00:00Z',
	n_rows: 7200, duration_s: 7200, series: [], totals: {} as any, constants: {} as any,
};
const summary = {
	version: 1 as const, duration_s: 600, n_rows: 600, gaps: 0, extruding_s: 540, mean_wheel_speed_rpm: 5, mean_torque_pct: 41.26, mean_tooling1_c: 380,
	peak_torque_pct: 60, peak_motor_current_a: 22.4, peak_tooling1_c: 412.34, peak_wheel_temp_c: 150, ips_setpoint_c: 300,
	energy_kwh: { motor: 1.5, ips: 0.5, cooling: 0.25, total: 2.25 }, avg_demand_kw: 13.5, missing: [] as ('motor' | 'ips' | 'cooling')[],
};
const run = (over: Partial<NonNullable<ConformRunBundle['run']>> = {}): ConformRunBundle => ({
	run: { id: 'r1', operation_id: 'op-1', log_id: 'log-1', window_start: '2025-03-17T09:10:00Z', window_end: '2025-03-17T09:20:00Z', status: 'done', summary, steps: [], error_message: null, ...over },
	log, logHidden: false,
});

describe('conformProfile constants', () => {
	it('is the Conform plotter with its own layout key and list', () => {
		expect(conformProfile.key).toBe('conform');
		expect(conformProfile.title).toBe('Conform plotter');
		expect(conformProfile.layoutKey).toBe('d1-conform-dashboard-v1');
		expect(conformProfile.listQuery.category).toBe('conform');
		expect(conformProfile.listQuery.fields).toContain('conform_run.status');
		expect(conformProfile.seedGroups).toEqual(['speed', 'torque', 'temp', 'ips', 'power']);
	});
	it('offers the window features FAST does not', () => {
		for (const hook of ['upload', 'startMs', 'windows', 'setWindowFromView', 'linkExisting', 'summaryTiles'] as const) {
			expect(conformProfile[hook], hook).toBeDefined();
		}
	});
	it('seeds one tile each for speed, torque, temperature, IPS and power from the channels the log has', () => {
		const cat = (key: string, group: string) => ({ key, group });
		const tiles = seedTiles([
			cat('wheel_speed_rpm', 'speed'), cat('wheel_speed_demand_rpm', 'speed'), cat('motor_current_a', 'current'), cat('motor_torque_pct', 'torque'),
			cat('tooling1_c', 'temp'), cat('tooling2_c', 'temp'), cat('wheel_temp_c', 'temp'), cat('bearing_oil_c', 'temp'), cat('ips_control_c', 'ips'),
			cat('ips_output_pct', 'ips'), cat('ips_coil_va', 'ips'), cat('wheel_cooling_pump_current_a', 'cooling'),
			cat('p_motor_kw', 'power'), cat('p_ips_kw', 'power'), cat('p_cooling_kw', 'power'), cat('p_total_kw', 'power'),
		], 1, { groups: conformProfile.seedGroups, series: conformProfile.seedSeries, strict: conformProfile.seedStrict });
		expect(tiles.map((t) => t.series)).toEqual([
			['wheel_speed_rpm', 'wheel_speed_demand_rpm'],
			['motor_torque_pct', 'motor_current_a'],
			['tooling1_c', 'tooling2_c', 'wheel_temp_c', 'ips_control_c'],
			['ips_output_pct', 'ips_coil_va'],
			['p_motor_kw', 'p_ips_kw', 'p_cooling_kw', 'p_total_kw'],
		]);
	});
	it('leaves out a tile for a group the log has nothing of (an older machine export)', () => {
		const tiles = seedTiles([{ key: 'wheel_speed_rpm', group: 'speed' }], 1, { groups: conformProfile.seedGroups, series: conformProfile.seedSeries, strict: true });
		expect(tiles.map((t) => t.series)).toEqual([['wheel_speed_rpm']]);
	});
});

describe('conformProfile.windows', () => {
	it('maps the log windows to bands in seconds from the log start, marking this run', async () => {
		const api = {
			get: vi.fn(async () => ({
				data: {
					data: [
						{ operation_id: { operation_id: 'op-0', pass_code: '17-03-25-CF-010', conform_feedstock: 'AA6082 swarf' }, window_start: '2025-03-17T09:00:30Z', window_end: '2025-03-17T09:05:00Z' },
						{ operation_id: { operation_id: 'op-1', pass_code: '17-03-25-CF-011', conform_feedstock: null }, window_start: '2025-03-17T09:10:00Z', window_end: '2025-03-17T09:20:00Z' },
					],
				},
			})),
		} as unknown as AxiosInstance;
		const bands = await conformProfile.windows!(api, run());
		expect(bands).toEqual([
			{ operationId: 'op-0', label: 'AA6082 swarf', startS: 30, endS: 300, current: false },
			{ operationId: 'op-1', label: '17-03-25-CF-011', startS: 600, endS: 1200, current: true },
		]);
		expect((api.get as any).mock.calls[0][0]).toBe('/items/conform_run_data');
	});
	it('has no bands without a log', async () => {
		const api = { get: vi.fn() } as unknown as AxiosInstance;
		expect(await conformProfile.windows!(api, { run: null, log: null, logHidden: false })).toEqual([]);
		expect((api.get as any)).not.toHaveBeenCalled();
	});
	it('gives the hover its clock from the log start', () => {
		expect(conformProfile.startMs!(run())).toBe(Date.parse(LOG_START));
		expect(conformProfile.startMs!({ run: null, log: null, logHidden: false })).toBeNull();
	});
});

describe('conformProfile figures', () => {
	it('shows extruding time, mean torque, peak tooling 1 and total energy from the summary', () => {
		expect(conformProfile.buildStats({}, run())).toEqual([
			{ label: 'Extruding time', value: '9', unit: 'min', source: 'measured' },
			{ label: 'Mean torque', value: '41.3', unit: '%', source: 'measured' },
			{ label: 'Peak tooling 1', value: '412.3', unit: '°C', source: 'measured' },
			{ label: 'Total energy', value: '2.25', unit: 'kWh', source: 'measured' },
		]);
		expect(conformProfile.peakLabels).toEqual(['Extruding time', 'Mean torque', 'Peak tooling 1', 'Total energy']);
	});
	it('has no figures before a window is set, and still shows them when the log is hidden', () => {
		expect(conformProfile.buildStats({}, run({ summary: null, status: 'no_window' }))).toEqual([]);
		expect(conformProfile.buildStats({}, null)).toEqual([]);
		expect(conformProfile.buildStats({}, { ...run(), log: null, logHidden: true }).length).toBe(4);
	});
	it('lists the energy per component and says what the log did not have', () => {
		const tiles = conformProfile.summaryTiles!({}, run({ summary: { ...summary, missing: ['ips'], energy_kwh: { motor: 1.5, ips: null, cooling: 0.25, total: 1.75 } } }));
		expect(tiles.find((t) => t.key === 'eMotor')).toMatchObject({ value: '1.5', unit: 'kWh' });
		expect(tiles.find((t) => t.key === 'eIps')).toBeUndefined();
		expect(conformProfile.summaryNote!(run({ summary: { ...summary, missing: ['ips'] } }))).toContain('IPS');
	});
	it('words the window in UK local time', () => {
		expect(conformProfile.windowLabel!(run())).toBe('09:10:00 – 09:20:00 on 2025-03-17 (UK time)');
		expect(conformProfile.windowLabel!(run({ window_start: null, window_end: null, status: 'no_window' }))).toBeNull();
	});
});

describe('conformProfile list and states', () => {
	it('badges a run by its window status', () => {
		const q = (status?: string) => conformProfile.quality({ conform_run: status ? [{ status }] : [] });
		expect([q().label, q('no_log').level]).toEqual(['No log', 'grey']);
		expect(q('no_window')).toMatchObject({ level: 'yellow', label: 'No window' });
		expect(q('done')).toMatchObject({ level: 'green', label: 'Window set' });
		expect(q('error').level).toBe('red');
	});
	it('words the list meta from the setpoints', () => {
		expect(conformProfile.listMeta({ conform_feedstock: 'AA6082 swarf', conform_die_diameter_mm: '8.000', conform_wheel_speed_rpm: '5.000', conform_ips_setpoint_c: '300.0' }))
			.toEqual(['AA6082 swarf', 'Ø8 mm', '5 rpm', '300 °C']);
		expect(conformProfile.listMeta({})).toEqual([]);
	});
	it('says the log is not visible in place of the plot, and why there is nothing to plot otherwise', () => {
		expect(conformProfile.plotMessage({ run: null, log: null, logHidden: true }, 0)).toBe('Conform log not visible to you');
		expect(conformProfile.plotMessage(null, 0)).toBe('No Conform log has been uploaded for this run.');
		expect(conformProfile.plotMessage(run({ status: 'error', error_message: 'bad file' }), 0)).toBe('Processing failed: bad file');
	});
	it('offers upload only where there is no log', () => {
		expect(conformProfile.hasLog!(null)).toBe(false);
		expect(conformProfile.hasLog!(run())).toBe(true);
		expect(conformProfile.hasLog!({ run: null, log: null, logHidden: true })).toBe(true);
	});
});

describe('conformProfile.setWindowFromView', () => {
	it('saves the view as ISO times from the log start, kept inside the log', async () => {
		const patch = vi.fn(async (_url: string, body: any) => ({ data: { data: body } }));
		const runRow = { id: 'r1', operation_id: 'op-1', log_id: 'log-1' };
		const api = {
			get: vi.fn(async (url: string) => {
				if (url === '/items/conform_run_data') return { data: { data: [runRow] } };
				if (url === '/items/conform_logs/log-1') return { data: { data: log } };
				if (url.startsWith('/assets/')) return { data: 'time_s,wheel_speed_rpm\n0,1\n1,1\n' };
				return { data: { data: {} } };
			}),
			patch,
		} as unknown as AxiosInstance;
		await conformProfile.setWindowFromView!(api, { operation_id: 'op-1' }, run(), 600.4, 99999);
		const body = patch.mock.calls.find((c) => c[0] === '/items/conform_run_data/r1')![1];
		expect(body.window_start).toBe('2025-03-17T09:10:00.000Z');
		expect(body.window_end).toBe('2025-03-17T11:00:00.000Z');
	});
});
