<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BrandLogo from '../BrandLogo.vue';
import { useApp } from '../context';
import { safeNext, ssoErrorText } from '../session';

// Where an SSO sign-in comes back (spec §3.2, §4). Directus has set the session cookie, or says why not
// in ?reason=.
const { session } = useApp();
const route = useRoute();
const router = useRouter();
const problem = ref('');

onMounted(async () => {
	const reason = typeof route.query.reason === 'string' ? route.query.reason : '';
	if (reason) {
		problem.value = ssoErrorText(reason);
		return;
	}
	const state = await session.load();
	if (state === 'signed-in') await router.replace(safeNext(route.query.next));
	else if (state === 'unreachable') problem.value = "Can't reach the database to finish signing in.";
	else problem.value = 'The sign-in did not reach STARbase. Try again, or use your email and password.';
});
</script>

<template>
	<main class="sb-center">
		<div class="sb-card">
			<BrandLogo />
			<template v-if="problem">
				<h1>Sign-in didn't finish</h1>
				<p class="sb-error" role="alert">{{ problem }}</p>
				<router-link :to="{ path: '/signin', query: route.query.next ? { next: String(route.query.next) } : {} }" class="sb-primary">Back to sign in</router-link>
			</template>
			<p v-else role="status">Signing you in…</p>
		</div>
	</main>
</template>
