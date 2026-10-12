import { afterEach, describe, expect, it } from 'vitest';
import { resetFastHost, setFastHost, useFastHost, type FastHost } from './host';

describe('FastHost', () => {
	afterEach(() => resetFastHost());

	it('throws a clear error when no host is installed', () => {
		expect(() => useFastHost()).toThrow(/no host installed/);
	});

	it('returns the installed host', () => {
		const host = { api: {} as FastHost['api'], openRecord: () => {} };
		setFastHost(host);
		expect(useFastHost()).toBe(host);
	});
});
