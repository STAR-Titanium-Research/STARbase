import { describe, expect, it } from 'vitest';
import { DEFAULT_TEAM_COLOR, TEAM_COLORS, TEAM_PALETTE, contrastRatio, isTeamColor, lightDark, paletteFor, relativeLuminance, teamInitials } from './teamPalette';

describe('contrast helpers', () => {
	it('reproduces the WCAG reference values', () => {
		expect(relativeLuminance('#000000')).toBe(0);
		expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
		expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
		expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 10);
		// order does not matter
		expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#777777'), 10);
		expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
	});
	it('refuses something that is not #rrggbb', () => {
		expect(() => relativeLuminance('teal')).toThrow();
	});
});

describe('TEAM_PALETTE', () => {
	it('has the ten keys of the teams table, in order', () => {
		expect(TEAM_COLORS).toEqual(['teal', 'blue', 'indigo', 'violet', 'pink', 'red', 'orange', 'amber', 'green', 'slate']);
		expect(Object.keys(TEAM_PALETTE).sort()).toEqual([...TEAM_COLORS].sort());
	});
	for (const color of TEAM_COLORS) {
		for (const scheme of ['light', 'dark'] as const) {
			it(`${color} ${scheme}: text on the tile is at least 4.5:1`, () => {
				const { bg, fg } = TEAM_PALETTE[color][scheme];
				expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
			});
		}
	}
	it('falls back to teal for an unknown or missing key', () => {
		expect(isTeamColor('blue')).toBe(true);
		expect(isTeamColor('mauve')).toBe(false);
		expect(paletteFor('mauve')).toBe(TEAM_PALETTE[DEFAULT_TEAM_COLOR]);
		expect(paletteFor(null)).toBe(TEAM_PALETTE.teal);
	});
	it('writes a light-dark() pair for a CSS property', () => {
		expect(lightDark('teal', 'bg')).toBe('light-dark(#0f766e, #115e59)');
		expect(lightDark('nope', 'fg')).toBe('light-dark(#ffffff, #ccfbf1)');
	});
});

describe('teamInitials', () => {
	it('takes the first letters of the first two words', () => {
		expect(teamInitials('Sintering Lab')).toBe('SL');
		expect(teamInitials('  the  big  furnace group ')).toBe('TB');
		expect(teamInitials('Atlas')).toBe('A');
	});
	it('has a placeholder for an empty name', () => {
		expect(teamInitials('')).toBe('?');
		expect(teamInitials('   ')).toBe('?');
	});
});
