<script setup lang="ts">
import { useRouter } from 'vue-router';
import { getConfig } from './config';
import { useApp } from './context';

// The sidebar's foot (desktop) and the phone sheet's: Data Studio in a new tab, who is signed in, sign out.
const { session } = useApp();
const router = useRouter();
const studioHref = `${getConfig().directusUrl}/admin`;

async function signOut() {
	await session.signOut();
	await router.replace('/signin');
}
</script>

<template>
	<div class="sb-foot">
		<a :href="studioHref" target="_blank" rel="noopener" class="sb-foot-link"><v-icon name="open_in_new" x-small left />Data Studio</a>
		<span class="sb-user">{{ session.user.value?.first_name ?? '' }}</span>
		<button type="button" class="sb-signout" @click="signOut"><v-icon name="logout" x-small left />Sign out</button>
	</div>
</template>

<style scoped>
.sb-foot {
	margin-top: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 16px;
	border-top: 1px solid var(--theme--border-color-subdued); font-size: var(--fs-sm, 12px);
}
.sb-foot-link { color: var(--theme--foreground-subdued); text-decoration: none; }
.sb-user { margin-left: auto; color: var(--theme--foreground-subdued); }
.sb-signout { border: 0; background: none; padding: 4px; font: inherit; color: var(--theme--foreground); cursor: pointer; }
</style>
