<script setup lang="ts">
import AddMenu from './AddMenu.vue';
import ConnectTo from './ConnectTo.vue';
import CreateToast from './CreateToast.vue';
import DuplicatePrompt from './DuplicatePrompt.vue';
import MarkDoneDialog from './MarkDoneDialog.vue';
import SamplePicker from './SamplePicker.vue';
import type { EditMode } from './useEditMode';
import type { EditSide } from './useEditSide';

// What edit mode opens over the page: the Add menu, Connect to…, the duplicate prompt, the sample picker, the Mark done dialog and
// the toast after Create. They sit beside the page layout, not in it: RecordLayout is a size container, which would make `position:
// fixed` relative to it. Mark done and the toast belong to view mode and phones too; the others only while a draft can be changed.
defineProps<{ edit: EditMode; side: EditSide }>();
</script>

<template>
	<template v-if="edit.editing.value">
		<ConnectTo v-if="side.build.connecting.value" :entries="side.build.connectEntries.value" :from="side.build.connectFrom.value" :at="side.build.connecting.value.at" @choose="side.build.connectTo" @close="side.build.connecting.value = null" />
		<DuplicatePrompt v-if="side.build.duplicating.value" :what="side.build.duplicating.value.what" @confirm="side.build.confirmDuplicate" @close="side.build.duplicating.value = null" />
		<SamplePicker v-if="side.build.pickerOpen.value" :taken="side.build.picking.taken.value" @pick="side.build.picking.picked" @close="side.build.pickerOpen.value = false" />
		<AddMenu
			v-if="side.build.menu.target.value"
			:target="side.build.menu.target.value"
			:body="edit.body.value"
			:methods="edit.catalog.methods.value"
			:test-types="edit.catalog.testTypes.value"
			:search="edit.catalog.searchSamples"
			:code-of="(id: string) => edit.catalog.samples.get(id)?.code"
			@choose="side.build.menu.choose"
			@close="side.build.menu.close"
		/>
	</template>
	<MarkDoneDialog
		:open="side.markDone.open.value"
		:collection="side.markDone.target.value?.collection ?? 'manufacturing_operations'"
		:ids="side.markDone.target.value?.ids ?? []"
		:title="side.markDone.target.value?.title ?? 'Mark done'"
		:checks="side.markDone.checks.value"
		:busy="side.markDone.busy.value"
		@confirm="side.markDone.confirm"
		@cancel="side.markDone.cancel"
	/>
	<div class="pm-toast d1-kit d1-process-map">
		<CreateToast :show="!!side.create.toast.value" :sample-ids="side.create.toast.value?.sampleIds ?? []" :count="side.create.toast.value?.count ?? 0" @close="side.create.closeToast" />
	</div>
</template>

<style scoped>
.pm-toast { position: fixed; left: 16px; bottom: 16px; z-index: 70; }
</style>
