<script setup lang="ts">
import CreateBar from './edit/CreateBar.vue';
import EditLid from './edit/EditLid.vue';
import { isNotice, type EditMode } from './edit/useEditMode';
import type { EditSide } from './edit/useEditSide';
import type { useMapCanvas } from './useMapCanvas';
import type { useMapExport } from './useMapExport';
import type { useProcessMap } from './useProcessMap';

// Everything that sits between the map panel's head and the canvas: the edit lid (while a draft can be changed) and the banners that say
// what the map, the draft, the export and Mark done have to report. One banner per thing, each only while it has something to say.
defineProps<{
	edit: EditMode;
	side: EditSide;
	map: ReturnType<typeof useProcessMap>;
	canvas: ReturnType<typeof useMapCanvas>;
	mapExport: ReturnType<typeof useMapExport>;
}>();
</script>

<template>
	<EditLid
		v-if="edit.editing.value"
		:name="edit.draft.name.value"
		:can-undo="edit.draft.canUndo.value"
		:can-redo="edit.draft.canRedo.value"
		:drafts="edit.drafts.value"
		:current-id="edit.draft.draftId.value"
		:saving="edit.draft.saving.value"
		:save-error="edit.draft.saveError.value"
		:notice="edit.draft.notice.value"
		:can-remove="side.build.canRemove.value"
		:can-dissolve="side.build.canDissolve.value"
		@undo="side.build.undo()"
		@redo="side.build.redo()"
		@rename="edit.draft.rename"
		@add="side.build.addUnconnected"
		@pick="side.build.pickerOpen.value = true"
		@remove="side.build.removeSelected()"
		@dissolve="side.build.dissolveSelected()"
		@open="edit.openDraft"
		@dismiss-notice="edit.draft.notice.value = ''"
	>
		<template #create>
			<CreateBar :summary="edit.summary.value" :missing="edit.missing.value" :creating="side.create.creating.value" :error="side.create.error.value" :empty="side.create.empty.value" @create="side.create.create" />
		</template>
	</EditLid>
	<div v-else-if="edit.drafted.value" class="pm-banner" role="status">This draft is open to look at only: building needs a screen at least 768 px wide.</div>
	<div v-if="edit.failed.value" class="pm-banner" :class="{ 'pm-bad': !isNotice(edit.failed.value) }" :role="isNotice(edit.failed.value) ? 'status' : 'alert'">{{ edit.failed.value }}</div>
	<div v-if="side.markDone.error.value" class="pm-banner pm-bad pm-dismissable" role="alert">
		<span>{{ side.markDone.error.value }}</span>
		<button type="button" class="pm-dismiss" aria-label="Dismiss" @click="side.markDone.error.value = ''"><v-icon name="close" x-small /></button>
	</div>
	<div v-if="side.build.problem.value || side.build.picking.problem.value" class="pm-banner pm-bad pm-dismissable" role="alert">
		<span>{{ side.build.problem.value || side.build.picking.problem.value }}</span>
		<button type="button" class="pm-dismiss" aria-label="Dismiss" @click="side.build.problem.value = ''; side.build.picking.problem.value = ''"><v-icon name="close" x-small /></button>
	</div>
	<div v-if="map.notice.value" class="pm-banner pm-bad" role="alert">{{ map.notice.value }}</div>
	<div v-else-if="map.expanding.value" class="pm-banner" role="status">Loading more of the Process map…</div>
	<div v-if="map.partial.value" class="pm-banner" role="status">Showing part of this history. The map shows the nearest steps; the rest is cut at the limits.</div>
	<div v-if="canvas.layoutError.value" class="pm-banner pm-bad" role="alert">{{ canvas.layoutError.value }}</div>
	<div v-if="mapExport.error.value" class="pm-banner pm-bad pm-dismissable" role="alert">
		<span>{{ mapExport.error.value }}</span>
		<button type="button" class="pm-dismiss" aria-label="Dismiss" @click="mapExport.dismissError()"><v-icon name="close" x-small /></button>
	</div>
	<div v-else-if="mapExport.notice.value" class="pm-banner" role="status">{{ mapExport.notice.value }}</div>
</template>

<style scoped>
.pm-banner {
	padding: 7px 14px;
	font-size: var(--fs-sm, 12px);
	color: var(--d1-dim, var(--theme--foreground-subdued));
	background: var(--d1-tile, var(--theme--background-subdued));
	border-bottom: 1px solid var(--d1-line, var(--theme--border-color-subdued));
}
.pm-bad { color: var(--d1-bad, var(--theme--danger)); }
.pm-dismissable { display: flex; align-items: center; gap: 8px; }
.pm-dismissable span { flex: 1; }
.pm-dismiss { display: inline-flex; padding: 2px; border: 0; border-radius: 4px; background: none; color: inherit; cursor: pointer; }
.pm-dismiss:hover, .pm-dismiss:focus-visible { background: var(--d1-tile, var(--theme--background-subdued)); outline: none; }
</style>
