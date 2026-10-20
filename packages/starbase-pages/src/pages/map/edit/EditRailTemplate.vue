<script setup lang="ts">
import { Section } from '@d1/ui';
import { useEditRail } from './railContext';
import { useEditModeInjected } from './useEditMode';

// The rail's "Save as template" (redesign R7): a button for the selected operation or test, new or recorded, while a draft can be changed. The
// card's right-click menu has the same entry. What it keeps and who may use it are asked in the dialog it opens.
const edit = useEditModeInjected();
const rail = useEditRail();
</script>

<template>
	<Section v-if="edit?.editing.value && rail?.saveTemplate?.can.value" title="Template" class="pm-tplrail">
		<p class="hint">Keep this card's method, machine, tool, operator and settings to start the next one from.</p>
		<v-button small secondary class="save" @click="rail.saveTemplate?.open()"><v-icon name="bookmark_add" small left />Save as template…</v-button>
	</Section>
</template>

<style scoped>
.hint { margin: 0 0 8px; color: var(--d1-dim); font-size: var(--fs-sm, 12px); line-height: 1.4; }
</style>
