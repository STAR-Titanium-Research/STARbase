import { ref } from 'vue';
import { useApi, useStores } from '@directus/extensions-sdk';
import { useRouter, type Router } from 'vue-router';
import { guessAdmin, type ExplorerHost, type HostApi, type HostField } from '@d1/ui';

// The Directus side of the Explorer's host contract (packages/d1-ui/src/host.ts). A standalone
// app provides its own ExplorerHost (setExplorerHostFactory) and reuses the components unchanged.
// Every Directus extension that renders kit components installs this once (installDirectusHost).
//
// One host per signed-in user, created on first use and then shared: every page asks for it
// (ExplorerView provides it to the sidebar; Home and People read isAdmin from it), and moving
// between pages must not refetch who you are. It is keyed on the Directus user's id, so signing
// out and in as someone else in the same tab builds a fresh host instead of keeping the old
// user's admin flag and sidebar.
let current: { userId: string | null; host: ExplorerHost } | null = null;

export function useDirectusHost(opts: { onCreate?: (host: ExplorerHost, router: Router) => void } = {}): ExplorerHost {
	// Everything built from Directus's injection-based composables is captured here, during setup:
	// fieldsFor below runs later, outside any component, where useStores() would find nothing.
	const api = useApi() as unknown as HostApi;
	const router = useRouter();
	const stores = useStores();
	const userStore = stores.useUserStore() as any;
	const userId: string | null = userStore.currentUser?.id ?? null;
	if (current && current.userId === userId) return current.host;

	// Seeded from the store the way the pages used to guess (so the first render is already right for
	// almost everyone), then corrected by the server below. adminKnown says when the correction is in.
	const isAdmin = ref(guessAdmin(userStore));
	const adminKnown = ref(false);
	const seed = userStore.currentUser;
	const user = ref<{ id: string; first_name?: string; role?: string | null } | null>(
		seed ? { id: seed.id, first_name: seed.first_name, role: typeof seed.role === 'object' ? seed.role?.id ?? null : seed.role ?? null } : null,
	);

	// REST, not the store heuristic the pages used to guess with: GET /policies/me/globals is the
	// server's own answer. A failure keeps the guess (a wrongly guessed admin only sees admin-only
	// entries the server still refuses to act on).
	api
		.get('/policies/me/globals')
		.then((res) => {
			isAdmin.value = res.data?.data?.admin_access === true;
		})
		.catch(() => {})
		.finally(() => {
			adminKnown.value = true;
		});
	api
		.get('/users/me', { params: { fields: 'id,first_name,role' } })
		.then((res) => {
			if (res.data?.data) user.value = res.data.data;
		})
		.catch(() => {
			// Keep the store seed: Home, ProjectsIndex and register-sample read it, and a failed lookup is no reason to forget who is signed in.
		});

	const host: ExplorerHost = {
		api,
		navigate: (to) => void router.push(to),
		openDataStudio: (path) => void router.push(path),
		fieldsFor: async (collection) => {
			if (typeof (stores as any).useFieldsStore === 'function') {
				const defs = (stores as any).useFieldsStore().getFieldsForCollectionSorted(collection);
				if (Array.isArray(defs) && defs.length) return defs as HostField[];
			}
			const { data } = await api.get(`/fields/${collection}`);
			return data.data as HostField[];
		},
		isAdmin,
		adminKnown,
		user,
	};
	// The app's own hook (d1-home installs its usage pings here): once per signed-in user.
	opts.onCreate?.(host, router);
	current = { userId, host };
	return host;
}
