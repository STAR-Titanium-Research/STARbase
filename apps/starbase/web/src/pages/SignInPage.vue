<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BrandLogo from '../BrandLogo.vue';
import { getConfig } from '../config';
import { useApp } from '../context';
import { listProviders, providerLoginUrl, safeNext, signInErrorText, type AuthProvider } from '../session';

// STARbase's own sign-in page (spec §3.2): email and password into Directus's session (the same cookie
// Data Studio uses), and one button per SSO provider Directus offers.
const { api, session } = useApp();
const route = useRoute();
const router = useRouter();
const email = ref('');
const password = ref('');
const busy = ref(false);
const error = ref('');
const providers = ref<AuthProvider[]>([]);
const next = () => safeNext(route.query.next);

onMounted(async () => {
	providers.value = await listProviders(api);
});

async function submit() {
	if (busy.value) return;
	busy.value = true;
	error.value = '';
	try {
		await session.signIn(email.value.trim(), password.value);
		await router.replace(next());
	} catch (e) {
		error.value = signInErrorText(e);
	} finally {
		busy.value = false;
	}
}

const providerHref = (p: AuthProvider) => providerLoginUrl(getConfig().directusUrl, p.name, window.location.origin, next());
</script>

<template>
	<main class="sb-center">
		<form class="sb-card" @submit.prevent="submit">
			<BrandLogo />
			<h1>Sign in</h1>
			<label class="sb-field">Email<input v-model="email" type="email" autocomplete="username" required autofocus /></label>
			<label class="sb-field">Password<input v-model="password" type="password" autocomplete="current-password" required /></label>
			<p v-if="error" class="sb-error" role="alert">{{ error }}</p>
			<button type="submit" class="sb-primary" :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
			<template v-if="providers.length">
				<p class="sb-or">or</p>
				<a v-for="p in providers" :key="p.name" class="sb-provider" :href="providerHref(p)">Sign in with {{ p.label }}</a>
			</template>
			<p class="sb-hint">The same account as Data Studio. Signing in here signs you in there too.</p>
		</form>
	</main>
</template>
