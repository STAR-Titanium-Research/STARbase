<script setup lang="ts">
// Installs the Directus admin's ForceHost, then renders the shared dashboard. Inside Directus
// everything is same-origin and authenticated by the session cookie, so raw fetches send
// credentials and need no Authorization header, and assets download via a plain anchor.
import { useApi, useStores } from '@directus/extensions-sdk';
import { useRouter } from 'vue-router';
import { ForceDashboard, setForceHost } from '@d1/force-plotting';
import { recordRoute } from '@d1/ui';

const api = useApi();
const router = useRouter();
const { useUserStore } = useStores();
const userStore = useUserStore();

setForceHost({
	api,
	currentUser: () => userStore.currentUser,
	filterUrl: '/filter',
	diagUrl: '/diag',
	octreeUrl: `${window.location.origin}/octrees`,
	authHeaders: () => ({}),
	fetchCredentials: 'include',
	openRecord: (collection, id) => { router.push(recordRoute(collection, id)); },
	downloadAsset: async (fileId) => {
		const a = document.createElement('a');
		a.href = `/assets/${fileId}?download`;
		a.rel = 'noopener';
		document.body.appendChild(a); a.click(); a.remove();
	},
	dense: false,
});
</script>

<template><ForceDashboard /></template>
