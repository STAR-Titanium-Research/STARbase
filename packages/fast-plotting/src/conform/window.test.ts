import { describe, expect, it } from 'vitest';
import { ukInputValue } from './clock';
import { resolveWindowEntry } from './window';

const LOG = { log_start: '2025-01-15T10:00:00.250Z', log_end: '2025-01-15T10:14:59.250Z' };
const iso = (ms: number) => new Date(ms).toISOString();
const NONE = { start: null, end: null };

describe('resolveWindowEntry', () => {
	it('keeps the stored instant of a field that was not edited, fractions included', () => {
		const stored = { start: '2025-01-15T10:00:00.250Z', end: '2025-01-15T10:14:59.250Z' };
		const r = resolveWindowEntry({ startLocal: ukInputValue(stored.start), endLocal: ukInputValue(stored.end) }, stored, LOG);
		expect(r).toMatchObject({ ok: true, notes: [] });
		if (r.ok) expect([iso(r.startMs), iso(r.endMs)]).toEqual([stored.start, stored.end]);
	});

	it('reads only the edited field as typed, and keeps the other exactly', () => {
		const stored = { start: '2025-01-15T10:00:00.250Z', end: '2025-01-15T10:14:59.250Z' };
		const r = resolveWindowEntry({ startLocal: '2025-01-15T10:05:00', endLocal: ukInputValue(stored.end) }, stored, LOG);
		expect(r.ok).toBe(true);
		if (r.ok) expect([iso(r.startMs), iso(r.endMs)]).toEqual(['2025-01-15T10:05:00.000Z', stored.end]);
	});

	it('reads a summer-time entry as UK time', () => {
		const log = { log_start: '2025-07-01T08:00:00Z', log_end: '2025-07-01T09:00:00Z' };
		const r = resolveWindowEntry({ startLocal: '2025-07-01T09:10:00', endLocal: '2025-07-01T09:50:00' }, NONE, log);
		expect(r.ok).toBe(true);
		if (r.ok) expect([iso(r.startMs), iso(r.endMs)]).toEqual(['2025-07-01T08:10:00.000Z', '2025-07-01T08:50:00.000Z']);
	});

	it('clamps an edited value to the log and says so', () => {
		const r = resolveWindowEntry({ startLocal: '2025-01-15T09:00:00', endLocal: '2025-01-15T11:00:00' }, NONE, LOG);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect([iso(r.startMs), iso(r.endMs)]).toEqual([LOG.log_start, LOG.log_end]);
		expect(r.notes).toHaveLength(2);
		expect(r.notes[0]).toMatch(/start was before the log.*2025-01-15 10:00:00, UK time/);
		expect(r.notes[1]).toMatch(/end was after the log.*2025-01-15 10:14:59, UK time/);
	});

	it('does not clamp a stored instant, even one the log row would round differently', () => {
		const stored = { start: '2025-01-15T10:00:00.000Z', end: '2025-01-15T10:10:00.000Z' };   // start is before log_start by 250 ms
		const r = resolveWindowEntry({ startLocal: ukInputValue(stored.start), endLocal: ukInputValue(stored.end) }, stored, LOG);
		expect(r).toMatchObject({ ok: true, notes: [] });
	});

	it('refuses what is not a clock time, and an empty or inverted window', () => {
		expect(resolveWindowEntry({ startLocal: '', endLocal: '2025-01-15T10:10:00' }, NONE, LOG)).toMatchObject({ ok: false, error: expect.stringMatching(/UK clock times/) });
		expect(resolveWindowEntry({ startLocal: '2025-01-15T10:10:00', endLocal: '2025-01-15T10:05:00' }, NONE, LOG)).toMatchObject({ ok: false, error: expect.stringMatching(/start before it ends/) });
		expect(resolveWindowEntry({ startLocal: '2025-01-15T10:10:00', endLocal: '2025-01-15T10:10:00' }, NONE, LOG).ok).toBe(false);
	});
});
