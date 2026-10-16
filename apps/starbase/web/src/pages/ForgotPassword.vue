<script setup lang="ts">
import { ref } from 'vue';
import { useRoute } from 'vue-router';
import BrandLogo from '../BrandLogo.vue';
import { useApp } from '../context';
import { requestErrorText, requestPasswordReset } from '../passwordReset';

// "Forgot password?" from the sign-in page (outside the signed-in shell, like it): ask for a reset e-mail. The answer is the same for any
// address, an account or not, so this page cannot be used to find out who has one.
const { api } = useApp();
const route = useRoute();
// The Force App's sign-in page links here with the e-mail typed so far (?email=).
const email = ref(typeof route.query.email === 'string' ? route.query.email : '');
const busy = ref(false);
const sent = ref(false);
const error = ref('');

async function submit() {
	if (busy.value) return;
	busy.value = true;
	error.value = '';
	try {
		await requestPasswordReset(api, email.value.trim(), window.location.origin);
		sent.value = true;
	} catch (e) {
		error.value = await requestErrorText(e);
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<main class="sb-center">
		<div v-if="sent" class="sb-card">
			<BrandLogo />
			<h1>Check your e-mail</h1>
			<p class="sb-hint">If {{ email.trim() }} has an account, a link to set a new password is on its way. It works for a day.</p>
			<router-link to="/signin">Back to sign in</router-link>
		</div>
		<form v-else class="sb-card" @submit.prevent="submit">
			<BrandLogo />
			<h1>Forgot your password?</h1>
			<p class="sb-sub">Enter your account e-mail and we will send you a link to set a new one.</p>
			<label class="sb-field">Email<input v-model="email" type="email" autocomplete="username" required autofocus /></label>
			<p v-if="error" class="sb-error" role="alert">{{ error }}</p>
			<button type="submit" class="sb-primary" :disabled="busy" :aria-busy="busy ? 'true' : undefined"><span v-if="busy" class="sb-spin" aria-hidden="true" />{{ busy ? 'Sending…' : 'Send reset link' }}</button>
			<router-link to="/signin">Back to sign in</router-link>
		</form>
	</main>
</template>
