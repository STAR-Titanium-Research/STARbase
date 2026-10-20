import { describe, expect, it } from 'vitest';
import { groupTitle, seedTiles, tilePeak, tileTitle, type TileSeries } from './fastTiles';

const s = (label: string, group: string, unit: string, ...values: number[]): TileSeries => ({ label, group, unit, values: Float64Array.from(values) });

describe('tileTitle', () => {
	it('is empty for no series', () => {
		expect(tileTitle([])).toBe('');
	});
	it('names a single series by its label', () => {
		expect(tileTitle([s('Ram force', 'force', 'kN', 1)])).toBe('Ram force');
	});
	it('names several series of one quantity by the quantity', () => {
		expect(tileTitle([s('Pyrometer', 'temp', 'C', 1), s('TC top', 'temp', 'C', 1)])).toBe('Temperature');
	});
	it('names a mixed tile by its quantities', () => {
		expect(tileTitle([s('a', 'temp', 'C', 1), s('b', 'force', 'kN', 1)])).toBe('Temperature + Force');
		expect(tileTitle([s('a', 'temp', 'C', 1), s('b', 'force', 'kN', 1), s('c', 'power', 'kW', 1)])).toBe('Temperature + 2 more');
	});
});

describe('groupTitle', () => {
	it('knows the catalog groups and capitalises others', () => {
		expect(groupTitle('pressure')).toBe('Pressure');
		expect(groupTitle('weird')).toBe('Weird');
		expect(groupTitle('')).toBe('Other');
	});
});

describe('tilePeak', () => {
	it('is the highest value over the series, with the unit as printed', () => {
		expect(tilePeak([s('a', 'temp', 'C', 20, 1362.4, NaN), s('b', 'temp', 'C', 1340)])).toEqual({ value: '1362', unit: '°C' });
		expect(tilePeak([s('a', 'force', 'kN', 5, 30)])).toEqual({ value: '30.0', unit: 'kN' });
	});
	it('is absent for mixed units, no series or no finite values', () => {
		expect(tilePeak([s('a', 'temp', 'C', 1), s('b', 'force', 'kN', 1)])).toBeNull();
		expect(tilePeak([])).toBeNull();
		expect(tilePeak([s('a', 'temp', 'C', NaN)])).toBeNull();
	});
});

describe('seedTiles', () => {
	const cat = (key: string, group: string) => ({ key, group });
	it('makes one tile per category present, the preferred ones first, at most six', () => {
		const tiles = seedTiles([cat('p', 'power'), cat('t1', 'temp'), cat('t2', 'temp'), cat('f', 'force'), cat('x', 'weird'), cat('v', 'voltage'), cat('s', 'speed'), cat('q', 'pressure')], 10);
		expect(tiles.map((t) => t.series)).toEqual([['t1', 't2'], ['f'], ['p'], ['q'], ['s'], ['v']]);
		expect(tiles.map((t) => t.id)).toEqual([10, 11, 12, 13, 14, 15]);
		expect(tiles[0]).toMatchObject({ span: 'sm', normalise: false });
	});
	it('caps the lines of a tile: six for temperature, three for the rest', () => {
		const temps = Array.from({ length: 8 }, (_, i) => cat(`t${i}`, 'temp'));
		const forces = Array.from({ length: 5 }, (_, i) => cat(`f${i}`, 'force'));
		const [t, f] = seedTiles([...temps, ...forces], 1);
		expect(t.series).toHaveLength(6);
		expect(f.series).toHaveLength(3);
	});
	it('makes none for an empty catalog', () => {
		expect(seedTiles([], 1)).toEqual([]);
	});
});
