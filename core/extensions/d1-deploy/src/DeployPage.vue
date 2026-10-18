<template>
	<private-view title="Deploy">
		<template #title-outer:prepend>
			<v-button class="header-icon" rounded disabled icon secondary>
				<v-icon name="rocket_launch" />
			</v-button>
		</template>

		<template #actions>
			<v-button secondary :loading="checking" :disabled="busy || !state" @click="runCheck">
				<v-icon name="update" left />
				Check for updates
			</v-button>
			<v-button :disabled="!canDeploy" kind="danger" @click="confirmOpen = true">
				<v-icon name="rocket_launch" left />
				Deploy
			</v-button>
		</template>

		<div class="page">
			<StatusCard :state="state" :problem="stateProblem" :loading="loadingState" />

			<div v-if="actionProblem" class="problem">
				<v-notice type="danger">{{ actionProblem.message }}</v-notice>
				<p v-if="actionHint" class="hint">{{ actionHint }}</p>
			</div>

			<RunView v-if="runId" :key="runId" :run-id="runId" @done="onRunDone" />

			<CheckResult v-if="check && (!runId || runDone)" :result="check" :acks="acks" @toggle-ack="toggleAck" />

			<p v-if="!check && !runId && state" class="muted intro">
				Check for updates fetches origin/main and shows what a deploy would do. Nothing changes until you press Deploy.
			</p>
		</div>

		<v-dialog v-model="confirmOpen" @esc="confirmOpen = false">
			<v-card>
				<v-card-title>Deploy to d1-server?</v-card-title>
				<v-card-text>
					<template v-if="check">
						This merges {{ check.commits.length }} {{ check.commits.length === 1 ? 'commit' : 'commits' }} from origin/main and runs:
						<strong>{{ check.steps.join(', ') || 'no steps' }}</strong>.
						<template v-if="check.needsAck.length"> You have confirmed {{ check.needsAck.length }} destructive migration(s). A database backup is taken first.</template>
						Directus may restart; this page keeps following the run.
					</template>
				</v-card-text>
				<v-card-actions>
					<v-button secondary @click="confirmOpen = false">Cancel</v-button>
					<v-button kind="danger" :loading="starting" @click="startDeploy">Deploy</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</private-view>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import StatusCard from './StatusCard.vue';
import CheckResult from './CheckResult.vue';
import RunView from './RunView.vue';
import type { AgentState, ApiProblem, CheckResult as Check, RunResult } from './types';
import { describeError, hintFor } from './api';

const api = useApi();

const state = ref<AgentState | null>(null);
const stateProblem = ref<ApiProblem | null>(null);
const loadingState = ref(false);

const check = ref<Check | null>(null);
const checking = ref(false);
const acks = ref<string[]>([]);

const confirmOpen = ref(false);
const starting = ref(false);
const runId = ref<string | null>(null);
const actionProblem = ref<ApiProblem | null>(null);

const actionHint = computed(() => hintFor(actionProblem.value?.code ?? null));
// A run is in progress (started here, or found running in the agent's state).
const runDone = ref(false); // the run shown in RunView has finished
const busy = computed(() => (runId.value !== null && !runDone.value) || state.value?.running === true);

const canDeploy = computed(() => {
	const c = check.value;
	if (!c || c.upToDate || busy.value || starting.value) return false;
	if (c.blockers.length > 0) return false;
	return c.needsAck.every((f) => acks.value.includes(f));
});

async function loadState() {
	loadingState.value = true;
	try {
		const { data } = await api.get<AgentState>('/d1-deploy/state');
		state.value = data;
		stateProblem.value = null;
		// Re-attach to a run that is already going (page reload, another admin).
		if (data.running && data.current && !runId.value) {
			runDone.value = false;
			runId.value = data.current.id;
		}
	} catch (e) {
		state.value = null;
		stateProblem.value = describeError(e);
	} finally {
		loadingState.value = false;
	}
}

async function runCheck() {
	checking.value = true;
	actionProblem.value = null;
	if (runDone.value) runId.value = null; // dismiss the finished run's view
	try {
		const { data } = await api.post<Check>('/d1-deploy/check');
		check.value = data;
		// Ticks apply to the migrations of the latest check only.
		acks.value = acks.value.filter((f) => data.needsAck.includes(f));
	} catch (e) {
		check.value = null;
		actionProblem.value = describeError(e);
	} finally {
		checking.value = false;
	}
}

function toggleAck(file: string, on: boolean) {
	acks.value = on ? [...new Set([...acks.value, file])] : acks.value.filter((f) => f !== file);
}

async function startDeploy() {
	starting.value = true;
	actionProblem.value = null;
	try {
		const { data } = await api.post<{ id: string }>('/d1-deploy/deploy', { ack: acks.value });
		runDone.value = false;
		runId.value = data.id;
		check.value = null;
		acks.value = [];
		confirmOpen.value = false;
	} catch (e) {
		const p = describeError(e);
		confirmOpen.value = false;
		if (p.code === 'busy') {
			actionProblem.value = { ...p, message: 'Another deploy is already running. Showing it below.' };
			await loadState();
		} else {
			actionProblem.value = p;
		}
	} finally {
		starting.value = false;
	}
}

async function onRunDone(_result: RunResult | null) {
	// Keep the run view (log and outcome) on screen; refresh the status card beside it.
	runDone.value = true;
	await loadState();
	// The agent may still report the run as running for a moment after result.json is written.
	if (state.value?.running && state.value.current?.id === runId.value) state.value = { ...state.value, running: false };
}

onMounted(loadState);
</script>

<style scoped>
.page {
	padding: var(--content-padding);
	padding-top: 0;
	display: grid;
	gap: 16px;
	max-width: 900px;
}
.card {
	padding: 16px 20px;
	background: var(--theme--background);
	border: 1px solid var(--theme--border-color-subdued);
	border-radius: var(--theme--border-radius);
	color: var(--theme--foreground);
}
.card :deep(h2) {
	margin: 0 0 10px;
	font-size: 16px;
}
.muted {
	color: var(--theme--foreground-subdued);
}
.intro {
	margin: 0;
}
.problem .hint {
	margin: 8px 0 0;
	color: var(--theme--foreground-subdued);
}
</style>
