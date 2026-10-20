<script setup lang="ts">
import { computed } from 'vue';
import { LoadState, ProjectTimeline, timelineCampaigns, type AccessList, type PinRef, type SectionState, type TimelineRange } from '@d1/ui';
import ProjectHead from './ProjectHead.vue';
import ProjectAbout from './ProjectAbout.vue';
import ProjectTotals from './ProjectTotals.vue';
import type { Activity, PlannedWork, ProjectCounts } from './useProjectData';

// The Project page's hero: one surface that says what the project is, who is on it and how far it has got. Head (title, badges, actions,
// people), the timeline, About and Totals. The layout follows the hero's own width (a container query on `hero`, the outer element
// below, so it also holds beside the Data Studio sidebar): one column under 700px; from 700px the timeline spans the
// top and About and Totals sit side by side under it; from 1500px the timeline takes two thirds with About and Totals stacked beside it.
// Spec: docs/superpowers/specs/2026-10-20-project-page-hero-design.md.
const props = defineProps<{
	project: any;
	canUpdate: boolean | null;
	studioTo: string;
	mapTo: string;
	pin: PinRef | null;
	access: SectionState<AccessList | null>;
	counts: SectionState<ProjectCounts>;
	campaigns: SectionState<any[]>;
	activity: SectionState<Activity>;
	planned: SectionState<PlannedWork>;
}>();
defineEmits<{ edit: []; access: [] }>();
const range = defineModel<TimelineRange>('range', { default: 'all' });

const timelineProject = computed(() => ({ code: props.project.project_code ?? undefined, start: props.project.start_date ?? null, end: props.project.end_date ?? null }));
const campaignRows = computed(() => timelineCampaigns(props.campaigns.data));
// The first read has not answered: a line, not an empty chart that would read as "no work".
const firstLoad = computed(() => (props.activity.loading || props.planned.loading) && !props.activity.data.ops.length && !props.activity.data.tests.length);
</script>

<template>
	<!-- The container is this plain outer element, not the padded surface inside it, so the breakpoints measure the width the hero takes. -->
	<div class="hero-box">
		<section class="hero" aria-label="Project overview">
			<ProjectHead
				class="a-head"
				:project="project" :can-update="canUpdate" :studio-to="studioTo" :map-to="mapTo" :pin="pin" :access="access.data"
				@edit="$emit('edit')" @access="$emit('access')"
			/>
			<div class="a-chart">
				<LoadState :loading="firstLoad" :error="activity.error" loading-text="Loading activity…">
					<ProjectTimeline
						v-model:range="range"
						:project="timelineProject"
						:campaigns="campaignRows"
						:ops="activity.data.ops"
						:tests="activity.data.tests"
						:planned-ops="planned.data.ops"
						:planned-tests="planned.data.tests"
						:truncated="activity.data.truncated"
					/>
				</LoadState>
				<p v-if="planned.error" class="d1-note warn" role="alert">{{ planned.error }}</p>
			</div>
			<ProjectAbout class="a-about" :start="project.start_date" :end="project.end_date" :document-number="project.document_number" :description="project.description" />
			<ProjectTotals class="a-totals" :counts="counts" />
		</section>
	</div>
</template>

<style scoped>
.hero-box { container: hero / inline-size; min-width: 0; }
.hero {
	display: grid; gap: 16px 28px; min-width: 0; padding: 16px;
	background: var(--d1-surface, var(--theme--background)); border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: var(--d1-radius, 12px); box-shadow: var(--d1-shadow, none);
	grid-template-columns: minmax(0, 1fr);
	grid-template-areas: 'head' 'chart' 'about' 'totals';
}
.a-head { grid-area: head; min-width: 0; }
.a-chart { grid-area: chart; min-width: 0; }
.a-about { grid-area: about; min-width: 0; }
.a-totals { grid-area: totals; min-width: 0; }
@container hero (min-width: 700px) {
	.hero { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-areas: 'head head' 'chart chart' 'about totals'; }
}
@container hero (min-width: 1500px) {
	.hero { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); grid-template-areas: 'head head' 'chart about' 'chart totals'; align-items: start; }
}
</style>
