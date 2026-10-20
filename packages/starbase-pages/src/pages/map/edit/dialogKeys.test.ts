import { describe, expect, it } from 'vitest';
import { enterConfirms } from './dialogKeys';

const el = (inside: string | null) => ({ closest: (sel: string) => (inside && sel.split(',').map((x) => x.trim()).includes(inside) ? {} : null) });

describe('enterConfirms', () => {
	it('confirms from a field', () => {
		expect(enterConfirms(el(null))).toBe(true);
		expect(enterConfirms({})).toBe(true);
		expect(enterConfirms(null)).toBe(true);
	});

	it('leaves a button to do what it says (Cancel must not duplicate)', () => {
		expect(enterConfirms(el('button'))).toBe(false);
		expect(enterConfirms(el('[role="button"]'))).toBe(false);
	});
});
