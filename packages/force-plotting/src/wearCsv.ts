// Column list for the Wear trend's CSV (every pass of the edge/sample, all three axes).
import type { CsvColumn } from './csvExport';

export interface WearCsvPoint {
	label: string;
	/** The plotted x: cumulative length, or the sequence (with the chart's own row-index fallback). */
	x: number;
	/** The operation's real sequence number; null when the row has none. */
	seq: number | null;
	peaks: Record<'Fx' | 'Fy' | 'Fz', number | null>;
	isCurrent: boolean;
}

/** `x` follows the Pass / Length toggle. In Pass mode the column is the recorded sequence only: a
 *  row without one exports blank rather than the chart's row-index stand-in, which would mix two
 *  different numberings in one column. */
export function wearCsvColumns(xMode: 'sequence' | 'length'): CsvColumn<WearCsvPoint>[] {
	return [
		{ header: 'pass_code', value: (p) => p.label },
		xMode === 'length'
			? { header: 'cumulative_cutting_length_mm', value: (p) => p.x }
			: { header: 'pass_sequence', value: (p) => p.seq },
		{ header: 'peak_fx_N', value: (p) => p.peaks.Fx },
		{ header: 'peak_fy_N', value: (p) => p.peaks.Fy },
		{ header: 'peak_fz_N', value: (p) => p.peaks.Fz },
		{ header: 'selected', value: (p) => p.isCurrent },
	];
}
