// `test_sessions.summary_stats` as something a person can read.
//
// Each worker owns one top-level key and merges its result under it (read-merge-write under OCC):
// heavy-data-worker writes `basic` (n_samples, sample_rate_hz, channels: [{min,max,mean,std}...]),
// analysis-worker writes `fft_analysis` (rms, peak, dominant_frequency_hz, top_frequencies: [...],
// band_energy: {...}). So the page shows one group per top-level namespace, and inside a group
// scalars become label/value rows, nested objects become "Parent › child" rows and lists of
// records become small tables. Values outside any namespace (a flat legacy result) go into a
// "Summary" group.

import { formatQuantity } from './format';

export interface StatEntry {
	label: string;
	value: string;
	unit: string;
}

export interface StatTable {
	label: string;
	columns: string[];
	rows: string[][];
	/** Rows left out of `rows` to keep the page short. */
	more: number;
}

export interface StatGroup {
	key: string;
	title: string;
	entries: StatEntry[];
	tables: StatTable[];
}

const MAX_TABLE_ROWS = 20;
const MAX_TABLE_COLUMNS = 8;
const MAX_LIST_ITEMS = 10;
const MAX_DEPTH = 4;

const GROUP_TITLE: Record<string, string> = {
	basic: 'Basic statistics',
	fft_analysis: 'FFT analysis',
};

// Words shown in a fixed spelling.
const WORD: Record<string, string> = { rms: 'RMS', fft: 'FFT', psd: 'PSD', snr: 'SNR', dc: 'DC', uts: 'UTS', frf: 'FRF', rpm: 'RPM', hz: 'Hz', khz: 'kHz' };

// A trailing unit in a key name, as the workers and the parameter columns spell them.
const UNIT_SUFFIX: [RegExp, string][] = [
	[/_khz$/, 'kHz'],
	[/_hz$/, 'Hz'],
	[/_(seconds|sec)$/, 's'],
	[/_ms$/, 'ms'],
	[/_pct$/, '%'],
	[/_mpa$/, 'MPa'],
	[/_gpa$/, 'GPa'],
	[/_mm$/, 'mm'],
	[/_um$/, 'µm'],
	[/_celsius$/, '°C'],
	[/_db$/, 'dB'],
];

function words(key: string): string {
	const text = key
		.replace(/_/g, ' ')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.trim()
		.split(/\s+/)
		.map((w) => WORD[w.toLowerCase()] ?? w.toLowerCase())
		.join(' ');
	return text ? text.charAt(0).toUpperCase() + text.slice(1) : key;
}

// "dominant_frequency_hz" -> { label: "Dominant frequency", unit: "Hz" }
export function labelAndUnit(key: string): { label: string; unit: string } {
	for (const [re, unit] of UNIT_SUFFIX) {
		if (re.test(key)) return { label: words(key.replace(re, '')), unit };
	}
	return { label: words(key), unit: '' };
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isScalar = (v: unknown): v is string | number | boolean | null | undefined => v === null || v === undefined || typeof v !== 'object';

function scalarText(v: unknown): string {
	if (v === null || v === undefined) return '';
	if (typeof v === 'boolean') return v ? 'Yes' : 'No';
	if (typeof v === 'number') return formatQuantity(v) || String(v);
	return String(v);
}

function fallbackText(v: unknown): string {
	try {
		const s = JSON.stringify(v);
		return s.length > 160 ? `${s.slice(0, 157)}…` : s;
	} catch {
		return '';
	}
}

function walk(group: StatGroup, value: unknown, path: string[], unit: string, depth: number) {
	const label = path.join(' › ');
	if (isScalar(value)) {
		const text = scalarText(value);
		if (text !== '') group.entries.push({ label, value: text, unit });
		return;
	}
	if (isPlain(value)) {
		if (depth >= MAX_DEPTH) {
			group.entries.push({ label, value: fallbackText(value), unit: '' });
			return;
		}
		for (const [k, v] of Object.entries(value)) {
			// A unit suffix is only trusted on the keys directly under a namespace (`sample_rate_hz`).
			// Deeper keys are often data, not quantities: in band_energy { low_0_100_hz: 0.4 } the
			// "hz" names the band and the 0.4 is an energy, so those keep the key as their label.
			const l = depth === 0 ? labelAndUnit(k) : { label: words(k), unit: '' };
			walk(group, v, [...path, l.label], l.unit, depth + 1);
		}
		return;
	}
	const list = value as unknown[];
	if (!list.length) return;
	if (list.every(isScalar)) {
		const shown = list.slice(0, MAX_LIST_ITEMS).map(scalarText).join(', ');
		const extra = list.length - MAX_LIST_ITEMS;
		group.entries.push({ label, value: extra > 0 ? `${shown} … (+${extra} more)` : shown, unit });
		return;
	}
	if (list.every((r) => isPlain(r) && Object.values(r).every(isScalar))) {
		const keys: string[] = [];
		for (const r of list as Record<string, unknown>[]) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
		const cols = keys.slice(0, MAX_TABLE_COLUMNS);
		const heads = cols.map((k) => {
			const l = labelAndUnit(k);
			return l.unit ? `${l.label} (${l.unit})` : l.label;
		});
		const rows = (list as Record<string, unknown>[]).slice(0, MAX_TABLE_ROWS).map((r) => cols.map((k) => scalarText(r[k])));
		group.tables.push({ label, columns: heads, rows, more: Math.max(0, list.length - MAX_TABLE_ROWS) });
		return;
	}
	group.entries.push({ label, value: fallbackText(list), unit: '' });
}

function parse(stats: unknown): unknown {
	if (typeof stats !== 'string') return stats;
	try {
		return JSON.parse(stats);
	} catch {
		return null;
	}
}

export function summaryGroups(stats: unknown): StatGroup[] {
	const root = parse(stats);
	if (!isPlain(root)) return [];
	const groups: StatGroup[] = [];
	const loose: StatGroup = { key: '_summary', title: 'Summary', entries: [], tables: [] };
	for (const [key, value] of Object.entries(root)) {
		if (isPlain(value)) {
			const g: StatGroup = { key, title: GROUP_TITLE[key] ?? words(key), entries: [], tables: [] };
			walk(g, value, [], '', 0);
			if (g.entries.length || g.tables.length) groups.push(g);
		} else {
			const l = labelAndUnit(key);
			walk(loose, value, [l.label], l.unit, 1);
		}
	}
	if (loose.entries.length || loose.tables.length) groups.unshift(loose);
	return groups;
}

// How many values the results hold, for the section count.
export function summaryCount(groups: StatGroup[]): number {
	return groups.reduce((n, g) => n + g.entries.length + g.tables.length, 0);
}
