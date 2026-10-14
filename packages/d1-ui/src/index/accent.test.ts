import { describe, expect, it } from 'vitest';
import { accentColour, rowAccent } from './accent';
import { indexDefBySlug } from './indexConfig';
import { extraFields } from './indexView';

describe('accentColour', () => {
	it('accepts a #rrggbb colour in either case', () => {
		expect(accentColour('#0066CC')).toBe('#0066CC');
		expect(accentColour('#0066cc')).toBe('#0066cc');
	});
	it('refuses anything that is not exactly #rrggbb, so nothing else reaches a style', () => {
		for (const bad of [null, undefined, 42, '', 'red', '#fff', '#0066CCaa', '0066CC', '#00GGCC', ' #0066CC', '#0066CC;background:url(x)', 'url(x)']) {
			expect(accentColour(bad)).toBeNull();
		}
	});
});

describe('rowAccent', () => {
	const iso = indexDefBySlug('iso-classes')!;
	it('reads the def\'s accent field', () => {
		expect(rowAccent(iso, { iso_code: 'P', colour_hex: '#0066CC' })).toBe('#0066CC');
		expect(rowAccent(iso, { iso_code: 'P', colour_hex: null })).toBeNull();
	});
	it('is null for a list with no accent field', () => {
		expect(rowAccent(indexDefBySlug('methods')!, { colour_hex: '#0066CC' })).toBeNull();
	});
	it('is fetched for the ISO classes, and only there', () => {
		expect(iso.accentField).toBe('colour_hex');
		expect(extraFields(iso)).toContain('colour_hex');
		expect(extraFields(indexDefBySlug('methods')!)).not.toContain('colour_hex');
	});
});
