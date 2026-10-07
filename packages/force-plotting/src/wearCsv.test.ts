import { describe, expect, it } from 'vitest';
import { toCsv } from './csvExport';
import { wearCsvColumns, type WearCsvPoint } from './wearCsv';

const pt = (label: string, x: number, seq: number | null): WearCsvPoint =>
	({ label, x, seq, peaks: { Fx: 1, Fy: 2, Fz: 3 }, isCurrent: false });

describe('wearCsvColumns', () => {
	it('exports a blank pass_sequence for a row with no sequence, not its row index', () => {
		// x is 2 for the second row because the chart falls back to the row index; the CSV must not.
		const csv = toCsv(wearCsvColumns('sequence'), [pt('a', 1, 1), pt('b', 2, null)]);
		expect(csv.split('\r\n').slice(0, 3)).toEqual([
			'pass_code,pass_sequence,peak_fx_N,peak_fy_N,peak_fz_N,selected',
			'a,1,1,2,3,false',
			'b,,1,2,3,false',
		]);
	});
	it('length mode exports the cumulative length', () => {
		const csv = toCsv(wearCsvColumns('length'), [pt('a', 12.5, null)]);
		expect(csv.split('\r\n')[0]).toContain('cumulative_cutting_length_mm');
		expect(csv.split('\r\n')[1]).toBe('a,12.5,1,2,3,false');
	});
});
