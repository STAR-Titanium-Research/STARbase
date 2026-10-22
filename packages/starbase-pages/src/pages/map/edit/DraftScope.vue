<script setup lang="ts">
import { computed } from 'vue';
import { campaignOptions, withListed, type CampaignOption, type ProjectOption } from './projectCampaign';

// The draft's project and campaign (R12, E16), in the edit lid: every new record is made in them at Create, and the map draws the project
// frame around the draft. Pre-filled from the first sample added; editable at any time. The campaigns offered are those of the chosen project.
// Presentational: the page owns the draft and the lists (useEditMode.choices).
const props = defineProps<{
	projects: ProjectOption[];
	campaigns: CampaignOption[];
	projectId: string | null;
	campaignId: string | null;
	/** Said when a list could not be read or was cut. */
	note?: string;
}>();
const emit = defineEmits<{ project: [id: string | null]; campaign: [id: string | null] }>();

const projectChoices = computed(() => withListed(props.projects, props.projectId, 'A project you may not list'));
const campaignChoices = computed(() => withListed(campaignOptions(props.campaigns, props.projectId), props.campaignId, 'A campaign you may not list'));
const pick = (e: Event): string | null => (e.target as HTMLSelectElement).value || null;
</script>

<template>
	<span class="pm-scope" role="group" aria-label="Project and campaign of this draft" :title="note || undefined">
		<label>
			<span class="t">Project</span>
			<select class="sel" aria-label="Project" :value="projectId ?? ''" @change="emit('project', pick($event))">
				<option value="">None</option>
				<option v-for="p in projectChoices" :key="p.value" :value="p.value" :selected="p.value === projectId">{{ p.label }}</option>
			</select>
		</label>
		<label>
			<span class="t">Campaign</span>
			<select class="sel" aria-label="Campaign" :value="campaignId ?? ''" @change="emit('campaign', pick($event))">
				<option value="">None</option>
				<option v-for="c in campaignChoices" :key="c.value" :value="c.value" :selected="c.value === campaignId">{{ c.label }}</option>
			</select>
		</label>
		<span v-if="note" class="warn" role="status">{{ note }}</span>
	</span>
</template>

<style scoped>
/* One line, as the lid's draft group is: the two choices shrink (to their ellipsis) before the scope wraps. */
.pm-scope { display: inline-flex; flex-wrap: nowrap; align-items: center; gap: 4px 10px; min-width: 0; flex: 0 1 auto; }
label { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.t { color: var(--d1-dim); font-size: var(--fs-xs, 11px); font-weight: 650; }
.sel {
	max-width: 190px; min-width: 56px; padding: 3px 6px; text-overflow: ellipsis; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface);
	color: inherit; font: inherit; font-size: var(--fs-sm, 12px);
}
.sel:hover, .sel:focus-visible { border-color: var(--d1-accent, var(--theme--primary)); outline: none; }
.warn { color: var(--d1-dim); font-size: var(--fs-xs, 11px); }
</style>
