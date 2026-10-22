<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { FoundFile } from './inboxApi';
import { nameOf } from './inboxModel';
import { canCommonScale, commonScaleWidths } from './commonScale';
import type { CompareMeasure, PartnerState } from './comparePartner';
import type { MeasureShape, MeasureTool, Pt } from './measure';
import ViewPane from './ViewPane.vue';
import type { PictureState } from './usePicture';
import type { ZoomMode } from './viewBoxModel';

// The Compare stage (spec 2026-10-20-inbox-file-viewer-design.md decision 5): two panes side by side, each with its label (A the open file, B the partner), its
// scale bar and, when Measure is on, the shape. A partner the person may not see is the lock card and nothing else: no picture, no name. Fit / 1:1 is the rail's
// for both panes, and with "Link zoom and pan" a scroll in one pane moves the other. Common scale: both pictures at the same micrometres per screen pixel (when
// both files say their scale), so a feature is the same size in both. The one measure shape is drawn only in the pane it was drawn in.
const props = defineProps<{
	file: FoundFile;
	partner: PartnerState;
	zoom: ZoomMode;
	scaleBar: boolean;
	contrast: boolean;
	linkZoom: boolean;
	commonScale: boolean;
	measureOn: boolean;
	tool: MeasureTool;
	measure: CompareMeasure | null;
}>();
const emit = defineEmits<{
	(e: 'state', s: PictureState): void;
	(e: 'measure', m: CompareMeasure | null): void;
}>();

const partnerFile = computed(() => (props.partner.state === 'ready' ? props.partner.file : null));

// ---- one scale ----
const common = computed(() => props.commonScale && !!partnerFile.value && canCommonScale(props.file.extracted, partnerFile.value.extracted));
const colA = ref<HTMLElement | null>(null);
const paneW = ref(0);
let watcher: ResizeObserver | null = null;
const readWidth = () => (paneW.value = colA.value?.clientWidth ?? 0);
onMounted(() => {
	readWidth();
	if (typeof ResizeObserver === 'function' && colA.value) {
		watcher = new ResizeObserver(readWidth);
		watcher.observe(colA.value);
	}
});
onBeforeUnmount(() => watcher?.disconnect());
const widths = computed(() => (common.value && partnerFile.value ? commonScaleWidths(props.file.extracted, partnerFile.value.extracted, props.zoom, paneW.value) : null));

// ---- pan: a scroll in one pane moves the other when linked ----
const paneA = ref<InstanceType<typeof ViewPane> | null>(null);
const paneB = ref<InstanceType<typeof ViewPane> | null>(null);
const follow = (from: 'a' | 'b', at: Pt) => {
	if (props.linkZoom) (from === 'a' ? paneB : paneA).value?.setScroll(at);
};

// a polygon half-drawn in one pane is dropped when the other pane is pressed (one shape at a time)
const otherPress = (from: 'a' | 'b') => (from === 'a' ? paneB : paneA).value?.cancelDraft();

// ---- measure: the shape belongs to the pane it was drawn in ----
const shapeFor = (side: 'a' | 'b') => (props.measure?.side === side ? props.measure.shape : null);
const onMeasure = (side: 'a' | 'b', shape: MeasureShape | null) => emit('measure', shape ? { shape, side } : null);
</script>

<template>
	<div class="cmp" data-test="compare-stage" :data-common-scale="common ? 'true' : 'false'" :data-linked="linkZoom ? 'true' : 'false'">
		<section ref="colA" class="col" data-test="compare-a" aria-label="File A">
			<header class="plabel">
				<span class="chip">A</span>
				<span class="pname" :title="file.rel_path" data-test="a-name">{{ nameOf(file.rel_path) }}</span>
			</header>
			<div class="stagebox">
				<ViewPane
					ref="paneA"
					:file="file"
					:zoom="zoom"
					:scale-bar="scaleBar"
					:contrast="contrast"
					:forced-width="widths?.widthA ?? null"
					:measure-on="measureOn"
					:tool="tool"
					:shape="shapeFor('a')"
					side="a"
					@state="emit('state', $event)"
					@measure="onMeasure('a', $event)"
					@press="otherPress('a')"
					@scroll="follow('a', $event)"
				/>
			</div>
		</section>

		<section class="col" data-test="compare-b" aria-label="File B">
			<header class="plabel">
				<span class="chip">B</span>
				<span v-if="partnerFile" class="pname" :title="partnerFile.rel_path" data-test="b-name">{{ nameOf(partnerFile.rel_path) }}</span>
				<span v-else-if="partner.state === 'locked'" class="pname dim">Locked</span>
				<span v-else class="pname dim">No second file yet</span>
			</header>
			<div class="stagebox">
				<ViewPane
					v-if="partnerFile"
					ref="paneB"
					:key="partnerFile.candidate_id"
					:file="partnerFile"
					:zoom="zoom"
					:scale-bar="scaleBar"
					:contrast="contrast"
					:forced-width="widths?.widthB ?? null"
					:measure-on="measureOn"
					:tool="tool"
					:shape="shapeFor('b')"
					side="b"
					@measure="onMeasure('b', $event)"
					@press="otherPress('b')"
					@scroll="follow('b', $event)"
				/>
				<div v-else-if="partner.state === 'locked'" class="blank locked" data-test="compare-locked">
					<v-icon name="lock" />
					<span>A file from another person's folder</span>
				</div>
				<div v-else-if="partner.state === 'loading'" class="blank" aria-busy="true" data-test="compare-loading"><span class="shimmer" aria-hidden="true" /></div>
				<div v-else class="blank" data-test="compare-empty">
					<v-icon name="compare" />
					<strong>Pick a second file</strong>
					<span>Choose one in the Compare section of the rail, or tick two files in the list.</span>
				</div>
			</div>
		</section>
	</div>
</template>

<style scoped src="./inboxShared.css"></style>
<style scoped>
.cmp { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1px; background: var(--d1-line); }
.col { display: flex; flex-direction: column; min-width: 0; background: var(--d1-tile, var(--theme--background-subdued)); }
.plabel { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 4px 8px; background: var(--d1-surface, var(--theme--background)); border-bottom: 1px solid var(--d1-line); }
.chip { flex: none; display: grid; place-items: center; min-width: 20px; height: 20px; padding: 0 4px; border-radius: 99px; font-size: var(--fs-xs, 11px); font-weight: 700; color: var(--d1-accent, var(--theme--primary)); background: var(--d1-tint); }
.pname { flex: 1 1 auto; min-width: 0; font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: var(--fs-sm, 12px); font-weight: 650; overflow-wrap: anywhere; }
.pname.dim { font-family: inherit; font-weight: 400; color: var(--d1-dim); }
.stagebox { min-width: 0; }
.blank.locked { font-style: italic; }
</style>
