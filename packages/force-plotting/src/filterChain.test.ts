import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { setForceHost, resetForceHost, type ForceHost } from './host';
import { bakeBlockedReason, defaultChain, fetchFiltered, fetchSpectrogram, NO_MAT_BAKE_REASON } from './filterChain';

function hostWith(over: Partial<ForceHost>): ForceHost {
	return {
		api: {} as ForceHost['api'],
		currentUser: () => null,
		filterUrl: '/filter',
		diagUrl: '/diag',
		octreeUrl: '/octrees',
		authHeaders: () => ({}),
		fetchCredentials: 'include',
		openRecord: () => {},
		downloadAsset: async () => {},
		dense: false,
		...over,
	};
}

describe('filterChain host wiring', () => {
	beforeEach(() => {
		resetForceHost();
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
	});
	afterEach(() => vi.unstubAllGlobals());

	it('calls the host filter URL with Bearer headers and no cookies (standalone)', async () => {
		setForceHost(hostWith({
			filterUrl: 'https://d1.example/filter',
			authHeaders: () => ({ Authorization: 'Bearer t0ken' }),
			fetchCredentials: 'omit',
		}));
		// fetchFiltered pipes the response through parseCache, which rejects on this stub
		// body. Irrelevant here — the assertions are about how fetch was called, not the
		// parsed result — so swallow it rather than constructing a valid binary cache.
		await fetchFiltered('op-1', defaultChain()).catch(() => {});
		const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(url).toBe('https://d1.example/filter/run');
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t0ken');
		expect(init.credentials).toBe('omit');
	});

	it('calls the same-origin filter URL with cookies and no Authorization (Directus)', async () => {
		setForceHost(hostWith({ filterUrl: '/filter', authHeaders: () => ({}), fetchCredentials: 'include' }));
		// fetchFiltered pipes the response through parseCache, which rejects on this stub
		// body. Irrelevant here — the assertions are about how fetch was called, not the
		// parsed result — so swallow it rather than constructing a valid binary cache.
		await fetchFiltered('op-1', defaultChain()).catch(() => {});
		const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(url).toBe('/filter/run');
		expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
		expect(init.credentials).toBe('include');
	});
});

describe('fetchSpectrogram abort', () => {
	beforeEach(() => {
		resetForceHost();
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
	});
	afterEach(() => vi.unstubAllGlobals());

	it('passes the AbortSignal through to fetch so a superseded request can be cancelled', async () => {
		setForceHost(hostWith({}));
		const ac = new AbortController();
		await fetchSpectrogram('op-1', defaultChain(), 'Fx', ac.signal);
		const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(url).toBe('/filter/spectrogram');
		expect(init.signal).toBe(ac.signal);
	});
});

describe('bakeBlockedReason (#190: cut uploaded without an archive .mat)', () => {
	it('blocks when directus_files_id is null / missing', () => {
		expect(bakeBlockedReason({ directus_files_id: null })).toBe(NO_MAT_BAKE_REASON);
		expect(bakeBlockedReason({})).toBe(NO_MAT_BAKE_REASON);
		expect(NO_MAT_BAKE_REASON).toContain('Apply the filter live');
	});
	it('allows a linked file (expanded object or bare id)', () => {
		expect(bakeBlockedReason({ directus_files_id: { id: 'f1', filesize: 12 } })).toBeNull();
		expect(bakeBlockedReason({ directus_files_id: 'f1' })).toBeNull();
	});
	it('does not block before a detail is loaded', () => {
		expect(bakeBlockedReason(null)).toBeNull();
		expect(bakeBlockedReason(undefined)).toBeNull();
	});
});
