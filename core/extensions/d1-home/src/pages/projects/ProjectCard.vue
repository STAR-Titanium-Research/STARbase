<script setup lang="ts">
import { computed } from 'vue';
import { Sparkline, formatDate, projectStatusLabel, recordRoute, type ProjectRole, type WeeklyActivity } from '@d1/ui';
import type { IndexProject } from './useProjectsIndex';

// One project as a card on the index. The whole card is a link to the Project page. `null`
// counts mean "not loaded (yet) or not readable" and show a dash, never a misleading 0.
const props = defineProps<{
	project: IndexProject;
	role: ProjectRole | null;
	campaigns: number | null;
	samples: number | null;
	activity: WeeklyActivity | null;
}>();

const to = computed(() => recordRoute('projects', props.project.project_id));
const active = computed(() => props.project.is_active !== false);
const dates = computed(() => {
	const start = formatDate(props.project.start_date);
	const end = formatDate(props.project.end_date);
	if (start && end) return `${start} to ${end}`;
	if (start) return `From ${start}`;
	if (end) return `Until ${end}`;
	return 'No dates set';
});
const show = (n: number | null) => (n === null ? '–' : n.toLocaleString('en-GB'));
</script>

<template>
	<router-link :to="to" class="project-card">
		<div class="top">
			<span class="code">{{ project.project_code }}</span>
			<span class="status" :class="{ active }">{{ projectStatusLabel(project.is_active) }}</span>
			<span v-if="role" class="role">{{ role === 'pi' ? 'You are PI' : 'You are investigator' }}</span>
		</div>
		<div class="name">{{ project.project_name }}</div>
		<div class="meta">
			<span>PI: {{ project.principal_investigator_person?.full_name || 'not set' }}</span>
			<span>{{ dates }}</span>
		</div>
		<div class="counts">
			<span><b>{{ show(campaigns) }}</b> campaigns</span>
			<span><b>{{ show(samples) }}</b> samples</span>
		</div>
		<Sparkline v-if="activity" :ops="activity.ops" :tests="activity.tests" :weeks="activity.weeks" />
		<div v-else class="spark-placeholder">Activity unavailable</div>
	</router-link>
</template>

<style scoped>
.project-card {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 16px 18px;
	border: 1px solid var(--theme--border-color-subdued);
	border-radius: 16px;
	background: var(--theme--background);
	color: var(--theme--foreground);
	text-decoration: none;
	min-width: 0;
	transition: transform 0.14s ease, box-shadow 0.14s ease, border-color 0.14s ease;
}
.project-card:hover { transform: translateY(-2px); border-color: var(--theme--primary); box-shadow: 0 12px 24px -16px rgba(15, 23, 42, 0.35); }
.top { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.code { font-family: var(--theme--fonts--monospace--font-family, monospace); font-weight: 750; font-size: 16px; }
.status {
	font-size: 11px; font-weight: 650; padding: 1px 9px; border-radius: 99px;
	color: var(--theme--foreground-subdued); background: var(--theme--background-normal);
}
.status.active { color: var(--theme--success); background: var(--theme--success-background); }
.role {
	margin-left: auto; font-size: 11px; font-weight: 650; padding: 1px 9px; border-radius: 99px;
	color: var(--theme--primary); background: var(--theme--primary-background);
}
.name { font-size: 14.5px; font-weight: 600; overflow-wrap: anywhere; }
.meta { display: flex; flex-wrap: wrap; gap: 2px 16px; font-size: 12.5px; color: var(--theme--foreground-subdued); }
.counts { display: flex; gap: 18px; font-size: 13px; color: var(--theme--foreground-subdued); }
.counts b { color: var(--theme--foreground); font-size: 15px; }
.spark-placeholder { font-size: 12px; font-style: italic; color: var(--theme--foreground-subdued); }
</style>
