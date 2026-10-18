<template>
	<section class="card">
		<h2>Check result</h2>

		<v-notice v-if="result.upToDate" type="success">Up to date: nothing new on origin/main.</v-notice>

		<template v-else>
			<p class="summary">
				<strong>{{ result.commits.length }}</strong> new {{ result.commits.length === 1 ? 'commit' : 'commits' }},
				<strong>{{ result.changedCount }}</strong> changed {{ result.changedCount === 1 ? 'file' : 'files' }}.
				<span class="mono muted">{{ shortSha(result.head) }} → {{ shortSha(result.target) }}</span>
			</p>

			<div v-if="result.blockers.length" class="blockers">
				<v-notice v-for="b in result.blockers" :key="b.code + b.message" type="danger">{{ b.message }}</v-notice>
			</div>

			<h3>Commits</h3>
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
import { shortSha } from './api';

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
