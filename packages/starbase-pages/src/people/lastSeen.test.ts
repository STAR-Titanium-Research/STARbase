import { describe, expect, it } from 'vitest';
import { lastSeen } from './lastSeen';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3_600_000;

describe('lastSeen', () => {
	it('shows a dash when there is no sign-in or it cannot be read', () => {
		expect(lastSeen(null, NOW)).toBe('—');
		expect(lastSeen(undefined, NOW)).toBe('—');
		expect(lastSeen('not a date', NOW)).toBe('—');
	});
	it('says minutes and hours for today', () => {
		expect(lastSeen(ago(10_000), NOW)).toBe('just now');
		expect(lastSeen(ago(5 * 60_000), NOW)).toBe('5 min ago');
		expect(lastSeen(ago(2 * H), NOW)).toBe('2 h ago');
		expect(lastSeen(ago(23 * H), NOW)).toBe('23 h ago');
	});
	it('says yesterday and then days up to a week', () => {
		expect(lastSeen(ago(30 * H), NOW)).toBe('yesterday');
		expect(lastSeen(ago(3 * 24 * H), NOW)).toBe('3 d ago');
		expect(lastSeen(ago(6 * 24 * H + 23 * H), NOW)).toBe('6 d ago');
	});
	it('gives the date after seven days', () => {
		expect(lastSeen('2026-10-01T12:00:00Z', NOW)).toBe('1 Oct 2026');
	});
	it('treats a time ahead of the clock as just now', () => {
		expect(lastSeen(ago(-5 * H), NOW)).toBe('just now');
	});
});
