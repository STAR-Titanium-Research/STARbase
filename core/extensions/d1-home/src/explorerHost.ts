import { ref } from 'vue';
import { useApi, useStores } from '@directus/extensions-sdk';
import { useRouter } from 'vue-router';
import { guessAdmin, type ExplorerHost } from '@d1/ui';

// The Directus side of the Explorer's host contract (packages/d1-ui/src/host.ts). This and
// ExplorerView.vue are the only places the Explorer knows it runs inside Directus; a standalone
// app provides its own ExplorerHost and reuses the components unchanged.
//
// One host per signed-in user, created on first use and then shared: every page asks for it
// (ExplorerView provides it to the sidebar; Home and People read isAdmin from it), and moving
// between pages must not refetch who you are. It is keyed on the Directus user's id, so signing
// out and in as someone else in the same tab builds a fresh host instead of keeping the old
// user's admin flag and sidebar.
let current: { userId: string | null; host: ExplorerHost } | null = null;

export function useExplorerHost(): ExplorerHost {
	const api = useApi();
	const router = useRouter();
	const userStore = useStores().useUserStore() as any;
	const userId: string | null = userStore.currentUser?.id ?? null;
	if (current && current.userId === userId) return current.host;

	// Seeded from the store the way the pages used to guess (so the first render is already right for
	// almost everyone), then corrected by the server below. adminKnown says when the correction is in.
	const isAdmin = ref(guessAdmin(userStore));
	const adminKnown = ref(false);
	const user = ref<{ id: string; first_name?: string; role?: string | null } | null>(null);

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
			user.value = res.data?.data ?? null;
		})
		.catch(() => {
			user.value = null;
		});

	const host: ExplorerHost = {
		api,
		navigate: (to) => void router.push(to),
		openDataStudio: (path) => void router.push(path),
		isAdmin,
		adminKnown,
		user,
	};
	current = { userId, host };
	return host;
}
