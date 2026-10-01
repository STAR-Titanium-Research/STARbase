import { describe, expect, it } from 'vitest';
import { CH_COLOR, CH_COLOR_LIGHT, channelColor } from './types';

// WCAG relative luminance / contrast ratio.
function luminance(hex: string): number {
	const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
		.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
	return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}
const LIGHT_PLOT_BG = '#eef1f6'; // --plot-bg, [data-theme="light"] in styles.css

describe('channelColor', () => {
	it('uses the canvas palette on the dark theme', () => {
		expect(channelColor('Fy', 'dark')).toBe(CH_COLOR.Fy);
	});

	it('uses the light variant on the light theme', () => {
		expect(channelColor('Fy', 'light')).toBe(CH_COLOR_LIGHT.Fy);
		expect(CH_COLOR_LIGHT.Fy).not.toBe(CH_COLOR.Fy);
	});

	it('returns undefined for an unknown channel (callers supply their own fallback)', () => {
		expect(channelColor('Nope', 'light')).toBeUndefined();
	});

	it('has a light variant for every channel, so none falls back to a dark-plot hue', () => {
		expect(Object.keys(CH_COLOR_LIGHT).sort()).toEqual(Object.keys(CH_COLOR).sort());
	});

	it('keeps each summed axis the colour of its first sub-channel, as on the dark theme', () => {
		for (const a of ['Fx', 'Fy', 'Fz']) {
			expect(CH_COLOR[a]).toBe(CH_COLOR[`${a}1`]);
			expect(CH_COLOR_LIGHT[a]).toBe(CH_COLOR_LIGHT[`${a}1`]);
		}
	});

	it('holds ~3:1 against the light plot ground for every channel (the dark hues did not)', () => {
		for (const [ch, col] of Object.entries(CH_COLOR_LIGHT)) {
			expect(contrast(col, LIGHT_PLOT_BG), ch).toBeGreaterThanOrEqual(2.8);
		}
		// The problem this palette exists for: the dark hue for Fy on the light plot.
		expect(contrast(CH_COLOR.Fy, LIGHT_PLOT_BG)).toBeLessThan(1.8);
	});
});
