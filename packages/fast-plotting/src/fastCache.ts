// Parsed FAST trace store, a module singleton so revisiting an operation is instant
// and re-issues no download (same reasoning as the force dashboard's liveCache).
//
// The canonical CSV (from scripts/fast_mapping.normalize_fast_csv) is column-aligned
// with the fast_run_data.series catalog: column 0 is time_s, columns 1..N correspond
// to catalog[0..N-1]. We parse by POSITION using the catalog to assign each column its
// stable series key.

export interface SeriesMeta { key: string; label: string; unit: string; group: string; min: number | null; max: number | null; }
export interface Series extends SeriesMeta { values: Float64Array; }
export interface Trace { time: Float64Array; n: number; series: Record<string, Series>; order: string[]; }

const MEM = new Map<string, Trace>();
const CAP = 6;

export function traceGet(id: string): Trace | undefined {
	const v = MEM.get(id);
	if (v) { MEM.delete(id); MEM.set(id, v); }
	return v;
}
function tracePut(id: string, v: Trace) {
	MEM.set(id, v);
	while (MEM.size > CAP) MEM.delete(MEM.keys().next().value as string);
}

// Parse the canonical CSV text against its catalog into typed arrays.
export function parseTrace(csvText: string, catalog: SeriesMeta[]): Trace {
	const lines = csvText.split(/\r?\n/);
	// skip the header row; count non-empty data rows
	let count = 0;
	for (let i = 1; i < lines.length; i++) if (lines[i]) count++;
	const time = new Float64Array(count);
	const cols: Float64Array[] = catalog.map(() => new Float64Array(count));
	let r = 0;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;
		const cells = line.split(',');
		time[r] = +cells[0];
		for (let c = 0; c < catalog.length; c++) {
			const v = cells[c + 1];
			cols[c][r] = v === '' || v === undefined ? NaN : +v;
		}
		r++;
	}
	const series: Record<string, Series> = {};
	const order: string[] = [];
	catalog.forEach((m, c) => { series[m.key] = { ...m, values: cols[c] }; order.push(m.key); });
	return { time, n: count, series, order };
}

// Cache-aware loader. `fetcher` returns the raw CSV text (only called on a miss).
export async function loadTrace(id: string, catalog: SeriesMeta[], fetcher: () => Promise<string>): Promise<Trace> {
	const hit = traceGet(id);
	if (hit) return hit;
	const t = parseTrace(await fetcher(), catalog);
	tracePut(id, t);
	return t;
}
