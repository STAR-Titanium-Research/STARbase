<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BrandLogo from '../BrandLogo.vue';
import { policyChecks, tokenEmail, tokenFrom } from '../acceptInvite';
import { useApp } from '../context';
import { RESET_LINK_UNUSABLE, resetPassword } from '../passwordReset';
import { signInErrorText } from '../session';
import { unreachableText } from '../api';

// The page a password-reset e-mail links to, outside the signed-in shell like the sign-in page: set a new password, then be signed in and
// sent Home. The token (a link Directus signed, good for a day, once) carries the e-mail of the account.
const { api, session } = useApp();
const route = useRoute();
const router = useRouter();
const token = computed(() => tokenFrom(route.query));
const email = computed(() => (token.value ? tokenEmail(token.value) : null));
const password = ref('');
const confirm = ref('');
const busy = ref(false);
const error = ref('');
const unusable = ref(!token.value);
// The password is changed but the automatic sign-in did not work: they can sign in by hand with it.
const setButNotSignedIn = ref(false);

const checks = computed(() => policyChecks(password.value));
const mismatch = computed(() => confirm.value !== '' && confirm.value !== password.value);

async function submit() {
	if (busy.value || !token.value) return;
	if (password.value !== confirm.value) {
		error.value = 'The two passwords are not the same.';
		return;
	}
	busy.value = true;
	error.value = '';
	try {
		const result = await resetPassword(api, token.value, password.value);
		if (result === 'expired' || result === 'invalid') {
			unusable.value = true;
			return;
		}
		if (result !== 'ok') {
			error.value = result.policy;
			return;
		}
		if (!email.value) {
			setButNotSignedIn.value = true;
			return;
		}
		try {
			await session.signIn(email.value, password.value);
		} catch (e) {
			error.value = signInErrorText(e);
			setButNotSignedIn.value = true;
			return;
		}
		await router.replace('/');
	} catch (e) {
		error.value = unreachableText(e);
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<main class="sb-center">
		<div v-if="unusable" class="sb-card">
			<BrandLogo />
			<h1>Set a new password</h1>
			<p class="sb-error" role="alert">{{ RESET_LINK_UNUSABLE }}</p>
			<router-link to="/forgot-password">Send a new link</router-link>
		</div>
		<div v-else-if="setButNotSignedIn" class="sb-card">
			<BrandLogo />
			<h1>Your password is changed</h1>
			<p v-if="error" class="sb-error" role="alert">{{ error }}</p>
			<p class="sb-hint">Sign in with it to continue.</p>
			<router-link to="/signin">Sign in</router-link>
		</div>
		<form v-else class="sb-card" @submit.prevent="submit">
			<BrandLogo />
			<h1>Set a new password</h1>
			<p v-if="email" class="sb-hint">For {{ email }}.</p>
			<label class="sb-field">New password<input v-model="password" type="password" autocomplete="new-password" required autofocus /></label>
			<label class="sb-field">Confirm password<input v-model="confirm" type="password" autocomplete="new-password" required /></label>
			<p v-if="mismatch" class="sb-error" role="status">The two passwords are not the same.</p>
			<p class="sb-hint">
				The password needs
				<template v-for="(c, i) in checks" :key="c.label">
					<span class="chk" :class="{ met: c.met }">{{ c.met ? '✓ ' : '' }}{{ c.label }}</span><template v-if="i < checks.length - 2">, </template><template v-else-if="i === checks.length - 2"> and </template>
				</template>.
			</p>
			<p v-if="error" class="sb-error" role="alert">{{ error }}</p>
			<button type="submit" class="sb-primary" :disabled="busy">{{ busy ? 'Changing password…' : 'Change password and sign in' }}</button>
		</form>
	</main>
</template>

<style scoped>
.chk.met { color: var(--theme--success, #2e7d32); font-weight: 600; }
</style>
