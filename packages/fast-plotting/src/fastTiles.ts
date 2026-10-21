// What a plot tile says about itself: a title for what it shows and its peak. Pure, so the wording is tested.

import { fmtNum, unitLabel, type TileSpan } from './chartMath';

export interface TileSeries { label: string; unit: string; group: string; values: Float64Array; }
/** A plot tile as saved with the page layout. */
export interface Tile { id: number; series: string[]; span: TileSpan; normalise: boolean; }
export const MAX_TILES = 6;

const SPANS: TileSpan[] = ['sm', 'wide', 'tall', 'big'];
/** The tiles of a saved layout, with anything malformed dropped (the storage is the user's, and old). */
export function validTiles(saved: unknown): Tile[] {
	if (!Array.isArray(saved)) return [];
	const seen = new Set<number>();
	const out: Tile[] = [];
	for (const t of saved) {
		if (!t || !Number.isInteger(t.id) || seen.has(t.id) || !SPANS.includes(t.span) || !Array.isArray(t.series)) continue;
		seen.add(t.id);
		out.push({ id: t.id, series: t.series.filter((k: unknown) => typeof k === 'string'), span: t.span, normalise: t.normalise === true });
	}
	return out.slice(0, MAX_TILES);
}

// On first open (no saved layout) the grid is six tiles, one per main series category present in the trace
// (temperature, force, power, ...), so a run shows its whole picture at once instead of empty tiles.
export const SEED_GROUP_ORDER = ['temp', 'force', 'power', 'pressure', 'position', 'vacuum', 'speed', 'voltage', 'current', 'flow'];
const SEED_MAX_LINES: Record<string, number> = { temp: 6 };   // temperature gets the pyrometer and the TCs; the others stay focused
/** How a run plotter seeds its first tiles (a RunProfile's seed fields); the default is FAST's. */
export interface SeedOptions { groups?: string[]; series?: Record<string, string[]>; strict?: boolean }
export function seedTiles(catalog: Array<{ key: string; group: string }>, firstId: number, opts: SeedOptions = {}): Tile[] {
	const order = opts.groups ?? SEED_GROUP_ORDER;
	const byGroup: Record<string, string[]> = {};
	for (const c of catalog) (byGroup[c.group || 'other'] ||= []).push(c.key);
	const have = new Set(catalog.map((c) => c.key));
	// a group the profile names series for is drawn from those series (the ones the run has), not the group's first few
	const picked = (g: string): string[] => (opts.series?.[g] ? opts.series[g].filter((k) => have.has(k)) : byGroup[g]?.slice(0, SEED_MAX_LINES[g] ?? 3) ?? []);
	const groups = [
		...order.filter((g) => picked(g).length),
		...(opts.strict ? [] : Object.keys(byGroup).filter((g) => !order.includes(g))),
	].slice(0, MAX_TILES);
	return groups.map((g, i) => ({ id: firstId + i, series: picked(g), span: 'sm' as const, normalise: false }));
}

const GROUP_TITLES: Record<string, string> = {
	temp: 'Temperature', force: 'Force', position: 'Position', pressure: 'Pressure', power: 'Power', voltage: 'Voltage',
	current: 'Current', speed: 'Speed', flow: 'Flow', percent: 'Percent', other: 'Other',
	torque: 'Torque', ips: 'IPS', cooling: 'Cooling',
};
export function groupTitle(group: string): string {
	return GROUP_TITLES[group] ?? (group ? group[0].toUpperCase() + group.slice(1) : 'Other');
}

/** One series is titled by its own name, several of one quantity by that quantity, a mixed tile by its quantities. */
export function tileTitle(series: TileSeries[]): string {
	if (series.length === 0) return '';
	if (series.length === 1) return series[0].label;
	const groups = [...new Set(series.map((s) => groupTitle(s.group)))];
	return groups.length <= 2 ? groups.join(' + ') : `${groups[0]} + ${groups.length - 1} more`;
}

/** The highest value of the tile's series, when they share one unit (a peak across units means nothing). */
export function tilePeak(series: TileSeries[]): { value: string; unit: string } | null {
	if (series.length === 0 || new Set(series.map((s) => s.unit)).size !== 1) return null;
	let top = -Infinity;
	for (const s of series) for (let i = 0; i < s.values.length; i++) if (s.values[i] > top) top = s.values[i];
	return Number.isFinite(top) ? { value: fmtNum(top), unit: unitLabel(series[0].unit) } : null;
}
