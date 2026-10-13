import { describe, expect, it } from 'vitest';
import { shellView } from './shellView';
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
