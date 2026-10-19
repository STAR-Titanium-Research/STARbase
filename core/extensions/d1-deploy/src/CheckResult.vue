<template>
	<section class="card">
		<h2>Check result</h2>

		<v-notice v-if="result.upToDate" type="success">Up to date: nothing new on origin/main.</v-notice>

		<template v-else>
			<v-notice v-if="result.resume" type="warning" class="resume">
				An earlier deploy ({{ formatTime(result.resume.runId) }}) merged the update but stopped at
				<strong>{{ result.resume.failedStep ?? 'a later step' }}</strong
				>. Resume runs the steps it did not finish; the merge and migrations are not repeated.
				<div v-if="result.resume.message" class="mono muted">{{ result.resume.message }}</div>
			</v-notice>
			<p v-if="result.resume" class="summary">
				<strong>{{ result.changedCount }}</strong> changed {{ result.changedCount === 1 ? 'file' : 'files' }} since
				<span class="mono muted">{{ shortSha(result.resume.fromSha) }}</span> need their steps finished.
			</p>
			<p v-else class="summary">
				<strong>{{ result.commits.length }}</strong> new {{ result.commits.length === 1 ? 'commit' : 'commits' }},
				<strong>{{ result.changedCount }}</strong> changed {{ result.changedCount === 1 ? 'file' : 'files' }}.
				<span class="mono muted">{{ shortSha(result.head) }} → {{ shortSha(result.target) }}</span>
			</p>

			<div v-if="result.blockers.length" class="blockers">
				<v-notice v-for="b in result.blockers" :key="b.code + b.message" type="danger">{{ b.message }}</v-notice>
			</div>

			<template v-if="result.holders?.length">
				<h3>Blocking npm install</h3>
				<v-notice type="warning">
					These processes hold files in node_modules, so npm install would fail with "resource busy". Stop them yourself, or let the deploy stop them (and their child processes) right before the install.
				</v-notice>
				<ul class="holders">
					<li v-for="h in result.holders" :key="h.pid">
						<span class="mono">{{ h.name }} · pid {{ h.pid }}</span>
						<span class="muted"> — {{ h.reason }}</span>
						<div class="mono muted cmd">{{ h.cmd }}</div>
					</li>
				</ul>
				<v-checkbox
					:model-value="acks.includes(STOP_HOLDERS_ACK)"
					label="Stop these processes before installing"
					@update:model-value="(v: boolean) => $emit('toggle-ack', STOP_HOLDERS_ACK, v)"
				/>
			</template>

			<h3>{{ result.resume ? 'Commits since the merge' : 'Commits' }}</h3>
			<ul class="commits">
				<li v-for="c in result.commits" :key="c.sha">
					<span class="mono muted">{{ shortSha(c.sha) }}</span> {{ c.subject }}
				</li>
			</ul>

			<h3>Will run</h3>
			<div class="chips">
				<span v-for="s in result.steps" :key="s" class="chip">{{ s }}</span>
				<span v-if="!result.steps.length" class="muted">no restart needed</span>
			</div>

			<template v-if="result.migrations.length">
				<h3>Migrations</h3>
				<ul class="migrations">
					<li v-for="m in result.migrations" :key="m.file" :class="{ destructive: m.destructive.length > 0 }">
						<div class="mono">{{ m.file }}</div>
						<template v-if="m.destructive.length">
							<div class="flag">
								<v-icon name="warning" small /> Destructive:
								<span v-for="d in m.destructive" :key="d" class="chip danger">{{ d }}</span>
							</div>
							<v-checkbox
								:model-value="acks.includes(m.file)"
								label="I've read this migration"
								@update:model-value="(v: boolean) => $emit('toggle-ack', m.file, v)"
							/>
						</template>
					</li>
				</ul>
			</template>
			<p v-else class="muted">No migrations in this update.</p>
		</template>
	</section>
</template>

<script setup lang="ts">
import type { CheckResult } from './types';
import { formatTime, shortSha } from './api';
import { STOP_HOLDERS_ACK } from './types';

defineProps<{ result: CheckResult; acks: string[] }>();
defineEmits<{ (e: 'toggle-ack', file: string, on: boolean): void }>();
</script>

<style scoped>
h3 {
	margin: 16px 0 6px;
	font-size: 14px;
	color: var(--theme--foreground-subdued);
}
.summary {
	margin: 0 0 8px;
}
.blockers {
	display: grid;
	gap: 8px;
	margin: 8px 0;
}
.mono {
	font-family: var(--theme--fonts--monospace--font-family);
}
.muted {
	color: var(--theme--foreground-subdued);
}
.resume {
	margin-bottom: 8px;
}
.holders {
	list-style: none;
	margin: 8px 0;
	padding: 0;
}
.holders li {
	padding: 6px 12px;
	margin-bottom: 6px;
	border: 1px solid var(--theme--warning);
	border-radius: var(--theme--border-radius);
}
.cmd {
	font-size: 12px;
	word-break: break-all;
}
.commits,
.migrations {
	list-style: none;
	margin: 0;
	padding: 0;
}
.commits li {
	padding: 3px 0;
}
.chips {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}
.chip {
	display: inline-block;
	padding: 2px 10px;
	border-radius: 999px;
	background: var(--theme--background-normal);
	color: var(--theme--foreground);
	font-family: var(--theme--fonts--monospace--font-family);
	font-size: 12px;
}
.chip.danger {
	background: var(--theme--danger-background);
	color: var(--theme--danger);
	margin-left: 4px;
}
.migrations li {
	padding: 8px 12px;
	margin-bottom: 8px;
	border: 1px solid var(--theme--border-color-subdued);
	border-radius: var(--theme--border-radius);
}
.migrations li.destructive {
	border-color: var(--theme--danger);
}
.flag {
	margin: 4px 0;
	color: var(--theme--danger);
}
</style>
