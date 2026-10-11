import { describe, expect, it } from 'vitest';
import { guessAdmin } from './hostAdmin';

describe('guessAdmin', () => {
	it('is false with no store or no user', () => {
		expect(guessAdmin(null)).toBe(false);
		expect(guessAdmin(undefined)).toBe(false);
		expect(guessAdmin({})).toBe(false);
		expect(guessAdmin({ currentUser: null })).toBe(false);
	});

	it('reads the store flag first', () => {
		expect(guessAdmin({ isAdmin: true })).toBe(true);
		// An explicit false from the store is an answer: it is not overridden by a later place.
		expect(guessAdmin({ isAdmin: false, currentUser: { admin_access: true } })).toBe(false);
	});

	it('falls back to the user, then to the user\'s role', () => {
		expect(guessAdmin({ currentUser: { admin_access: true } })).toBe(true);
		expect(guessAdmin({ currentUser: { role: { admin_access: true } } })).toBe(true);
		expect(guessAdmin({ isAdmin: null, currentUser: { admin_access: null, role: { admin_access: true } } })).toBe(true);
		expect(guessAdmin({ currentUser: { admin_access: false, role: { admin_access: true } } })).toBe(false);
	});

	it('ignores a role that is only an id', () => {
		expect(guessAdmin({ currentUser: { role: 'abc' } })).toBe(false);
	});
});
