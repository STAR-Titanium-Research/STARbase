import { describe, expect, it } from 'vitest';
import { LAB_VIEWER_ROLE_ID, guessAdmin, isLabViewerRole } from './hostAdmin';

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

describe('isLabViewerRole', () => {
	it('is the Lab Viewer role id of the migration and the endpoints', () => {
		expect(LAB_VIEWER_ROLE_ID).toBe('10000001-0000-0000-0000-000000000003');
		expect(isLabViewerRole(LAB_VIEWER_ROLE_ID)).toBe(true);
	});
	it('compares without case and reads a role object by its id', () => {
		expect(isLabViewerRole(LAB_VIEWER_ROLE_ID.toUpperCase())).toBe(true);
		expect(isLabViewerRole({ id: LAB_VIEWER_ROLE_ID, name: 'Lab Viewer' })).toBe(true);
	});
	it('is false for the other roles, no role, and anything that is not an id', () => {
		for (const r of ['10000001-0000-0000-0000-000000000001', '10000001-0000-0000-0000-000000000002', 'r1', '', null, undefined, {}, { id: null }, 3, true]) {
			expect(isLabViewerRole(r)).toBe(false);
		}
	});
	it('takes another id (an app that moved the role)', () => {
		expect(isLabViewerRole('abc', 'ABC')).toBe(true);
		expect(isLabViewerRole(LAB_VIEWER_ROLE_ID, 'abc')).toBe(false);
	});
});
