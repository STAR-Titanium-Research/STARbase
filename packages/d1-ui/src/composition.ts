// Alloy composition bar logic, shared by the d1-composition-bar form interface and the Sample page.
// Pure: turns material_alloying_elements rows into the segments of a stacked wt% bar.

export interface ElementRow {
	symbol?: string | null;
	weight_percent?: number | string | null;
}

export interface Element {
	symbol: string;
	wt: number | null;
}

export interface Segment {
	key: string;
	symbol: string;
	label: string;
	widthPct: number;
	pctLabel: string;
	color: string;
}

export interface Composition {
	specifiedSum: number;
	overspecified: boolean;
	segments: Segment[];
}

// Distinct, colour-blind-friendly-ish palette cycled by element index.
export const PALETTE = [
	'#1565C0', '#EF6C00', '#2E7D32', '#6A1B9A', '#C62828', '#00838F',
	'#F9A825', '#4E342E', '#AD1457', '#283593', '#558B2F', '#00695C',
];
export const BALANCE_COLOR = '#B0BEC5';

const num = (x: unknown): number | null => {
	const n = typeof x === 'string' ? parseFloat(x) : x;
	return typeof n === 'number' && !Number.isNaN(n) ? n : null;
};

// Heaviest first; unspecified (null) sink to the bottom.
export function toElements(rows: ElementRow[]): Element[] {
	return rows
		.map((r) => ({ symbol: String(r.symbol ?? '?'), wt: num(r.weight_percent) }))
		.sort((a, b) => (b.wt ?? -1) - (a.wt ?? -1));
}

export function buildComposition(elements: Element[]): Composition {
	const specifiedSum = elements.reduce((s, e) => s + (e.wt ?? 0), 0);
	const overspecified = specifiedSum > 100.0001;
	if (specifiedSum <= 0) return { specifiedSum, overspecified, segments: [] };

	// Normalise to 100 if over-specified; otherwise real wt% with a balance segment.
	const scale = overspecified ? 100 / specifiedSum : 1;
	const segments: Segment[] = elements
		.filter((e) => (e.wt ?? 0) > 0)
		.map((e, i) => {
			const wt = e.wt as number;
			return {
				key: e.symbol + i,
				symbol: e.symbol,
				label: e.symbol,
				widthPct: wt * scale,
				pctLabel: wt.toFixed(wt < 1 ? 2 : 1) + ' wt%',
				color: PALETTE[i % PALETTE.length],
			};
		});
	// Balance (matrix / base element) fills the remainder to 100%.
	if (!overspecified && specifiedSum < 99.999) {
		segments.push({
			key: 'balance',
			symbol: 'Bal.',
			label: 'Balance (matrix)',
			widthPct: 100 - specifiedSum,
			pctLabel: (100 - specifiedSum).toFixed(1) + ' wt%',
			color: BALANCE_COLOR,
		});
	}
	return { specifiedSum, overspecified, segments };
}

export function compositionAria(segments: Segment[]): string {
	return 'Composition: ' + segments.map((s) => `${s.label} ${s.pctLabel}`).join(', ');
}
