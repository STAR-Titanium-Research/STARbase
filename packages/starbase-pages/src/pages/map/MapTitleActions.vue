<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import ExportMenu from './ExportMenu.vue';
import type { EditMode } from './edit/useEditMode';
import type { useMapExport } from './useMapExport';

// The buttons in the page title: Done editing (while a draft can be changed) or Edit (when it could be), Copy link, and Export ▾.
defineProps<{
	edit: EditMode;
	mapExport: ReturnType<typeof useMapExport>;
	/** The map is drawn and there is something to export. */
	canExport: boolean;
}>();

const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
async function copyLink() {
	try {
		await navigator.clipboard.writeText(window.location.href);
		copied.value = true;
		if (copiedTimer) clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => (copied.value = false), 2000);
	} catch {
		/* no clipboard (an insecure origin or a refused permission): the address bar has the link */
	}
}
onBeforeUnmount(() => {
	if (copiedTimer) clearTimeout(copiedTimer);
});
</script>

<template>
	<v-button v-if="edit.editing.value" small @click="edit.done()"><v-icon name="check" small /> Done editing</v-button>
	<v-button v-else-if="edit.canBuild.value && !edit.param.value" small secondary @click="edit.startEditing()"><v-icon name="edit" small /> Edit</v-button>
	<v-button small secondary @click="copyLink"><v-icon name="link" small /> {{ copied ? 'Copied' : 'Copy link' }}</v-button>
	<ExportMenu :busy="mapExport.exporting.value" :disabled="!canExport || mapExport.exporting.value" @pick="mapExport.exportAs" />
</template>
