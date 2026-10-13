import type { AxiosInstance } from 'axios';
import type { Router } from 'vue-router';
import { configureLinks, openLink, setExplorerHostFactory, starbaseLinks, type ExplorerHost, type HostApi, type HostField } from '@d1/ui';
import { installUsagePings } from '@d1/starbase-pages';
import type { Session } from './session';

// STARbase's side of the Explorer host contract (@d1/ui host.ts); the Directus module's is
// @d1/directus-host. Pages, the sidebar and the finder reach d1-server only through this.

export interface HostDeps {
	api: AxiosInstance;
	session: Session;
	router: Router;
	directusUrl: string;
	openWindow?: (url: string) => void;
	openEditor?: (collection: string, id: string) => Promise<'saved' | 'cancelled'>;
}

// The order Data Studio shows a collection's fields in: by meta.sort, unsorted last, ties as given.
export function sortFields(defs: HostField[]): HostField[] {
	const key = (f: HostField) => (typeof f.meta?.sort === 'number' ? f.meta.sort : Number.POSITIVE_INFINITY);
	return defs
		.map((f, i) => ({ f, i }))
		.sort((a, b) => (key(a.f) === key(b.f) ? a.i - b.i : key(a.f) - key(b.f)))
		.map(({ f }) => f);
}

export function createStarbaseHost(deps: HostDeps): ExplorerHost {
	const { api, session, router, directusUrl } = deps;
	const openWindow = deps.openWindow ?? ((url: string) => void window.open(url, '_blank', 'noopener'));
	const host: ExplorerHost = {
		// The same axios instance the session guard watches: errors reject axios-style (e.response.status).
		api: api as unknown as HostApi,
		navigate: (to) => openLink(to, router),
		openDataStudio: (path) => openWindow(`${directusUrl}/admin${path}`),
		fieldsFor: async (collection) => {
			const { data } = await api.get(`/fields/${encodeURIComponent(collection)}`);
			return sortFields((data?.data ?? []) as HostField[]);
		},
		isAdmin: session.isAdmin,
		adminKnown: session.adminKnown,
		user: session.user as ExplorerHost['user'],
	};
	if (deps.openEditor) Object.assign(host, { openEditor: deps.openEditor });
	return host;
}

// One host per signed-in user, built when the session says who it is (main.ts watches the user). The
// links follow STARbase's routes, and the visit pings start once per user, in the Directus form
// (canonicalPath), so Frequently used counts the same targets in both hosts.
let current: { userId: string; host: ExplorerHost } | null = null;

export function installStarbaseHost(deps: HostDeps): ExplorerHost {
	configureLinks(starbaseLinks(deps.directusUrl));
	setExplorerHostFactory(() => {
		if (!current) throw new Error('@d1/ui: no Explorer host. STARbase builds one once someone is signed in.');
		return current.host;
	});
	const userId = deps.session.user.value?.id ?? '';
	if (current && current.userId === userId) return current.host;
	const host = createStarbaseHost(deps);
	current = { userId, host };
	installUsagePings(deps.router, deps.api);
	return host;
}

export function resetStarbaseHost(): void {
	current = null;
	setExplorerHostFactory(null);
}
