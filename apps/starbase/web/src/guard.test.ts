import { describe, expect, it } from 'vitest';
import { guardDecision, homeRedirect, type GuardTarget } from './guard';

const to = (fullPath: string, meta: Record<string, unknown> = {}): GuardTarget => {
	const [path, q = ''] = fullPath.split('?');
	return { path, fullPath, meta, query: Object.fromEntries(new URLSearchParams(q)) };
};

describe('guardDecision', () => {
	it('lets a signed-in user through', () => {
		expect(guardDecision(to('/samples/1'), 'signed-in')).toBe(true);
	});
	it('sends a signed-out user to sign in, remembering the page (Review Focus 2)', () => {
		expect(guardDecision(to('/samples/a%2Fb?x=1'), 'signed-out')).toBe(`/signin?next=${encodeURIComponent('/samples/a%2Fb?x=1')}`);
		expect(guardDecision(to('/'), 'signed-out')).toBe('/signin');
	});
	it('the sign-in pages are public; a signed-in user on /signin goes straight on, safely', () => {
		expect(guardDecision(to('/signin'), 'signed-out')).toBe(true);
		expect(guardDecision(to('/signin/done', { public: true }), 'signed-out')).toBe(true);
		expect(guardDecision(to('/signin?next=%2Fsamples%2F1'), 'signed-in')).toBe('/samples/1');
		expect(guardDecision(to('/signin?next=%2F%2Fevil.example'), 'signed-in')).toBe('/');
	});
	it('unreachable lets the route through: App shows the full-page state over it (Review Focus 5)', () => {
		expect(guardDecision(to('/samples/1'), 'unreachable')).toBe(true);
	});
});

describe('homeRedirect', () => {
	it('drops /home from an old Directus-form link, keeping the rest', () => {
		expect(homeRedirect('/home')).toBe('/');
		expect(homeRedirect('/home/')).toBe('/');
		expect(homeRedirect('/home?q=1')).toBe('/?q=1');
		expect(homeRedirect('/home/samples/a%2Fb?x=1#k')).toBe('/samples/a%2Fb?x=1#k');
		expect(homeRedirect('/home/labels?ids=1,2')).toBe('/labels?ids=1,2');
	});
});
