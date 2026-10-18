<template>
	<section class="card">
		<h2>
			Deploy run <span class="mono muted">{{ runId }}</span>
		</h2>

		<v-notice v-if="restarting" type="warning">Directus is restarting… still watching the run, retrying every 2 seconds.</v-notice>
		<v-notice v-if="problem" type="danger">{{ problem.message }}</v-notice>

		<ul class="steps">
			<li v-for="s in stepRows" :key="s.name">
				<v-icon v-if="s.state === 'ok'" name="check_circle" class="ok" small />
				<v-icon v-else-if="s.state === 'bad'" name="error" class="bad" small />
				<v-icon v-else-if="s.state === 'skip'" name="remove_circle_outline" class="muted" small />
				<v-progress-circular v-else-if="s.state === 'running'" indeterminate small />
				<span class="mono">{{ s.name }}</span>
				<span v-if="s.state === 'skip'" class="muted"> skipped</span>
				<span v-else-if="s.ms != null" class="muted"> {{ (s.ms / 1000).toFixed(1) }}s</span>
			</li>
			<li v-if="!stepRows.length && !result" class="muted">Starting…</li>
		</ul>

		<template v-if="result">
			<v-notice v-if="result.ok" type="success">
				Deployed {{ shortSha(result.fromSha) }} → {{ shortSha(result.toSha) }}. Reload this page to load the new extensions.
				<v-button small class="reload" @click="reload">Reload now</v-button>
			</v-notice>
			<v-notice v-else type="danger">
				Failed at <strong>{{ result.failedStep ?? 'unknown step' }}</strong>: {{ result.message }}
				<div v-if="result.backup">
					Database backup taken before the migration: <span class="mono">{{ result.backup }}</span>
				</div>
			</v-notice>
		</template>

		<pre ref="logEl" class="log">{{ log || 'Waiting for output…' }}</pre>
	</section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import type { ApiProblem, RunPoll, RunResult } from './types';
import { describeError, shortSha, stepsInLog } from './api';

const props = defineProps<{ runId: string }>();
const emit = defineEmits<{ (e: 'done', result: RunResult | null): void }>();

const POLL_MS = 2000;
const api = useApi();

const log = ref('');
const offset = ref(0);
const result = ref<RunResult | null>(null);
const restarting = ref(false);
const problem = ref<ApiProblem | null>(null);
const logEl = ref<HTMLElement | null>(null);

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

interface Row {
	name: string;
	state: 'ok' | 'bad' | 'running' | 'skip';
	ms: number | null;
}

const stepRows = computed<Row[]>(() => {
	const r = result.value;
	if (r?.steps.length) {
		const rows: Row[] = r.steps.map((s) => ({ name: s.name, state: s.skipped ? 'skip' : s.ok ? 'ok' : 'bad', ms: s.skipped ? null : s.ms }));
		if (r.failedStep && !rows.some((x) => x.name === r.failedStep)) rows.push({ name: r.failedStep, state: 'bad', ms: null });
		return rows;
	}
	const seen = stepsInLog(log.value);
	return seen.map((name, i) => ({
		name,
		state: r ? (r.failedStep === name || (!r.ok && i === seen.length - 1) ? 'bad' : 'ok') : i === seen.length - 1 ? 'running' : 'ok',
		ms: null,
	}));
});

async function poll() {
	if (stopped) return;
	try {
		const { data } = await api.get<RunPoll>(`/d1-deploy/runs/${props.runId}`, { params: { offset: offset.value } });
		restarting.value = false;
		problem.value = null;
		if (data.log) {
			const el = logEl.value;
			const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
			log.value += data.log;
			if (atBottom) await nextTick(() => logEl.value && (logEl.value.scrollTop = logEl.value.scrollHeight));
		}
		offset.value = data.nextOffset;
		if (data.done) {
			result.value = data.result;
			stopped = true;
			emit('done', data.result);
			return;
		}
	} catch (e) {
		const p = describeError(e);
		if (p.status === 404 && p.code !== 'ROUTE_NOT_FOUND') {
			// The agent has no such run (pruned or never existed): nothing left to watch. Directus's own
			// ROUTE_NOT_FOUND (endpoint not loaded yet after a restart) is retried like any other failure.
			problem.value = p;
			stopped = true;
			emit('done', null);
			return;
		}
		// Anything else (Directus or the agent restarting, a dropped connection): keep trying.
		restarting.value = true;
		problem.value = null;
	}
	if (!stopped) timer = setTimeout(poll, POLL_MS);
}

function reload() {
	window.location.reload();
}

onMounted(poll);
onBeforeUnmount(() => {
	stopped = true;
	if (timer) clearTimeout(timer);
});
</script>

<style scoped>
.steps {
	list-style: none;
	margin: 8px 0;
	padding: 0;
	display: grid;
	gap: 4px;
}
.steps li {
	display: flex;
	align-items: center;
	gap: 8px;
}
.ok {
	color: var(--theme--success);
}
.bad {
	color: var(--theme--danger);
}
.mono {
	font-family: var(--theme--fonts--monospace--font-family);
}
.muted {
	color: var(--theme--foreground-subdued);
}
.reload {
	margin-left: 12px;
}
.log {
	margin: 12px 0 0;
	padding: 12px;
	max-height: 360px;
	overflow: auto;
	white-space: pre-wrap;
	word-break: break-word;
	font-family: var(--theme--fonts--monospace--font-family);
	font-size: 12px;
	background: var(--theme--background-subdued);
	color: var(--theme--foreground);
	border: 1px solid var(--theme--border-color-subdued);
	border-radius: var(--theme--border-radius);
}
</style>
