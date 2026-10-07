// Column list for the Plot dashboard's signal-statistics CSV: one row per force axis, RPM columns
// repeated on each row so the file stays a flat table. Units are in the header names. Force stats
// are over the crop window (window_start_s..window_end_s); the bit-depth and rail columns are over
// the WHOLE cached signal (see signalStats.ts), so their headers end in `_whole`.
import type { CsvColumn } from './csvExport';
import { axisMapKey, type CuttingMetrics, type Metric } from './cuttingMetrics';
import type { SignalStats } from './signalStats';

export type StatsCsvRow = { axis: string } & SignalStats['axes']['Fx'];

const mv = (m: Metric | undefined) => m?.value ?? undefined;

// The cutting-metrics columns repeat on every row like the RPM ones; unavailable metrics are empty
// cells. `axis_map` records the axis mapping in use (per subtype, cuttingMetrics.ts).
export function statsCsvColumns(
	stats: () => SignalStats | null | undefined,
	cutting: () => CuttingMetrics | null | undefined = () => null,
): CsvColumn<StatsCsvRow>[] {
	return [
		{ header: 'axis', value: (r) => r.axis },
		{ header: 'window_start_s', value: () => stats()?.windowSec[0] },
		{ header: 'window_end_s', value: () => stats()?.windowSec[1] },
		{ header: 'n_samples', value: (r) => r.n },
		{ header: 'mean_N', value: (r) => r.mean },
		{ header: 'rms_N', value: (r) => r.rms },
		{ header: 'std_N', value: (r) => r.std },
		{ header: 'min_N', value: (r) => r.min },
		{ header: 'max_N', value: (r) => r.max },
		{ header: 'p2p_N', value: (r) => r.p2p },
		{ header: 'dyn_range_bits_whole', value: (r) => r.effBits },
		{ header: 'rail_lo_pct_whole', value: (r) => r.railLoPct },
		{ header: 'rail_hi_pct_whole', value: (r) => r.railHiPct },
		{ header: 'clipped_whole', value: (r) => r.clipped },
		{ header: 'rpm_mean', value: () => stats()?.rpm.mean },
		{ header: 'rpm_std', value: () => stats()?.rpm.std },
		{ header: 'rpm_min', value: () => stats()?.rpm.min },
		{ header: 'rpm_max', value: () => stats()?.rpm.max },
		...(['resultant', 'Fc', 'Ff', 'Fp'] as const).flatMap((k) => (['mean', 'peak'] as const).map(
			(s): CsvColumn<StatsCsvRow> => ({ header: `${k}_${s}_N`, value: () => mv(cutting()?.[k][s]) }),
		)),
		{ header: 'vc_m_per_min', value: () => mv(cutting()?.vcMPerMin) },
		{ header: 'Pc_W', value: () => mv(cutting()?.pcW) },
		{ header: 'kc_N_per_mm2', value: () => mv(cutting()?.kcMPa) },
		{ header: 'axis_map', value: () => { const m = cutting()?.axisMap; return m ? axisMapKey(m) : undefined; } },
	];
}
