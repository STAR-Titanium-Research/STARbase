import { describe, expect, it } from 'vitest';
import { returnFocusToMenu } from './sheetFocus';

describe('returnFocusToMenu', () => {
	it('returns to the Menu button on a plain close on a phone', () => {
		expect(returnFocusToMenu({ narrow: true, handedOff: false })).toBe(true);
	});
	it('does not when the finder took focus from the sheet', () => {
		expect(returnFocusToMenu({ narrow: true, handedOff: true })).toBe(false);
	});
	it('does not when the window grew past phone width (no Menu button any more)', () => {
		expect(returnFocusToMenu({ narrow: false, handedOff: false })).toBe(false);
	});
});
