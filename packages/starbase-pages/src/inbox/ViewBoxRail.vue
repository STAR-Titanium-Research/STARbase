<script setup lang="ts">
import { SegmentedControl } from '@d1/ui';
import type { ZoomMode } from './viewBoxModel';

// The view box's View rail (DESIGN.md sections 4 and 5, "Proposed"): the hanging card on the right of the stage. View: Fit or 1:1. Overlay: Scale bar and
// Contrast stretch. It shows only what works for this file: with no picture there is nothing to adjust, and the Scale bar switch is offered only when the
// file says its scale. Measure and Compare join it in the next step. The choices are kept per person by the page (useViewSettings).
defineProps<{
	zoom: ZoomMode;
	scaleBar: boolean;
	contrast: boolean;
	/** The preview is in: Fit / 1:1 and Contrast stretch have something to act on. */
	hasPicture: boolean;
	/** The file says its pixel size, so a scale bar can be drawn. */
	hasScale: boolean;
	open: boolean;
}>();
const emit = defineEmits<{
	(e: 'update:zoom', v: ZoomMode): void;
	(e: 'update:scaleBar', v: boolean): void;
	(e: 'update:contrast', v: boolean): void;
	(e: 'update:open', v: boolean): void;
}>();

const ZOOM_OPTIONS: ReadonlyArray<{ value: ZoomMode; label: string }> = [
	{ value: 'fit', label: 'Fit' },
	{ value: 'actual', label: '1:1' },
];
</script>

<template>
	<aside v-if="open" class="rail" aria-label="View" data-test="box-rail">
		<header class="lid">
			<v-icon name="tune" small />
			<h2 class="ttl">View</h2>
			<button type="button" class="icon-btn" aria-label="Collapse the View rail" aria-expanded="true" data-test="rail-collapse" @click="emit('update:open', false)"><v-icon name="chevron_right" small /></button>
		</header>
		<div class="body">
			<template v-if="hasPicture">
				<section class="sec" data-test="rail-zoom">
					<h3 class="lab">View</h3>
					<SegmentedControl :model-value="zoom" :options="ZOOM_OPTIONS" label="How big the picture is drawn" @update:model-value="emit('update:zoom', $event)" />
					<p class="hint">{{ zoom === 'fit' ? 'The whole picture in the window. Press F.' : 'One pixel of the original per screen pixel; scroll to move.' }}</p>
				</section>
				<section class="sec" data-test="rail-overlay">
					<h3 class="lab">Overlay</h3>
					<label v-if="hasScale" class="check"><input type="checkbox" :checked="scaleBar" data-test="toggle-scalebar" @change="emit('update:scaleBar', ($event.target as HTMLInputElement).checked)" /><span>Scale bar</span></label>
					<label class="check"><input type="checkbox" :checked="contrast" data-test="toggle-contrast" @change="emit('update:contrast', ($event.target as HTMLInputElement).checked)" /><span>Contrast stretch</span></label>
					<p class="hint">Contrast stretch only changes how the picture is drawn here.</p>
				</section>
			</template>
			<p v-else class="hint" data-test="rail-nothing">There is no preview to adjust yet.</p>
		</div>
	</aside>
	<button v-else type="button" class="tab" aria-expanded="false" data-test="rail-expand" @click="emit('update:open', true)">
		<v-icon name="tune" small /><span>View · {{ hasPicture ? (zoom === 'fit' ? 'Fit' : '1:1') : 'Off' }}</span>
	</button>
</template>

<style scoped src="./inboxShared.css"></style>
<style scoped src="./viewRail.css"></style>
<style scoped>
.check { display: flex; align-items: center; gap: 8px; min-height: 28px; font-size: var(--fs-md, 13px); cursor: pointer; }
.check input { margin: 0; width: 16px; height: 16px; accent-color: var(--d1-accent, var(--theme--primary)); }
.check input:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
/* Narrow pages: the rail is a full-width card under the stage, the tab a full-width row. */
@container (max-width: 760px) {
	.rail { width: 100%; position: static; }
	.tab { width: 100%; flex-direction: row; padding: 6px 10px; position: static; }
	.tab span { writing-mode: horizontal-tb; }
}
</style>
