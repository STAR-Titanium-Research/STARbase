<script setup lang="ts">
import { SegmentedControl } from '@d1/ui';
import ComparePicker from './ComparePicker.vue';
import { COMMON_SCALE_REASON } from './commonScale';
import type { FoundFile } from './inboxApi';
import { MEASURE_TOOLS, NO_SCALE_REASON, type MeasureTool } from './measure';
import type { CompareMode } from './useViewSettings';
import type { ZoomMode } from './viewBoxModel';

// The view box's View rail (DESIGN.md sections 4 and 5, "Proposed"): the hanging card on the right of the stage. View: Fit or 1:1. Overlay: Scale bar, Measure
// (key M; a line, a circle or a polygon, keys 1 2 3) and Contrast stretch. Compare (key C): Off or Side by side, the second-file picker, "Link zoom and pan" and "Common scale". It shows only what works
// for this file: with no picture there is nothing to adjust, the Scale bar switch is offered only when the file says its scale, and Measure is there but disabled,
// with the reason, when it does not. The choices are kept per person by the page (useViewSettings); the shape and the partner are the page's.
defineProps<{
	zoom: ZoomMode;
	scaleBar: boolean;
	contrast: boolean;
	/** The preview is in: Fit / 1:1 and Contrast stretch have something to act on. */
	hasPicture: boolean;
	/** The file says its pixel size and its width (the same two numbers Measure needs), so a scale bar can be drawn. */
	hasScale: boolean;
	open: boolean;
	/** Measure is on, and whether it can work here (the file says its pixel size and its width), what it draws, and whether a shape is drawn. */
	measure: boolean;
	canMeasure: boolean;
	tool: MeasureTool;
	hasShape: boolean;
	compare: CompareMode;
	linkZoom: boolean;
	commonScale: boolean;
	/** Both files say their scale, so Common scale can work. */
	canCommon: boolean;
	/** Compare's picker: the files in the list (without the open one), the open file's folder, the partner and whether it is locked. */
	candidates: FoundFile[];
	folder: string;
	partner: FoundFile | null;
	partnerLocked: boolean;
	more: boolean;
	moreBusy: boolean;
}>();
const emit = defineEmits<{
	(e: 'update:zoom', v: ZoomMode): void;
	(e: 'update:scaleBar', v: boolean): void;
	(e: 'update:contrast', v: boolean): void;
	(e: 'update:open', v: boolean): void;
	(e: 'update:measure', v: boolean): void;
	(e: 'update:compare', v: CompareMode): void;
	(e: 'update:linkZoom', v: boolean): void;
	(e: 'update:commonScale', v: boolean): void;
	(e: 'update:tool', v: MeasureTool): void;
	(e: 'clear-shape'): void;
	(e: 'pick', candidateId: string): void;
	(e: 'clear-partner'): void;
	(e: 'more'): void;
}>();

const ZOOM_OPTIONS: ReadonlyArray<{ value: ZoomMode; label: string }> = [
	{ value: 'fit', label: 'Fit' },
	{ value: 'actual', label: '1:1' },
];
const TOOL_OPTIONS: ReadonlyArray<{ value: MeasureTool; label: string }> = MEASURE_TOOLS.map((value) => ({ value, label: value === 'line' ? 'Line' : value === 'circle' ? 'Circle' : 'Polygon' }));
const TOOL_HINT: Record<MeasureTool, string> = {
	line: 'Drag a line',
	circle: 'Drag from the centre to the edge',
	polygon: 'Click the corners, click the first to close',
};
const COMPARE_OPTIONS: ReadonlyArray<{ value: CompareMode; label: string }> = [
	{ value: 'off', label: 'Off' },
	{ value: 'side', label: 'Side by side' },
];
const checked = (e: Event) => (e.target as HTMLInputElement).checked;
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
					<label v-if="hasScale" class="check"><input type="checkbox" :checked="scaleBar" data-test="toggle-scalebar" @change="emit('update:scaleBar', checked($event))" /><span>Scale bar</span></label>
					<label class="check" :class="{ off: !canMeasure }" :title="canMeasure ? 'Measure a line, a circle or a polygon on the picture (M)' : NO_SCALE_REASON">
						<input type="checkbox" :checked="measure && canMeasure" :disabled="!canMeasure" :aria-describedby="canMeasure ? undefined : 'measure-why'" data-test="toggle-measure" @change="emit('update:measure', checked($event))" />
						<span>Measure</span>
					</label>
					<p v-if="!canMeasure" id="measure-why" class="hint" data-test="measure-why">{{ NO_SCALE_REASON }}</p>
					<template v-else-if="measure">
						<div class="tool" data-test="rail-tool">
							<SegmentedControl :model-value="tool" :options="TOOL_OPTIONS" label="What Measure draws" @update:model-value="emit('update:tool', $event)" />
						</div>
						<p class="hint" data-test="tool-hint">{{ TOOL_HINT[tool] }}</p>
						<p class="hint">One shape at a time. Keys 1 2 3 pick the tool; Esc cancels.</p>
					</template>
					<button v-if="hasShape" type="button" class="lf-link" data-test="clear-line" @click="emit('clear-shape')">Clear</button>
					<label class="check"><input type="checkbox" :checked="contrast" data-test="toggle-contrast" @change="emit('update:contrast', checked($event))" /><span>Contrast stretch</span></label>
					<p class="hint">Contrast stretch only changes how the picture is drawn here.</p>
				</section>
			</template>
			<p v-else class="hint" data-test="rail-nothing">There is no preview to adjust yet.</p>

			<section class="sec" data-test="rail-compare">
				<h3 class="lab">Compare</h3>
				<SegmentedControl :model-value="compare" :options="COMPARE_OPTIONS" label="Show one file or two side by side" @update:model-value="emit('update:compare', $event)" />
				<template v-if="compare === 'side'">
					<ComparePicker :candidates="candidates" :folder="folder" :selected="partner" :locked="partnerLocked" :more="more" :more-busy="moreBusy" @pick="emit('pick', $event)" @clear="emit('clear-partner')" />
					<label class="check"><input type="checkbox" :checked="linkZoom" data-test="toggle-link" @change="emit('update:linkZoom', checked($event))" /><span>Link zoom and pan</span></label>
					<label class="check" :class="{ off: !canCommon }" :title="canCommon ? 'Both pictures at the same µm per screen pixel' : COMMON_SCALE_REASON">
						<input type="checkbox" :checked="commonScale && canCommon" :disabled="!canCommon" :aria-describedby="canCommon ? undefined : 'common-why'" data-test="toggle-common" @change="emit('update:commonScale', checked($event))" />
						<span>Common scale</span>
					</label>
					<p v-if="!canCommon" id="common-why" class="hint" data-test="common-why">{{ partner || partnerLocked ? `Not available: ${COMMON_SCALE_REASON}.` : 'Pick a second file to share a scale.' }}</p>
				</template>
				<p v-else class="hint">Put a second file beside this one. Press C.</p>
			</section>
		</div>
	</aside>
	<button v-else type="button" class="tab" aria-expanded="false" data-test="rail-expand" @click="emit('update:open', true)">
		<v-icon name="tune" small /><span>View · {{ compare === 'side' ? 'Compare' : hasPicture ? (zoom === 'fit' ? 'Fit' : '1:1') : 'Off' }}</span>
	</button>
</template>

<style scoped src="./inboxShared.css"></style>
<style scoped src="./viewRail.css"></style>
<style scoped>
.sec { align-self: stretch; }
</style>
