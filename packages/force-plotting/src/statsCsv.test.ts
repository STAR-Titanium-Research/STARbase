import { describe, expect, it } from 'vitest';
import { toCsv } from './csvExport';
import { statsCsvColumns } from './statsCsv';
import type { SignalStats } from './signalStats';
import { DEFAULT_AXIS_MAP, type CuttingMetrics } from './cuttingMetrics';

const ax = { n: 10, mean: 1, rms: 2, std: 3, min: -1, max: 4, p2p: 5, effBits: 11.5, railLoPct: 0.1, railHiPct: 0.2, clipped: false };
const stats: SignalStats = { windowSec: [1, 3], axes: { Fx: ax, Fy: ax, Fz: ax }, rpm: { mean: 1200, std: 1, min: 1190, max: 1210 }, resultant: { mean: 5, peak: 9 }, cacheCropStartSec: 0 };

describe('statsCsvColumns', () => {
	it('names the whole-signal columns *_whole and keeps the window columns', () => {
		const header = toCsv(statsCsvColumns(() => stats), []).trim().split(',');
		expect(header).toContain('window_start_s');
		expect(header).toEqual(expect.arrayContaining(['dyn_range_bits_whole', 'rail_lo_pct_whole', 'rail_hi_pct_whole', 'clipped_whole']));
		expect(header).not.toContain('rail_lo_pct');
		expect(header).not.toContain('dyn_range_bits');
	});
	it('writes the values under those headers', () => {
		const csv = toCsv(statsCsvColumns(() => stats), [{ axis: 'Fx', ...ax }]);
		expect(csv.split('\r\n')[1]).toBe('Fx,1,3,10,1,2,3,-1,4,5,11.5,0.1,0.2,false,1200,1,1190,1210,,,,,,,,,,,,');
	});
	it('appends the cutting metrics, leaving unavailable ones empty', () => {
		const m = (v: number | null) => ({ value: v });
		const cm: CuttingMetrics = {
			resultant: { mean: m(5), peak: m(9) }, Fc: { mean: m(600), peak: m(700) }, Ff: { mean: m(200), peak: m(250) },
			Fp: { mean: m(100), peak: m(120) }, diameterMidMm: m(90), vcMPerMin: m(314.5), pcW: m(null), kcMPa: m(3000),
			axisMap: DEFAULT_AXIS_MAP,
		};
		const cols = statsCsvColumns(() => stats, () => cm);
		const csv = toCsv(cols, [{ axis: 'Fx', ...ax }]).split('\r\n');
		expect(csv[0].split(',').slice(-12)).toEqual(['resultant_mean_N', 'resultant_peak_N', 'Fc_mean_N', 'Fc_peak_N', 'Ff_mean_N', 'Ff_peak_N', 'Fp_mean_N', 'Fp_peak_N', 'vc_m_per_min', 'Pc_W', 'kc_N_per_mm2', 'axis_map']);
		expect(csv[1].endsWith(',1200,1,1190,1210,5,9,600,700,200,250,100,120,314.5,,3000,Fx/Fy/Fz')).toBe(true);
	});
});
