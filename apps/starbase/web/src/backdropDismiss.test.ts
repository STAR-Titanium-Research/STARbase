import { describe, expect, it } from 'vitest';
import { backdropDismiss } from './backdropDismiss';

describe('backdropDismiss', () => {
	it('closes when the press started and ended on the backdrop', () => {
		expect(backdropDismiss(true, true)).toBe(true);
	});
	it('does not close when the press started inside the sheet and was released on the backdrop (a drag)', () => {
		expect(backdropDismiss(false, true)).toBe(false);
	});
	it('does not close when a click lands inside the sheet', () => {
		expect(backdropDismiss(true, false)).toBe(false);
		expect(backdropDismiss(false, false)).toBe(false);
	});
});
