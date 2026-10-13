import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent } from 'vue';
import { setPageFrame, usePageFrame } from './frame';

describe('page frame', () => {
	afterEach(() => setPageFrame(null));
	it('throws a clear error when the host installed none', () => {
		expect(() => usePageFrame()).toThrow(/no page frame/);
	});
	it('returns the installed frame', () => {
		const Frame = defineComponent({ name: 'Frame', template: '<div><slot /></div>' });
		setPageFrame(Frame);
		expect(usePageFrame()).toBe(Frame);
	});
});
