<script setup lang="ts">
// What this PC can do with no connection: which accounts can sign in, how fresh the offline copy
// of the picker data is, and how many records are waiting. Read-mostly; the two actions are
// "Refresh now" (pull the picker data while connected) and "Forget" (stop honouring an account's
// stored offline sign-in on this PC).
import { computed, onMounted, ref } from 'vue';
import { listOfflineAccounts, revokeOfflineLogin, OFFLINE_MAX_AGE_MS } from '../offlineAuth';
import { loadLookupStatus, lookupStatus, syncLookups } from '../record/lookupCache';
import { syncStatus } from '../record/directusSync';
import { hasServerSession } from '../recorder';
import { authStore } from '../authStore';

const accounts = ref(listOfflineAccounts());
onMounted(() => { void loadLookupStatus(); });

const days = Math.round(OFFLINE_MAX_AGE_MS / 86_400_000);
const fmt = (t: number | null) => (t ? new Date(t).toLocaleString() : 'never');
const countText = computed(() => {
	const c = lookupStatus.counts;
	const parts: [string, number | undefined][] = [
		['samples', c.samples], ['operators/people', c.people], ['machines', c.equipment],
		['tools', c.tools], ['inserts', c.inserts], ['edges', c.edges],
	];
	return parts.filter(([, n]) => n != null).map(([l, n]) => `${(n as number).toLocaleString()} ${l}`).join(' · ');
});
const canRefresh = computed(() => hasServerSession() && !lookupStatus.syncing);

function forget(email: string) {
	revokeOfflineLogin(email);
	accounts.value = listOfflineAccounts();
}
</script>

<template>
	<section class="offline-card">
		<h3><span class="material-symbols-rounded">cloud_off</span> Working offline</h3>
		<p class="lead">
			The app records, saves and plots local captures with no connection. Sign-in and the pickers use copies kept on this PC;
			records made offline upload later under the account that recorded them.
		</p>

		<div class="row">
			<b>Offline sign-in</b>
			<div class="val">
				<template v-if="accounts.length">
					<div v-for="a in accounts" :key="a.email" class="acct">
						<span>{{ a.name }} <span class="dim">({{ a.email }})</span></span>
						<span class="dim">valid until {{ new Date(a.expiresAt).toLocaleDateString() }}</span>
						<button class="btn sm" type="button" :disabled="authStore.state.user?.email?.toLowerCase() === a.email" title="Stop this account signing in offline on this PC" @click="forget(a.email)">Forget</button>
					</div>
				</template>
				<span v-else class="dim">No account can sign in offline yet. Sign in once while connected.</span>
				<small class="dim">Only passwords typed at an online sign-in are remembered (as a salted hash). Each lasts {{ days }} days from that sign-in.</small>
			</div>
		</div>

		<div class="row">
			<b>Picker data</b>
			<div class="val">
				<span>Updated {{ fmt(lookupStatus.syncedAt) }}</span>
				<span v-if="countText" class="dim">{{ countText }}</span>
				<span v-if="lookupStatus.error" class="err">{{ lookupStatus.error }}</span>
				<div>
					<button class="btn sm" type="button" :disabled="!canRefresh" @click="syncLookups()">
						<span class="material-symbols-rounded">{{ lookupStatus.syncing ? 'hourglass_top' : 'sync' }}</span>
						{{ lookupStatus.syncing ? 'Refreshing…' : 'Refresh now' }}
					</button>
				</div>
			</div>
		</div>

		<div class="row">
			<b>Waiting to upload</b>
			<div class="val">
				<span>{{ syncStatus.pending }} run record(s)</span>
				<span v-if="syncStatus.waitingForOthers" class="dim">{{ syncStatus.waitingForOthers }} recorded by someone else; they upload when that user signs in</span>
				<span v-if="syncStatus.needsSignIn" class="err">Sign in while connected (banner at the top) to upload.</span>
			</div>
		</div>
	</section>
</template>

<style scoped>
.offline-card { margin: 0 0 22px; padding: 16px 18px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: var(--fs-lg); }
h3 .material-symbols-rounded { font-size: var(--icon-md); color: var(--text-dim); }
.lead { margin: 0 0 12px; color: var(--text-dim); font-size: var(--fs-md); }
.row { display: grid; grid-template-columns: 150px 1fr; gap: 12px; padding: 9px 0; border-top: 1px solid var(--border); font-size: var(--fs-md); }
.val { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.acct { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.dim { color: var(--text-dim); }
.err { color: var(--danger); }
small { font-size: var(--fs-sm); }
</style>
