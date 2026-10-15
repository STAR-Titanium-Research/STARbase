import { afterEach, describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { setExplorerHostFactory, useExplorerHost, type ExplorerHost } from './host';

const fake = (): ExplorerHost => ({
	api: { get: async () => ({ data: {} }), post: async () => ({ data: {} }), patch: async () => ({ data: {} }), delete: async () => ({ data: {} }) },
	navigate: () => {},
	openDataStudio: () => {},
	fieldsFor: async () => [],
	isAdmin: ref(false),
	adminKnown: ref(true),
	canViewAllAccess: ref(false),
	user: ref(null),
});

describe('Explorer host factory', () => {
	afterEach(() => setExplorerHostFactory(null));

	it('throws a clear error when no host is installed', () => {
		expect(() => useExplorerHost()).toThrow(/no Explorer host/);
	});

	it('calls the installed factory each time (the host decides what to cache)', () => {
		let calls = 0;
		const host = fake();
		setExplorerHostFactory(() => (calls++, host));
		expect(useExplorerHost()).toBe(host);
		expect(useExplorerHost()).toBe(host);
		expect(calls).toBe(2);
	});
});
