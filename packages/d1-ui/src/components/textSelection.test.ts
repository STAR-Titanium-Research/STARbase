import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasTextSelection } from './textSelection';

afterEach(() => vi.unstubAllGlobals());

describe('hasTextSelection', () => {
	it('is false with no window (node) or an empty selection', () => {
		expect(hasTextSelection()).toBe(false);
		vi.stubGlobal('window', { getSelection: () => ({ toString: () => '' }) });
		expect(hasTextSelection()).toBe(false);
		vi.stubGlobal('window', { getSelection: () => null });
		expect(hasTextSelection()).toBe(false);
	});

	it('is true while some text is selected', () => {
		vi.stubGlobal('window', { getSelection: () => ({ toString: () => 'WAAM AIT 3' }) });
		expect(hasTextSelection()).toBe(true);
	});
});
