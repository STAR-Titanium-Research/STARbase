<script setup lang="ts">
// One pending rig-test request with its three answers: Run now, Snooze, Decline. Used by the prompt
// dialog (the oldest request) and by Settings > Rig tests (all of them), so both behave the same.
// A refusal (e.g. 409 "a recording is in progress") is shown inline, where the operator is looking.
import { computed, ref } from 'vue';
import { syncStatus } from '../record/directusSync';
import { rigTest } from './rigTestStore';
import {
	DECLINE_REASONS, DECLINE_TEXT_MAX, SNOOZE_PRESETS, declineBody, estimateText,
	type DeclineCode, type RigRequest,
} from './rigTestLogic';

const props = defineProps<{ request: RigRequest }>();

const panel = ref<'snooze' | 'decline' | null>(null);
const atTime = ref('');
const reason = ref<DeclineCode | null>(null);
const reasonText = ref('');

const busy = computed(() => rigTest.state.busy[props.request.number]);
const error = computed(() => rigTest.state.errors[props.request.number] || '');
const sendable = computed(() => !!declineBody(reason.value, reasonText.value));
const estimate = computed(() => estimateText(props.request.estimate_s.full, props.request.needs_operator_steps));
const asked = computed(() => {
	const d = Date.parse(props.request.created_at);
	return Number.isFinite(d) ? new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
});

function toggle(p: 'snooze' | 'decline') { panel.value = panel.value === p ? null : p; }
function run() { void rigTest.accept(props.request.number, syncStatus.syncing); }
</script>

<template>
	<div class="rq" :data-testid="`rig-request-${request.number}`">
		<div class="rq-title">
			<a v-if="request.url" :href="request.url" target="_blank" rel="noopener">#{{ request.number }} {{ request.title }}</a>
			<span v-else>#{{ request.number }} {{ request.title }}</span>
		</div>
		<div class="rq-by">
			Requested by <b>{{ request.requested_by || 'your admin' }}</b><template v-if="asked"> · {{ asked }}</template>
		</div>

		<ul v-if="request.items.length" class="rq-items" aria-label="Checks in this request">
			<li v-for="it in request.items" :key="it.id"><code>{{ it.id }}</code><span>{{ it.title }}</span></li>
		</ul>

		<p v-if="request.error" class="rq-err" role="alert"><span class="material-symbols-rounded">error</span>{{ request.error }}</p>
		<p class="rq-est"><span class="material-symbols-rounded">schedule</span>Full run: {{ estimate }}</p>
		<p v-if="error" class="rq-err" role="alert" data-testid="rig-request-error"><span class="material-symbols-rounded">error</span>{{ error }}</p>

		<div class="rq-actions">
			<button type="button" class="btn primary" :disabled="!!busy || !!request.error" @click="run">
				<span class="material-symbols-rounded">{{ busy === 'accept' ? 'hourglass_top' : 'play_arrow' }}</span>Run now
			</button>
			<button type="button" class="btn" :class="{ on: panel === 'snooze' }" :aria-expanded="panel === 'snooze'" :disabled="!!busy" @click="toggle('snooze')">
				<span class="material-symbols-rounded">snooze</span>Snooze
			</button>
			<button type="button" class="btn quiet" :class="{ on: panel === 'decline' }" :aria-expanded="panel === 'decline'" :disabled="!!busy" @click="toggle('decline')">
				<span class="material-symbols-rounded">block</span>Decline
			</button>
		</div>

		<div v-if="panel === 'snooze'" class="rq-panel" role="group" aria-label="Snooze until">
			<div class="rq-chips">
				<button v-for="p in SNOOZE_PRESETS" :key="p.label" type="button" class="chip" :disabled="!!busy" @click="rigTest.snooze(request.number, p.choice)">{{ p.label }}</button>
			</div>
			<form class="rq-at" @submit.prevent="rigTest.snooze(request.number, { kind: 'time', hhmm: atTime })">
				<label>At <input v-model="atTime" type="time" required aria-label="Snooze until this time" /></label>
				<button type="submit" class="btn sm" :disabled="!atTime || !!busy">Snooze</button>
			</form>
		</div>

		<div v-if="panel === 'decline'" class="rq-panel" role="group" aria-label="Why decline">
			<div class="rq-chips">
				<button v-for="r in DECLINE_REASONS" :key="r.code" type="button" class="chip" :class="{ on: reason === r.code }"
					:aria-pressed="reason === r.code" :disabled="!!busy" @click="reason = r.code">{{ r.label }}</button>
			</div>
			<textarea v-if="reason === 'other'" v-model="reasonText" rows="2" :maxlength="DECLINE_TEXT_MAX" placeholder="Why not?" aria-label="Reason for declining"></textarea>
			<div class="rq-decline-go">
				<button type="button" class="btn danger" :disabled="!sendable || !!busy" @click="rigTest.decline(request.number, reason, reasonText)">
					<span class="material-symbols-rounded">block</span>Decline request
				</button>
			</div>
		</div>
	</div>
</template>

<style scoped>
.rq { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.rq-title { font-size: var(--fs-lg); font-weight: 700; overflow-wrap: anywhere; }
.rq-title a { color: var(--text); text-decoration: none; }
.rq-title a:hover { text-decoration: underline; }
.rq-by { font-size: var(--fs-md); color: var(--text-dim); }
.rq-by b { color: var(--text); font-weight: 600; }
.rq-items { list-style: none; margin: 2px 0; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; max-height: 150px; overflow-y: auto;
	background: var(--surface); border: 1px solid var(--border); border-radius: 9px; font-size: var(--fs-md); }
.rq-items li { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.rq-items code { flex: 0 0 auto; font-size: var(--fs-sm); color: var(--accent); }
.rq-items span { overflow-wrap: anywhere; }
.rq-est { display: flex; align-items: center; gap: 6px; margin: 0; font-size: var(--fs-md); color: var(--text); }
.rq-est .material-symbols-rounded { font-size: var(--icon-md); color: var(--text-dim); }
.rq-err { display: flex; align-items: flex-start; gap: 6px; margin: 0; font-size: var(--fs-md); color: var(--danger); line-height: 1.4; }
.rq-err .material-symbols-rounded { font-size: var(--icon-md); flex: 0 0 auto; }
.rq-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.rq-panel { display: flex; flex-direction: column; gap: 8px; padding: 10px; background: var(--surface); border: 1px solid var(--border); border-radius: 9px; }
.rq-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { padding: 5px 11px; font: inherit; font-size: var(--fs-sm); color: var(--text-dim); background: transparent; border: 1px solid var(--border-2); border-radius: 99px; cursor: pointer; }
.chip:hover:not(:disabled) { color: var(--text); }
.chip:disabled { opacity: 0.5; cursor: not-allowed; }
.chip.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.rq-at { display: flex; align-items: center; gap: 8px; font-size: var(--fs-md); color: var(--text-dim); }
.rq-at input { padding: 5px 8px; font: inherit; color: var(--text); background: var(--bg-2); border: 1px solid var(--border); border-radius: 7px; color-scheme: light dark; }
.rq-panel textarea { padding: 8px 10px; font: inherit; font-size: var(--fs-md); color: var(--text); background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; resize: vertical; }
.rq-decline-go { display: flex; }
</style>
