import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { configureLinks, resetLinks, starbaseLinks } from '@d1/ui';
import { forceUser, starbaseFastHost, starbaseForceHost, type PlotDeps } from './plotHosts';

const D1 = 'https://d1-server.tail54eeb6.ts.net';

function deps(recovery: 'retry' | 'fail' | 'signed-out' = 'retry') {
	const config = { directusUrl: D1, filterUrl: `${D1}/filter`, diagUrl: `${D1}/diag`, octreeUrl: `${D1}/octrees` };
	const d = {
		api: { name: 'the STARbase axios instance' } as unknown as PlotDeps['api'],
		session: { user: ref({ id: 'u1', first_name: 'Ada', role: 'r1' }), isAdmin: ref(true) },
		guard: { recover: vi.fn(async () => recovery) },
		router: { push: vi.fn() },
		config: () => config,
		download: vi.fn(),
	};
	return { d: d as unknown as PlotDeps & typeof d, config };
}

afterEach(() => resetLinks());

describe('the Force plotter in STARbase (the cookie variant, spec §3.5)', () => {
	it('sends the session cookie with its raw fetches, and no Authorization header', () => {
		const host = starbaseForceHost(deps().d);
		expect(host.fetchCredentials).toBe('include');
		expect(host.authHeaders()).toEqual({});
		expect(host.dense).toBe(true);
	});
	it('reads the sidecar URLs live from the config', () => {
		const { d, config } = deps();
		const host = starbaseForceHost(d);
		expect([host.filterUrl, host.diagUrl, host.octreeUrl]).toEqual([`${D1}/filter`, `${D1}/diag`, `${D1}/octrees`]);
		config.octreeUrl = 'https://octrees.example';
		expect(host.octreeUrl).toBe('https://octrees.example');
	});
	it('opens a record on its STARbase page', () => {
		configureLinks(starbaseLinks(D1));
		const { d } = deps();
		starbaseForceHost(d).openRecord('physical_samples', 's 1');
		expect(d.router.push).toHaveBeenCalledWith('/samples/s%201');
	});
	it('refreshAuth re-checks the session: renewed means retry, a live session refusing does not', async () => {
		const renewed = deps('retry');
		expect(await starbaseForceHost(renewed.d).refreshAuth!()).toBe(true);
		expect(renewed.d.guard.recover).toHaveBeenCalledWith(403);
		expect(await starbaseForceHost(deps('fail').d).refreshAuth!()).toBe(false);
		expect(await starbaseForceHost(deps('signed-out').d).refreshAuth!()).toBe(false);
	});
	it('downloads a file from d1-server with ?download=', async () => {
		configureLinks(starbaseLinks(D1));
		const { d } = deps();
		await starbaseForceHost(d).downloadAsset('f 1');
		expect(d.download).toHaveBeenCalledWith(`${D1}/assets/f%201?download=`);
	});
	it('the current user carries the server-side admin flag (policies, not roles)', () => {
		const { d } = deps();
		expect(forceUser(d.session)).toEqual({ id: 'u1', first_name: 'Ada', role: 'r1', admin_access: true });
		d.session.user.value = null as never;
		expect(forceUser(d.session)).toBeNull();
	});
});

describe('the FAST plotter in STARbase', () => {
	it('uses the same client and opens records on STARbase pages', () => {
		configureLinks(starbaseLinks(D1));
		const { d } = deps();
		const host = starbaseFastHost(d);
		expect(host.api).toBe(d.api);
		host.openRecord('manufacturing_operations', 'o1');
		expect(d.router.push).toHaveBeenCalledWith('/operations/o1');
	});
});
