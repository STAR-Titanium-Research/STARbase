<script setup lang="ts">
import { SegmentedControl } from '@d1/ui';
import type { PreviewMode } from './useViewSettings';

// The Inbox's View rail (DESIGN.md sections 4 and 5, "Proposed"): the hanging card on the right that holds how the page is shown, remembered per person and
// per device. It shows only what does something here: Preview (what a click on a file opens) and Compare (tick two pictures in the list, then open them side by
// side). Layout, Density and Group by join it when the table and the grouping exist. It follows the proposed kit ViewRail and is a page-local component until
// that is promoted to @d1/ui.
defineProps<{
	preview: PreviewMode;
	/** "Compare two files" is on: the pictures in the list can be ticked. */
	compare: boolean;
	open: boolean;
}>();
const emit = defineEmits<{
	(e: 'update:preview', v: PreviewMode): void;
	(e: 'update:compare', v: boolean): void;
	(e: 'update:open', v: boolean): void;
}>();

const PREVIEW_OPTIONS: ReadonlyArray<{ value: PreviewMode; label: string }> = [
	{ value: 'sheet', label: 'Sheet' },
	{ value: 'box', label: 'View box' },
];
const summaryOf = (p: PreviewMode, compare: boolean) => `${p === 'sheet' ? 'Sheet' : 'View box'}${compare ? ' · Compare' : ''}`;
</script>

<template>
	<aside v-if="open" class="rail" aria-label="View" data-test="view-rail">
		<header class="lid">
			<v-icon name="tune" small />
			<h2 class="ttl">View</h2>
			<button type="button" class="icon-btn" aria-label="Collapse the View rail" aria-expanded="true" data-test="rail-collapse" @click="emit('update:open', false)"><v-icon name="chevron_right" small /></button>
		</header>
		<div class="body">
			<section class="sec" data-test="rail-preview">
				<h3 class="lab">Preview</h3>
				<SegmentedControl :model-value="preview" :options="PREVIEW_OPTIONS" label="What a click on a file opens" @update:model-value="emit('update:preview', $event)" />
				<p class="hint">{{ preview === 'sheet' ? 'A click opens a sheet beside the list.' : 'A click opens the file on its own page.' }}</p>
			</section>
			<section class="sec" data-test="rail-compare">
				<h3 class="lab">Compare</h3>
				<label class="check"><input type="checkbox" :checked="compare" data-test="toggle-compare" @change="emit('update:compare', ($event.target as HTMLInputElement).checked)" /><span>Compare two files</span></label>
				<p class="hint">{{ compare ? 'Tick two pictures in the list, then open them side by side.' : 'Tick two pictures to see them side by side.' }}</p>
			</section>
		</div>
	</aside>
	<button v-else type="button" class="tab" aria-expanded="false" data-test="rail-expand" @click="emit('update:open', true)">
		<v-icon name="tune" small /><span>View · {{ summaryOf(preview, compare) }}</span>
	</button>
</template>

<style scoped src="./inboxShared.css"></style>
<style scoped src="./viewRail.css"></style>
<style scoped>
.check { display: flex; align-items: center; gap: 8px; min-height: 28px; font-size: var(--fs-md, 13px); cursor: pointer; }
.check input { margin: 0; width: 16px; height: 16px; accent-color: var(--d1-accent, var(--theme--primary)); }
.check input:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
/* Narrow pages: the rail is a full-width card above the list, the tab a full-width row. */
@container inbox-frame (max-width: 1100px) {
	.rail { width: 100%; position: static; order: -1; }
	.tab { width: 100%; flex-direction: row; padding: 6px 10px; position: static; order: -1; }
	.tab span { writing-mode: horizontal-tb; }
}
</style>
