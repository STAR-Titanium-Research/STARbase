import { describe, expect, it } from 'vitest';
import { shellView, userLabel } from './shellView';
import type { SessionState } from './session';

describe('shellView', () => {
	const states: SessionState[] = ['unknown', 'signed-in', 'signed-out', 'unreachable'];
	const expected: Record<SessionState, { public: string; page: string }> = {
		unknown: { public: 'route', page: 'none' },
		'signed-in': { public: 'route', page: 'route' },
		// A signed-out user on a signed-in page: the shell must not mount (no Explorer host exists for them);
		// the guard's redirect to /signin is on its way.
		'signed-out': { public: 'route', page: 'none' },
		unreachable: { public: 'unreachable', page: 'unreachable' },
	};
	for (const state of states) {
		it(`${state}: public page -> ${expected[state].public}, signed-in page -> ${expected[state].page}`, () => {
			expect(shellView(state, true)).toBe(expected[state].public);
			expect(shellView(state, false)).toBe(expected[state].page);
		});
	}
});

describe('userLabel', () => {
	it('is the first name when there is one', () => {
		expect(userLabel({ id: '1', role: null, first_name: 'Ada', email: 'ada@x.org' })).toBe('Ada');
	});
	it('falls back to the email when the first name is missing or blank', () => {
		expect(userLabel({ id: '1', role: null, email: 'ada@x.org' })).toBe('ada@x.org');
		expect(userLabel({ id: '1', role: null, first_name: '  ', email: 'ada@x.org' })).toBe('ada@x.org');
	});
	it('is empty with neither, or with nobody signed in', () => {
		expect(userLabel({ id: '1', role: null })).toBe('');
		expect(userLabel(null)).toBe('');
	});
});
