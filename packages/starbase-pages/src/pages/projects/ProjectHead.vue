<script setup lang="ts">
import { computed } from 'vue';
import { PeopleStack, PinToggle, StatusBadge, type AccessList, type PinRef } from '@d1/ui';
import RecordActions from '../RecordActions.vue';

// The head of the Project hero: code and name (the pin appears while the pointer is over the title or the pin has focus), the kind
// pill, the status and access badges, the actions, and under them the people row (PeopleStack; its `open` shows "Who has access").
// Spec: docs/superpowers/specs/2026-10-20-project-page-hero-design.md, "Layout" and "People row".
const props = defineProps<{
	project: any;
	canUpdate: boolean | null;
	studioTo: string;
	mapTo: string;
	pin: PinRef | null;
	/** The access list; null when it could not be read (the people row then shows the PI alone). */
	access: AccessList | null;
}>();
defineEmits<{ edit: []; access: [] }>();

const code = computed(() => props.project.project_code ?? 'Project');
const active = computed(() => props.project.is_active !== false);
const piName = computed(() => props.project.principal_investigator_person?.full_name ?? '');
</script>

<template>
	<div class="row">
		<div class="id">
			<div class="title">
				<h1><span class="code">{{ code }}</span><span v-if="project.project_name" class="name">{{ project.project_name }}</span></h1>
				<span v-if="pin" class="pin"><PinToggle :target="pin" :label="code" /></span>
				<span class="badges">
					<span class="kind"><v-icon name="folder_open" x-small />Project</span>
					<!-- Active and Inactive read the same on a project as on a campaign (success, neutral). -->
					<StatusBadge kind="campaign" :value="active ? 'active' : 'inactive'" />
					<span v-if="project.export_controlled" class="badge danger"><v-icon name="gpp_maybe" x-small />Export controlled</span>
					<span v-if="access?.restricted" class="badge warn"><v-icon name="lock" x-small />Restricted</span>
				</span>
			</div>
			<PeopleStack :list="access" :pi-name="piName" @open="$emit('access')" />
		</div>
		<div class="actions">
			<RecordActions :can-update="canUpdate" :studio-to="studioTo" @edit="$emit('edit')">
				<template #access />
				<v-button icon small secondary :to="mapTo" title="Process map" aria-label="Process map"><v-icon name="account_tree" small /><span class="d1-sr-only">Process map</span></v-button>
			</RecordActions>
		</div>
	</div>
</template>

<style scoped>
.row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px 16px; }
.id { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.title { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
h1 { margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; min-width: 0; }
.code { font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: var(--fs-2xl, 22px); font-weight: 700; line-height: 1.15; overflow-wrap: anywhere; }
.name { font-size: var(--fs-xl, 18px); font-weight: 650; line-height: 1.25; text-wrap: balance; overflow-wrap: anywhere; }
/* The pin is only there while it is wanted: hovering the title, keyboard focus on it, or when the page is pinned. Touch screens have no hover, so it stays. */
.pin { opacity: 0; transition: opacity 0.15s ease; }
.title:hover .pin, .pin:focus-within, .pin:has(.on) { opacity: 1; }
@media (hover: none) { .pin { opacity: 1; } }
.badges { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.kind, .badge {
	display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px 1px 6px; border-radius: 99px;
	font-size: var(--fs-xs, 11px); font-weight: 700; line-height: 1.6; white-space: nowrap;
}
.kind { color: var(--d1-accent, var(--theme--primary)); background: color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 12%, transparent); }
.badge.danger { color: color-mix(in srgb, var(--theme--danger) 60%, var(--theme--foreground)); background: color-mix(in srgb, var(--theme--danger) 14%, transparent); }
.badge.warn { color: color-mix(in srgb, var(--theme--warning) 50%, var(--theme--foreground)); background: color-mix(in srgb, var(--theme--warning) 18%, transparent); }
.actions { display: flex; flex-wrap: wrap; gap: 6px; }
</style>
