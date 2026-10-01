<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { authStore } from './authStore';
import { getConfig } from './config';

const router = useRouter();
const route = useRoute();

const email = ref('');
const password = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

// Hint only: whether the OS thinks we're online. The real test is whether Directus answers.
const online = ref(navigator.onLine);
const setOn = () => { online.value = true; };
const setOff = () => { online.value = false; };
window.addEventListener('online', setOn);
window.addEventListener('offline', setOff);
onBeforeUnmount(() => { window.removeEventListener('online', setOn); window.removeEventListener('offline', setOff); });

async function submit() {
	if (busy.value) return;
	error.value = null;
	busy.value = true;
	try {
		await authStore.login(email.value.trim(), password.value);
		const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/record';
		router.replace(redirect);
	} catch (e: any) {
		const status = e?.response?.status;
		error.value = status === 401 ? 'Incorrect email or password.' : e?.message || 'Sign-in failed. Check the connection and try again.';
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<div class="login-wrap">
		<div class="login-aura" aria-hidden="true"></div>
		<form class="login-card" @submit.prevent="submit">
			<div class="brand">
				<span class="brand-mark">
					<i class="dot fx"></i><i class="dot fy"></i><i class="dot fz"></i>
				</span>
				<h1>Force App</h1>
			</div>
			<p class="subtitle">Sign in with your Directus account</p>

			<label class="field">
				<span>Email</span>
				<input v-model="email" type="email" autocomplete="username" required :disabled="busy" placeholder="you@example.com" />
			</label>

			<label class="field">
				<span>Password</span>
				<input v-model="password" type="password" autocomplete="current-password" required :disabled="busy" placeholder="••••••••" />
			</label>

			<p v-if="error" class="error"><span class="material-symbols-rounded">error</span>{{ error }}</p>

			<button class="btn primary submit" type="submit" :disabled="busy || !email || !password">
				<span v-if="busy" class="spinner"></span>
				<span>{{ busy ? 'Signing in…' : 'Sign in' }}</span>
			</button>

			<p class="offline-hint" :class="{ active: !online }">
				<span class="material-symbols-rounded">{{ online ? 'cloud_done' : 'cloud_off' }}</span>
				<span v-if="online">Accounts that have signed in on this PC can also sign in with no connection.</span>
				<span v-else>No connection: you can sign in with an account that has signed in on this PC before. Uploads wait until you reconnect.</span>
			</p>

			<p class="host">{{ getConfig().directusUrl || 'same-origin' }}</p>
		</form>
	</div>
</template>

<style scoped>
.login-wrap {
	position: relative;
	min-height: 100vh;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 24px;
	background: radial-gradient(1200px 600px at 50% -10%, var(--bg-2), var(--bg));
	overflow: hidden;
}
.login-aura {
	position: absolute;
	width: 620px;
	height: 620px;
	border-radius: 50%;
	filter: blur(120px);
	opacity: 0.35;
	background: conic-gradient(from 180deg, var(--fx), var(--fz), var(--fy), var(--fx));
	pointer-events: none;
}
.login-card {
	position: relative;
	width: 100%;
	max-width: 380px;
	padding: 32px 30px 22px;
	background: rgba(17, 26, 51, 0.72);
	backdrop-filter: blur(14px);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	box-shadow: 0 30px 80px rgba(0, 0, 0, 0.45);
}
/* The glass above is hard-coded dark navy, which the dark theme wants. On the light theme the text
   switches to dark ink and landed on that same dark card — title, labels and fields nearly
   invisible. Light glass there instead; the dark theme is untouched. */
[data-theme='light'] .login-card {
	background: rgba(255, 255, 255, 0.72);
	box-shadow: 0 30px 80px rgba(15, 23, 42, 0.16);
}
[data-theme='light'] .brand-mark {
	background: rgba(0, 0, 0, 0.04);
}
[data-theme='light'] .field input {
	background: rgba(255, 255, 255, 0.85);
}
.brand {
	display: flex;
	align-items: center;
	gap: 12px;
}
.brand h1 {
	margin: 0;
	font-size: var(--fs-2xl);
	letter-spacing: -0.01em;
}
.brand-mark {
	display: inline-flex;
	gap: 4px;
	padding: 8px;
	border-radius: 10px;
	background: rgba(255, 255, 255, 0.05);
	border: 1px solid var(--border);
}
.dot {
	width: 9px;
	height: 9px;
	border-radius: 50%;
	display: inline-block;
}
.dot.fx {
	background: var(--fx);
}
.dot.fy {
	background: var(--fy);
}
.dot.fz {
	background: var(--fz);
}
.subtitle {
	margin: 14px 0 22px;
	color: var(--text-dim);
	font-size: var(--fs-md);
}
.field {
	display: block;
	margin-bottom: 14px;
}
.field span {
	display: block;
	font-size: var(--fs-sm);
	color: var(--text-dim);
	margin-bottom: 6px;
}
.field input {
	width: 100%;
	padding: 11px 13px;
	font-size: var(--fs-lg);
	color: var(--text);
	background: rgba(0, 0, 0, 0.25);
	border: 1px solid var(--border);
	border-radius: 10px;
	outline: none;
	transition: border-color 0.15s, box-shadow 0.15s;
}
.field input:focus {
	border-color: var(--accent);
	box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.error {
	display: flex;
	align-items: center;
	gap: 6px;
	margin: 4px 0 12px;
	color: var(--danger);
	font-size: var(--fs-md);
}
.error .material-symbols-rounded {
	font-size: var(--icon-md);
}
/* The shared primary button, full width and a size up: the one action on this page. */
.submit {
	width: 100%;
	height: 42px;
	gap: 9px;
	margin-top: 6px;
	font-size: var(--fs-lg);
	border-radius: 10px;
}
.spinner {
	width: 15px;
	height: 15px;
	border-radius: 50%;
	border: 2px solid currentColor;
	border-top-color: transparent;
	animation: spin 0.9s linear infinite; /* global keyframes (styles.css) */
}
.offline-hint {
	display: flex; gap: 8px; align-items: flex-start; margin: 14px 0 0;
	font-size: var(--fs-sm); color: var(--text-dim);
}
.offline-hint.active { color: var(--warn); }
.offline-hint .material-symbols-rounded { font-size: var(--icon-md); flex-shrink: 0; }
.host {
	margin: 18px 0 0;
	text-align: center;
	font-size: var(--fs-xs);
	color: var(--text-dim);
	opacity: 0.7;
	word-break: break-all;
}
</style>
