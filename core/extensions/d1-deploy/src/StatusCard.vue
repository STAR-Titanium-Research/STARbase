<template>
	<section class="card status-card">
		<h2>Status</h2>
		<p v-if="loading && !state" class="muted">Loading…</p>
		<template v-else-if="state">
			<dl class="grid">
				<dt>Agent</dt>
				<dd><span class="dot ok" /> reachable<template v-if="state.running"> · a deploy is running</template></dd>
				<dt>Branch</dt>
				<dd class="mono">{{ state.repo.branch }}</dd>
				<dt>HEAD</dt>
				<dd class="mono">{{ shortSha(state.repo.head) }}</dd>
				<dt>Uncommitted files</dt>
				<dd :class="{ warn: state.repo.dirty.length > 0 }">
					{{ state.repo.dirty.length }}
					<span v-if="state.repo.dirty.length" class="muted mono" :title="state.repo.dirty.join('\n')">
						({{ state.repo.dirty.slice(0, 3).join(', ') }}{{ state.repo.dirty.length > 3 ? ', …' : '' }})
					</span>
				</dd>
				<dt>Last deploy</dt>
				<dd v-if="state.last">
					<span class="dot" :class="state.last.ok ? 'ok' : 'bad'" />
					{{ state.last.ok ? 'succeeded' : 'failed' }}
					<span class="muted">
						{{ formatTime(state.last.finishedAt ?? state.last.startedAt ?? state.last.id) }}
						<template v-if="actorLabel"> · by {{ actorLabel }}</template>
					</span>
					<div v-if="!state.last.ok && state.last.message" class="muted">{{ state.last.message }}</div>
				</dd>
				<dd v-else class="muted">no deploys recorded yet</dd>
			</dl>
		</template>
		<div v-if="problem" class="problem">
			<v-notice type="danger">{{ problem.message }}</v-notice>
			<p v-if="hint" class="hint">{{ hint }}</p>
		</div>
	</section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import type { AgentState, ApiProblem } from './types';
import { formatTime, hintFor, shortSha } from './api';

const props = defineProps<{ state: AgentState | null; problem: ApiProblem | null; loading: boolean }>();

const api = useApi();
const names = ref<Record<string, string>>({});

const hint = computed(() => hintFor(props.problem?.code ?? null));
const actorId = computed(() => props.state?.last?.actor ?? null);
const actorLabel = computed(() => (actorId.value ? (names.value[actorId.value] ?? actorId.value) : ''));

// The agent records the user id; show the person's name when the admin can read it.
watch(
	actorId,
	async (id) => {
		if (!id || names.value[id]) return;
		try {
			const { data } = await api.get(`/users/${id}`, { params: { fields: 'first_name,last_name,email' } });
			const u = data?.data ?? {};
			const full = [u.first_name, u.last_name].filter(Boolean).join(' ');
			if (full || u.email) names.value = { ...names.value, [id]: full || u.email };
		} catch {
			/* keep the id */
		}
	},
	{ immediate: true },
);
</script>

<style scoped>
.grid {
	display: grid;
	grid-template-columns: max-content 1fr;
	gap: 6px 20px;
	margin: 0;
}
dt {
	color: var(--theme--foreground-subdued);
}
dd {
	margin: 0;
	color: var(--theme--foreground);
}
.mono {
	font-family: var(--theme--fonts--monospace--font-family);
}
.muted {
	color: var(--theme--foreground-subdued);
}
.warn {
	color: var(--theme--warning);
}
.dot {
	display: inline-block;
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: var(--theme--foreground-subdued);
	margin-right: 4px;
}
.dot.ok {
	background: var(--theme--success);
}
.dot.bad {
	background: var(--theme--danger);
}
.problem {
	margin-top: 12px;
}
.hint {
	margin: 8px 0 0;
	color: var(--theme--foreground-subdued);
}
</style>
