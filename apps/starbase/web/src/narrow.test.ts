import { describe, expect, it } from 'vitest';
import { isPhoneWidth, PHONE_MAX_WIDTH, PHONE_QUERY } from './narrow';

describe('phone width (spec §3.3: under 768 px)', () => {
	it('is below 768 px', () => {
		expect(isPhoneWidth(375)).toBe(true);
		expect(isPhoneWidth(767)).toBe(true);
		expect(isPhoneWidth(768)).toBe(false);
		expect(PHONE_QUERY).toBe(`(max-width: ${PHONE_MAX_WIDTH}px)`);
	});
});
