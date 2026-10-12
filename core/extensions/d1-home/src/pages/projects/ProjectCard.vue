<script setup lang="ts">
import { computed } from 'vue';
import { RecordCard, Sparkline, formatDate, projectStatusLabel, recordRoute, type ProjectRole, type WeeklyActivity } from '@d1/ui';
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
	<RecordCard :to="to" :code="project.project_code" :name="project.project_name" raised>
		<template #tag>
			<span v-if="role" class="d1-tag">{{ role === 'pi' ? 'You are PI' : 'You are investigator' }}</span>
			<span class="status" :class="{ active }">{{ projectStatusLabel(project.is_active) }}</span>
		</template>
		<template #meta>
			<span>PI: {{ project.principal_investigator_person?.full_name || 'not set' }}</span>
			<span>{{ dates }}</span>
		</template>
		<span class="d1-counts" title="Counts only what you can see">
			<span><b>{{ show(campaigns) }}</b> campaigns visible</span>
			<span><b>{{ show(samples) }}</b> samples visible</span>
		</span>
		<Sparkline v-if="activity" :ops="activity.ops" :tests="activity.tests" :weeks="activity.weeks" />
		<span v-else class="spark-placeholder">Activity unavailable</span>
	</RecordCard>
</template>

<style scoped>
.status {
	font-size: var(--fs-xs); font-weight: 700; padding: 1px 8px; border-radius: 99px; white-space: nowrap;
	color: var(--d1-dim); background: var(--theme--background-normal);
}
.status.active { color: var(--d1-ok); background: color-mix(in srgb, var(--theme--success) 18%, transparent); }
.spark-placeholder { font-size: var(--fs-sm); color: var(--d1-dim); }
</style>
