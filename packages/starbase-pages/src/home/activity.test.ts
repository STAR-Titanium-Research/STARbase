import { describe, expect, it } from 'vitest';
import { detailLine, mergeActivity, relativeTime, type Activity } from './activity';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const item = (id: string, date: string, kind: Activity['kind'] = 'sample'): Activity => ({ kind, id, code: id, meta: '', date, to: `/${id}` });

describe('relativeTime', () => {
	it('reads seconds as just now', () => {
		expect(relativeTime(at(12_000), NOW)).toBe('just now');
		expect(relativeTime(at(-9000), NOW)).toBe('just now');
	});
	it('counts minutes, hours and days', () => {
		expect(relativeTime(at(5 * 60_000), NOW)).toBe('5 min ago');
		expect(relativeTime(at(3 * 3_600_000 + 1000), NOW)).toBe('3 h ago');
		expect(relativeTime(at(2 * 86_400_000), NOW)).toBe('2 d ago');
	});
	it('counts months and years for old records', () => {
		expect(relativeTime(at(65 * 86_400_000), NOW)).toBe('2 mo ago');
		expect(relativeTime(at(800 * 86_400_000), NOW)).toBe('2 y ago');
	});
	it('is empty for a missing or unreadable time', () => {
		expect(relativeTime(null, NOW)).toBe('');
		expect(relativeTime(undefined, NOW)).toBe('');
		expect(relativeTime('x', NOW)).toBe('');
	});
});

describe('mergeActivity', () => {
	it('merges the sources newest first', () => {
		const out = mergeActivity([
			[item('s1', at(5 * 3_600_000)), item('s2', at(1 * 3_600_000))],
			[item('o1', at(2 * 3_600_000), 'operation')],
			[item('t1', at(3 * 3_600_000), 'test')],
		]);
		expect(out.map((a) => a.id)).toEqual(['s2', 'o1', 't1', 's1']);
	});
	it('drops items without a readable date', () => {
		const out = mergeActivity([[item('a', ''), item('b', 'nope'), item('c', at(1000))]]);
		expect(out.map((a) => a.id)).toEqual(['c']);
	});
	it('keeps at most the limit', () => {
		const list = Array.from({ length: 20 }, (_, i) => item(`i${i}`, at(i * 1000)));
		expect(mergeActivity([list], 15)).toHaveLength(15);
		expect(mergeActivity([list], 15)[0].id).toBe('i0');
		expect(mergeActivity([list], 0)).toEqual([]);
	});
	it('keeps source order for equal times and tolerates no sources', () => {
		const d = at(1000);
		expect(mergeActivity([[item('a', d)], [item('b', d)]]).map((a) => a.id)).toEqual(['a', 'b']);
		expect(mergeActivity([])).toEqual([]);
	});
});

describe('detailLine', () => {
	it('names the kind and the detail', () => {
		expect(detailLine({ kind: 'sample', meta: 'Steel 316L' })).toBe('Sample · Steel 316L');
		expect(detailLine({ kind: 'fast', meta: 'S-12' })).toBe('FAST · S-12');
	});
	it('is only the kind when there is no detail', () => {
		expect(detailLine({ kind: 'operation', meta: '' })).toBe('Operation');
		expect(detailLine({ kind: 'test', meta: '—' })).toBe('Test');
	});
});
