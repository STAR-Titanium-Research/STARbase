// Every link a page makes is written as a path of the Directus app (whose root is /admin):
// '/home/samples/<id>', '/content/<collection>/<id>', '/d1-force-dashboard?operation=<id>',
// '/d1-report/sample/<id>'. The host decides what each one means. In Data Studio (the Directus host) the
// Explorer's pages are gone: '/home/…' and the plot dashboards open STARbase in a new tab through the
// permanent links on this host ('/d1-links/go…'), reports open on the server, and Data Studio paths stay routes. In STARbase '/home/…' is its own route without
// the prefix, the two plot dashboards are its plot pages, and everything else opens d1-server in a
// new tab. Pages never build URLs any other way, so there is one place to change per host.

export type ResolvedLink = { kind: 'route'; to: string } | { kind: 'external'; href: string };

export interface LinkConfig {
	// Prefix for URLs of server routes a page builds itself (assets, printable reports): '' when the
	// page is served by Directus (same origin), the d1-server origin in STARbase.
	serverBase: string;
	resolve(path: string): ResolvedLink;
	// The inverse, for code that reasons about the current route (usage pings, the nav's "you are
	// here"): this host's route path back to its Directus form, e.g. '/samples/1' → '/home/samples/1'.
	canonical(routePath: string): string;
}

const REPORT = /^\/d1-report\//;

const PLOTS: [string, string][] = [
	['/d1-force-dashboard', '/plot/force'],
	['/d1-fast-dashboard', '/plot/fast'],
	['/d1-conform-dashboard', '/plot/conform'],
];

// STARbase's own pages that have no /home form (they never existed in Data Studio): written with the
// same path in both hosts. In STARbase they are plain routes; Data Studio opens them through the
// permanent links. Add a page here AND to starbaseRoutes, or STARbase sends it to /admin/<path>.
export const LOCAL_PAGES: readonly string[] = ['/report-bug', '/crawler', '/map', '/inbox', '/plot/conform'];

const isLocalPage = (path: string): boolean => LOCAL_PAGES.some((p) => startsWithSegment(path, p));

function startsWithSegment(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?');
}

// Data Studio no longer has STARbase's pages (spec 2026-10-13-directus-headless §5.4): they open
// STARbase through the permanent links on this host, which forward to wherever STARbase lives.
function toPermanent(path: string): string | null {
	if (startsWithSegment(path, '/home')) {
		const rest = path.slice('/home'.length); // '', '/', '/samples/1?x', '?tab=2'
		if (rest === '' || rest === '/') return '/d1-links/go';
		if (rest.startsWith('?')) return '/d1-links/go' + rest;
		return '/d1-links/go/p' + rest;
	}
	for (const [from, to] of PLOTS) {
		if (startsWithSegment(path, from)) return '/d1-links/go/p' + to + path.slice(from.length);
	}
	if (isLocalPage(path)) return '/d1-links/go/p' + path;
	return null;
}

export const directusLinks: LinkConfig = {
	serverBase: '',
	resolve: (path) => {
		if (REPORT.test(path)) return { kind: 'external', href: path };
		const href = toPermanent(path);
		return href ? { kind: 'external', href } : { kind: 'route', to: path };
	},
	canonical: (routePath) => routePath,
};

export function starbaseLinks(serverBase: string): LinkConfig {
	const base = serverBase.replace(/\/+$/, '');
	return {
		serverBase: base,
		resolve(path) {
			if (startsWithSegment(path, '/home')) {
				const rest = path.slice('/home'.length);
				return { kind: 'route', to: rest.startsWith('/') ? rest : '/' + rest };
			}
			for (const [from, to] of PLOTS) {
				if (startsWithSegment(path, from)) return { kind: 'route', to: to + path.slice(from.length) };
			}
			if (isLocalPage(path)) return { kind: 'route', to: path };
			// Old Data Studio links to the Force crawler module land on STARbase's own crawler page.
			if (startsWithSegment(path, '/d1-force-crawler')) {
				return { kind: 'route', to: '/crawler' + path.slice('/d1-force-crawler'.length) };
			}
			if (REPORT.test(path)) return { kind: 'external', href: base + path };
			return { kind: 'external', href: `${base}/admin${path}` };
		},
		canonical(routePath) {
			// The plot pages are the dashboards in the Directus form (the inverse of resolve), so usage pings
			// and "you are here" count /plot/force as /d1-force-dashboard in both hosts.
			for (const [from, to] of PLOTS) {
				if (startsWithSegment(routePath, to)) return from + routePath.slice(to.length);
			}
			if (isLocalPage(routePath)) return routePath;
			return routePath === '/' || routePath.startsWith('/?') ? '/home' + routePath.slice(1) : '/home' + routePath;
		},
	};
}

let config: LinkConfig = directusLinks;

export function configureLinks(c: LinkConfig): void {
	config = c;
}

export function resetLinks(): void {
	config = directusLinks;
}

export const resolveLink = (path: string): ResolvedLink => config.resolve(path);
export const canonicalPath = (routePath: string): string => config.canonical(routePath);
export const serverUrl = (path: string): string => config.serverBase + path;

export function assetUrl(fileId: string, query: Record<string, string | number | boolean> = {}): string {
	const q = Object.entries(query)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
		.join('&');
	return serverUrl(`/assets/${encodeURIComponent(fileId)}${q ? `?${q}` : ''}`);
}

// Follow a link from code: a route goes through the host's router, anything else opens in a new tab.
// Takes the router itself (not a push callback) so a resolved route goes straight to the router and is
// never resolved a second time (host.navigate resolves; this must not go through it).
export function openLink(path: string, router: { push(to: string): unknown }): void {
	const r = resolveLink(path);
	if (r.kind === 'route') void router.push(r.to);
	else window.open(r.href, '_blank', 'noopener');
}

// The href to show for a link (e.g. for "open in new tab"): the router's href for a route.
export function linkHref(path: string, router: { resolve(to: string): { href: string } }): string {
	const r = resolveLink(path);
	return r.kind === 'route' ? router.resolve(r.to).href : r.href;
}

// "Open in new tab" for a link written as a Directus app path: the same address linkHref gives.
export function openLinkInNewTab(path: string, router: { resolve(to: string): { href: string } }): void {
	window.open(linkHref(path, router), '_blank', 'noopener');
}
