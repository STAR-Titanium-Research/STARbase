import { describe, expect, it } from 'vitest';
import { TEAM_COLORS, teamColorClass } from './teamColor';

describe('teamColorClass', () => {
	it('has a class for each palette key', () => {
		expect(TEAM_COLORS).toHaveLength(10);
		for (const c of TEAM_COLORS) expect(teamColorClass(c)).toBe(`c-${c}`);
	});
	it('falls back to teal for an unknown or missing key', () => {
		expect(teamColorClass('mauve')).toBe('c-teal');
		expect(teamColorClass(null)).toBe('c-teal');
		expect(teamColorClass(undefined)).toBe('c-teal');
	});
});
