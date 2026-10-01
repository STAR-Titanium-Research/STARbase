<script setup lang="ts">
// Shown for the whole of an offline session (signed in from the on-device verifier, no Directus
// token). It is deliberately a strip, not a dialog or a redirect: the operator may be mid-cut and
// must never be bounced to /login. Recording, local saving and the pickers all keep working;
// this is only the way back to a real session, which is what lets queued records and local
// captures upload -- under the account that recorded them.
import { computed, onBeforeUnmount, ref } from 'vue';
import { authStore } from './authStore';
import { flush, syncStatus } from './record/directusSync';
import { syncLookups } from './record/lookupCache';

const online = ref(navigator.onLine);
const setOn = () => { online.value = true; };
const setOff = () => { online.value = false; };
window.addEventListener('online', setOn);
window.addEventListener('offline', setOff);
onBeforeUnmount(() => { window.removeEventListener('online', setOn); window.removeEventListener('offline', setOff); });

const show = computed(() => authStore.state.offline);
const who = computed(() => {
	const u = authStore.state.user;
	return [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.email || 'this account';
});

const asking = ref(false);
const password = ref('');
const busy = ref(false);
const error = ref('');

async function signIn() {
	if (busy.value || !password.value) return;
	busy.value = true;
	error.value = '';
	try {
		await authStore.reauthenticate(password.value);
		password.value = '';
		asking.value = false;
		void flush();
		void syncLookups();
	} catch (e: any) {
		error.value = e?.message || 'sign-in failed';
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<div v-if="show" class="off-banner" role="status">
		<span class="material-symbols-rounded">cloud_off</span>
		<span class="off-text">
			<b>Signed in offline as {{ who }}.</b>
			Recordings are saved on this PC and stamped with your name.
			<template v-if="syncStatus.pending > 0">{{ syncStatus.pending }} record(s) waiting to upload.</template>
		</span>
		<template v-if="asking">
			<form class="off-form" @submit.prevent="signIn">
				<input v-model="password" type="password" autocomplete="current-password" placeholder="Password" :disabled="busy" autofocus />
				<button class="btn sm primary" type="submit" :disabled="busy || !password">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
				<button class="btn sm" type="button" :disabled="busy" @click="asking = false; error = ''">Cancel</button>
			</form>
			<span v-if="error" class="off-err">{{ error }}</span>
		</template>
		<button v-else-if="online" class="btn sm primary off-act" type="button" @click="asking = true">Sign in to sync</button>
		<span v-else class="off-wait">Reconnect to upload.</span>
	</div>
</template>

<style scoped>
.off-banner {
	position: sticky; top: 0; z-index: 140; display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
	padding: 8px 16px; font-size: var(--fs-md); color: var(--text);
	background: color-mix(in srgb, var(--warn) 16%, var(--bg-2)); border-bottom: 1px solid color-mix(in srgb, var(--warn) 45%, transparent);
}
.off-banner > .material-symbols-rounded { color: var(--warn); font-size: var(--icon-md); }
.off-text { flex: 1 1 320px; min-width: 0; }
.off-act { margin-left: auto; }
.off-form { display: flex; gap: 8px; align-items: center; margin-left: auto; }
.off-form input {
	padding: 6px 10px; font-size: var(--fs-md); color: var(--text); background: var(--surface);
	border: 1px solid var(--border-2); border-radius: 8px; outline: none;
}
.off-form input:focus { border-color: var(--accent); }
.off-err { color: var(--danger); flex-basis: 100%; }
.off-wait { margin-left: auto; color: var(--text-dim); }
</style>
