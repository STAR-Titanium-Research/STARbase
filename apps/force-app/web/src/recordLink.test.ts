import { describe, expect, it } from 'vitest';
import { recordLink } from './recordLink';

describe('recordLink', () => {
	it('is the permanent link on the Directus host, id encoded, trailing slashes dropped', () => {
		expect(recordLink('https://d1.example.org/', 'physical_samples', 'a/b c')).toBe('https://d1.example.org/d1-links/go/r/physical_samples/a%2Fb%20c');
		expect(recordLink('https://d1.example.org', 'equipment', 7)).toBe('https://d1.example.org/d1-links/go/r/equipment/7');
	});
});
