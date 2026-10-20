import { describe, expect, it } from 'vitest';
import { factsDiff } from './factsDiff';

const sem = (over: Record<string, unknown> = {}, size_bytes: number | null = 1048576) => ({
	extracted: { kv: 15, working_distance_mm: 8.5, magnification: 5000, spot: 4, detector: 'SE', mode: 'high vacuum', pixel_size_nm: 100, acquired_at: '2026-03-02T10:15:00Z', sources: { kv: 'metadata' }, flags: {}, ...over },
	size_bytes,
});
const byKey = (rows: ReturnType<typeof factsDiff>) => Object.fromEntries(rows.map((r) => [r.key, r]));

describe('the facts of two files', () => {
	it('lists kV, working distance, magnification, spot, detector, mode, pixel size, taken and size, in that order', () => {
		const rows = factsDiff(sem(), sem());
		expect(rows.map((r) => r.key)).toEqual(['kv', 'working_distance_mm', 'magnification', 'spot', 'detector', 'mode', 'pixel_size_nm', 'acquired_at', 'size']);
		expect(rows.map((r) => r.label)).toEqual(['kV', 'working distance', 'magnification', 'spot', 'detector', 'mode', 'pixel size', 'taken', 'size']);
		expect(rows.every((r) => !r.differs)).toBe(true);
	});

	it('shows the values as the imaging settings do, and marks the rows that differ', () => {
		const r = byKey(factsDiff(sem(), sem({ kv: 20, magnification: 10000, detector: 'BSE' }, 2097152)));
		expect(r.kv).toMatchObject({ a: '15 kV', b: '20 kV', differs: true });
		expect(r.magnification).toMatchObject({ a: '×5,000', b: '×10,000', differs: true });
		expect(r.detector).toMatchObject({ a: 'SE', b: 'BSE', differs: true });
		expect(r.size).toMatchObject({ a: '1 MB', b: '2 MB', differs: true });
		expect(r.spot.differs).toBe(false);
		expect(r.pixel_size_nm).toMatchObject({ a: '100 nm', b: '100 nm', differs: false });
	});

	it('compares what is shown, so the same value written two ways is the same', () => {
		const r = byKey(factsDiff(sem({ kv: 15 }), sem({ kv: 15.0 })));
		expect(r.kv.differs).toBe(false);
	});

	it('counts a value only one file has as different, and leaves out a row neither has', () => {
		const a = sem();
		const b = sem({ spot: undefined, detector: undefined, mode: undefined, acquired_at: undefined, working_distance_mm: undefined });
		const r = byKey(factsDiff(a, b));
		expect(r.spot).toMatchObject({ a: '4', b: null, differs: true });
		const none = factsDiff({ extracted: {}, size_bytes: null }, { extracted: { kv: 15, sources: { kv: 'metadata' }, flags: {} }, size_bytes: null });
		expect(none.map((x) => x.key)).toEqual(['kv']);
		expect(none[0]).toMatchObject({ a: null, b: '15 kV', differs: true });
		expect(factsDiff({ extracted: {}, size_bytes: null }, { extracted: {}, size_bytes: null })).toEqual([]);
		// an older row (no sources, no flags) shows no settings in the sheet, so the diff shows none either
		expect(factsDiff({ extracted: { kv: 15 }, size_bytes: null }, { extracted: { kv: 20 }, size_bytes: null })).toEqual([]);
	});
});
