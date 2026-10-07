import { describe, expect, it } from 'vitest';
import { labelAndUnit, summaryCount, summaryGroups } from './summary';

// Shapes written by plugins/heavy-data-worker ("basic") and plugins/analysis-worker ("fft_analysis").
const stats = {
	basic: {
		n_samples: 1536000,
		n_channels: 2,
		sample_rate_hz: 25600,
		duration_seconds: 60,
		channels: [
			{ index: 0, min: -12.5, max: 48.25, mean: 3.1, std: 0.000004 },
			{ index: 1, min: -1, max: 1, mean: 0, std: 0.5 },
		],
	},
	fft_analysis: {
		channel: 'Fx',
		rms: 12.3456,
		dominant_frequency_hz: 187.5,
		top_frequencies: [
			{ frequency_hz: 187.5, magnitude: 3.2 },
			{ frequency_hz: 375, magnitude: 1.1 },
		],
		band_energy: { low: 0.4, high: { a: 0.1, b: 0.2 } },
	},
};

describe('labelAndUnit', () => {
	it('splits a trailing unit off the key', () => {
		expect(labelAndUnit('dominant_frequency_hz')).toEqual({ label: 'Dominant frequency', unit: 'Hz' });
		expect(labelAndUnit('duration_seconds')).toEqual({ label: 'Duration', unit: 's' });
		expect(labelAndUnit('max_stress_mpa')).toEqual({ label: 'Max stress', unit: 'MPa' });
	});
	it('capitalises known acronyms and leaves other keys alone', () => {
		expect(labelAndUnit('rms')).toEqual({ label: 'RMS', unit: '' });
		expect(labelAndUnit('n_samples')).toEqual({ label: 'N samples', unit: '' });
	});
});

describe('summaryGroups', () => {
	const groups = summaryGroups(stats);

	it('makes one group per top-level namespace, with readable titles', () => {
		expect(groups.map((g) => [g.key, g.title])).toEqual([
			['basic', 'Basic statistics'],
			['fft_analysis', 'FFT analysis'],
		]);
	});
	it('turns scalars into formatted rows with units', () => {
		const basic = groups[0];
		expect(basic.entries).toContainEqual({ label: 'N samples', value: '1,536,000', unit: '' });
		expect(basic.entries).toContainEqual({ label: 'Sample rate', value: '25,600', unit: 'Hz' });
		expect(basic.entries).toContainEqual({ label: 'Duration', value: '60', unit: 's' });
	});
	it('turns a list of records into a table, formatting each cell', () => {
		const t = groups[0].tables[0];
		expect(t.label).toBe('Channels');
		expect(t.columns).toEqual(['Index', 'Min', 'Max', 'Mean', 'Std']);
		expect(t.rows[0]).toEqual(['0', '-12.5', '48.25', '3.1', '4e-6']);
		expect(t.more).toBe(0);
	});
	it('names a table column with its unit', () => {
		const t = groups[1].tables[0];
		expect(t.label).toBe('Top frequencies');
		expect(t.columns).toEqual(['Frequency (Hz)', 'Magnitude']);
	});
	it('flattens nested objects into "Parent › child" rows', () => {
		const labels = groups[1].entries.map((e) => e.label);
		expect(labels).toContain('Band energy › Low');
		expect(labels).toContain('Band energy › High › A');
		expect(labels).toContain('RMS');
	});
	it('keeps a unit-looking suffix in the label when it is part of a nested key', () => {
		const g = summaryGroups({ fft_analysis: { dominant_frequency_hz: 5, band_energy: { low_0_100_hz: 0.4 } } })[0];
		expect(g.entries).toContainEqual({ label: 'Dominant frequency', value: '5', unit: 'Hz' });
		expect(g.entries).toContainEqual({ label: 'Band energy › Low 0 100 Hz', value: '0.4', unit: '' });
	});
	it('counts what the page will show', () => {
		expect(summaryCount(groups)).toBe(groups.reduce((n, g) => n + g.entries.length + g.tables.length, 0));
		expect(summaryCount(groups)).toBeGreaterThan(8);
	});
});

describe('summaryGroups edge cases', () => {
	it('puts flat legacy values into a Summary group first', () => {
		const g = summaryGroups({ mean_hardness: 312.4, basic: { n_samples: 5 } });
		expect(g.map((x) => x.title)).toEqual(['Summary', 'Basic statistics']);
		expect(g[0].entries).toEqual([{ label: 'Mean hardness', value: '312.4', unit: '' }]);
	});
	it('accepts the JSON as a string and survives garbage', () => {
		expect(summaryGroups('{"basic":{"n":3}}')).toHaveLength(1);
		expect(summaryGroups('not json')).toEqual([]);
		expect(summaryGroups(null)).toEqual([]);
		expect(summaryGroups([1, 2])).toEqual([]);
		expect(summaryGroups({})).toEqual([]);
	});
	it('shows booleans as Yes / No and skips nulls and empty lists', () => {
		const g = summaryGroups({ x: { ok: true, none: null, empty: [] } });
		expect(g[0].entries).toEqual([{ label: 'Ok', value: 'Yes', unit: '' }]);
	});
	it('joins short scalar lists and caps long ones', () => {
		const g = summaryGroups({ x: { few: [1, 2, 3], many: Array.from({ length: 13 }, (_, i) => i) } });
		expect(g[0].entries[0].value).toBe('1, 2, 3');
		expect(g[0].entries[1].value).toBe('0, 1, 2, 3, 4, 5, 6, 7, 8, 9 … (+3 more)');
	});
	it('caps table rows and reports how many were left out', () => {
		const rows = Array.from({ length: 25 }, (_, i) => ({ i }));
		const t = summaryGroups({ x: { rows } })[0].tables[0];
		expect(t.rows).toHaveLength(20);
		expect(t.more).toBe(5);
	});
	it('falls back to JSON for deep or mixed structures instead of dropping them', () => {
		const g = summaryGroups({ x: { mixed: [1, { a: 1 }], deep: { a: { b: { c: { d: 1 } } } } } });
		expect(g[0].entries.map((e) => e.label)).toEqual(['Mixed', 'Deep › A › B › C']);
		expect(g[0].entries[1].value).toBe('{"d":1}');
	});
});
