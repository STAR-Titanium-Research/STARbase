import { describe, expect, it } from 'vitest';
import { needsReload } from './userSwitch';

describe('needsReload', () => {
	it('first sign-in of this page load: no reload', () => {
		expect(needsReload(null, 'u1')).toBe(false);
	});
	it('the same user signing in again: no reload', () => {
		expect(needsReload('u1', 'u1')).toBe(false);
	});
	it('a different user after a sign-out: reload, so no cache or in-flight read from the last user survives', () => {
		expect(needsReload('u1', 'u2')).toBe(true);
	});
	it('nobody signed in: no reload', () => {
		expect(needsReload('u1', null)).toBe(false);
		expect(needsReload('u1', undefined)).toBe(false);
		expect(needsReload(null, null)).toBe(false);
	});
});
