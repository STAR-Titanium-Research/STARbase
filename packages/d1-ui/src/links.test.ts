import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	assetUrl, canonicalPath, configureLinks, directusLinks, linkHref, openLink, resetLinks, resolveLink, serverUrl, starbaseLinks,
} from './links';
import { routeTarget } from './usage';

afterEach(() => {
	resetLinks();
	vi.unstubAllGlobals();
});

describe('the Directus host (the default)', () => {
	it('keeps every app path a route, as written', () => {
		for (const p of ['/home', '/home/samples/a%2Fb', '/home/samples?bookmark=3', '/content/materials/7', '/d1-force-dashboard?operation=9']) {
			expect(resolveLink(p)).toEqual({ kind: 'route', to: p });
		}
	});
	it('opens printable reports on the server, root-relative', () => {
		expect(resolveLink('/d1-report/sample/5')).toEqual({ kind: 'external', href: '/d1-report/sample/5' });
	});
	it('needs no canonicalisation and builds root-relative server URLs', () => {
		expect(canonicalPath('/home/samples/1?x=1')).toBe('/home/samples/1?x=1');
		expect(serverUrl('/d1-trace/sample/1')).toBe('/d1-trace/sample/1');
		expect(assetUrl('abc', { width: 64, fit: 'cover' })).toBe('/assets/abc?width=64&fit=cover');
		expect(assetUrl('abc', { download: '' })).toBe('/assets/abc?download=');
	});
	it('is what configureLinks is reset to', () => {
		configureLinks(starbaseLinks('https://d1.example'));
		resetLinks();
		expect(resolveLink('/home')).toEqual(directusLinks.resolve('/home'));
	});
});

describe('STARbase', () => {
	const D1 = 'https://d1-server.tail54eeb6.ts.net';
	const use = () => configureLinks(starbaseLinks(D1 + '/'));

	it('drops /home from its own pages, keeping query and encoding', () => {
		use();
		expect(resolveLink('/home')).toEqual({ kind: 'route', to: '/' });
		expect(resolveLink('/home?q=x')).toEqual({ kind: 'route', to: '/?q=x' });
		expect(resolveLink('/home/samples/a%2Fb')).toEqual({ kind: 'route', to: '/samples/a%2Fb' });
		expect(resolveLink('/home/samples?bookmark=3&open=k')).toEqual({ kind: 'route', to: '/samples?bookmark=3&open=k' });
	});
	it('maps the plot dashboards to its plot pages', () => {
		use();
		expect(resolveLink('/d1-force-dashboard?operation=9')).toEqual({ kind: 'route', to: '/plot/force?operation=9' });
		expect(resolveLink('/d1-fast-dashboard?operation=9')).toEqual({ kind: 'route', to: '/plot/fast?operation=9' });
		expect(resolveLink('/d1-force-dashboard')).toEqual({ kind: 'route', to: '/plot/force' });
	});
	it('sends everything else to d1-server', () => {
		use();
		expect(resolveLink('/content/materials/7')).toEqual({ kind: 'external', href: `${D1}/admin/content/materials/7` });
		expect(resolveLink('/d1-lab-dashboard/graph?sample=1')).toEqual({ kind: 'external', href: `${D1}/admin/d1-lab-dashboard/graph?sample=1` });
		expect(resolveLink('/d1-report/sample/5')).toEqual({ kind: 'external', href: `${D1}/d1-report/sample/5` });
		expect(resolveLink('/homework')).toEqual({ kind: 'external', href: `${D1}/admin/homework` });
	});
	it('turns its routes back into the Directus form', () => {
		use();
		expect(canonicalPath('/')).toBe('/home');
		expect(canonicalPath('/?q=x')).toBe('/home?q=x');
		expect(canonicalPath('/samples/a%2Fb')).toBe('/home/samples/a%2Fb');
		expect(canonicalPath('/samples?bookmark=3')).toBe('/home/samples?bookmark=3');
		expect(canonicalPath('/plot/force?operation=9')).toBe('/d1-force-dashboard?operation=9');
		expect(canonicalPath('/plot/fast')).toBe('/d1-fast-dashboard');
		expect(canonicalPath('/plotting')).toBe('/home/plotting');
	});
	it('round-trips every Explorer path', () => {
		use();
		for (const p of ['/home', '/home/samples/1', '/home/labels?ids=1,2', '/home/people']) {
			const r = resolveLink(p);
			expect(r.kind).toBe('route');
			if (r.kind === 'route') expect(canonicalPath(r.to)).toBe(p);
		}
	});
	it('round-trips the plot dashboards too', () => {
		use();
		for (const p of ['/d1-force-dashboard?operation=9', '/d1-fast-dashboard?operation=3', '/d1-force-dashboard']) {
			const r = resolveLink(p);
			expect(r.kind).toBe('route');
			if (r.kind === 'route') expect(canonicalPath(r.to)).toBe(p);
		}
	});
	it('builds server URLs on d1-server', () => {
		use();
		expect(serverUrl('/d1-trace/sample/1')).toBe(`${D1}/d1-trace/sample/1`);
		expect(assetUrl('f 1', { download: '' })).toBe(`${D1}/assets/f%201?download=`);
	});
});

describe('openLink / linkHref', () => {
	it('pushes routes and opens external links in a new tab', () => {
		const push = vi.fn();
		const open = vi.fn();
		// No DOM environment in this package's vitest (neither happy-dom nor jsdom is installed).
		vi.stubGlobal('window', { open });
		openLink('/home/samples/1', { push });
		expect(push).toHaveBeenCalledWith('/home/samples/1');
		expect(open).not.toHaveBeenCalled();
		openLink('/d1-report/sample/1', { push });
		expect(open).toHaveBeenCalledWith('/d1-report/sample/1', '_blank', 'noopener');
		expect(push).toHaveBeenCalledTimes(1);
	});
	it('gives a route its router href and an external link its own href', () => {
		const router = { resolve: (to: string) => ({ href: `/admin${to}` }) };
		expect(linkHref('/home/samples/1', router)).toBe('/admin/home/samples/1');
		expect(linkHref('/d1-report/x', router)).toBe('/d1-report/x');
	});
});

describe('usage pings agree across hosts', () => {
	it('a STARbase route canonicalises to the same target as the Directus one', () => {
		const id = '3f2b8a1c-0000-4000-8000-000000000001';
		const directus = routeTarget(`/home/samples/${id}`);
		configureLinks(starbaseLinks('https://d1.example'));
		expect(routeTarget(canonicalPath(`/samples/${id}`))).toEqual(directus);
		expect(routeTarget(canonicalPath('/samples'))).toEqual(routeTarget('/home/samples'));
		expect(routeTarget(canonicalPath('/plot/fast?operation=3'))).toEqual({ kind: 'page', target: 'fast-dashboard' });
	});
});
