import { describe, expect, it } from 'vitest';
import { contactEmailOf, contactLine, parseContactInput } from './settings';

describe('contactEmailOf', () => {
	it('reads the singleton row', () => {
		expect(contactEmailOf({ id: 1, contact_email: ' lab@example.org ' })).toBe('lab@example.org');
	});
	it('is null for no row, no email or an empty one', () => {
		expect(contactEmailOf(null)).toBeNull();
		expect(contactEmailOf([])).toBeNull();
		expect(contactEmailOf({ id: 1, contact_email: null })).toBeNull();
		expect(contactEmailOf({ id: 1, contact_email: '  ' })).toBeNull();
		expect(contactEmailOf({ id: 1, contact_email: 5 })).toBeNull();
	});
});

describe('parseContactInput', () => {
	it('accepts an email, trimmed, and an empty box (clears it)', () => {
		expect(parseContactInput(' lab@example.org ')).toEqual({ ok: true, value: 'lab@example.org' });
		expect(parseContactInput('')).toEqual({ ok: true, value: null });
		expect(parseContactInput('   ')).toEqual({ ok: true, value: null });
	});
	it('refuses what the database check would refuse', () => {
		for (const bad of ['lab', 'lab@', '@example.org', 'lab@example', 'a b@example.org', 'a@@example.org']) {
			expect(parseContactInput(bad).ok, bad).toBe(false);
		}
	});
});

describe('contactLine', () => {
	it('says what is set or that nothing is', () => {
		expect(contactLine('lab@example.org')).toBe('Contact on labels: lab@example.org');
		expect(contactLine(null)).toBe('No lab contact set');
	});
});
