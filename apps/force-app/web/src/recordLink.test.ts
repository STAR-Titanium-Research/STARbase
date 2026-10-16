import { describe, expect, it } from 'vitest';
import { forgotPasswordLink, recordLink } from './recordLink';

describe('forgotPasswordLink', () => {
	it('is STARbase\'s forgot-password page through the permanent link, carrying a typed e-mail', () => {
		expect(forgotPasswordLink('https://d1.example.org/')).toBe('https://d1.example.org/d1-links/go/p/forgot-password');
		expect(forgotPasswordLink('https://d1.example.org', '  a+b@x.ac.uk ')).toBe('https://d1.example.org/d1-links/go/p/forgot-password?email=a%2Bb%40x.ac.uk');
		expect(forgotPasswordLink('', '   ')).toBe('/d1-links/go/p/forgot-password');
	});
});

describe('recordLink', () => {
	it('is the permanent link on the Directus host, id encoded, trailing slashes dropped', () => {
		expect(recordLink('https://d1.example.org/', 'physical_samples', 'a/b c')).toBe('https://d1.example.org/d1-links/go/r/physical_samples/a%2Fb%20c');
		expect(recordLink('https://d1.example.org', 'equipment', 7)).toBe('https://d1.example.org/d1-links/go/r/equipment/7');
	});
});
