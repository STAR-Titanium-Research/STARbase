<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useExplorerHost } from '@d1/ui';
import type { FoundFile } from './inboxApi';
import { IMAGE_KINDS, hasThumbnail, kindIcon, nameOf } from './inboxModel';
import { formatLength, lineUm, measureScale, type MeasureLine, type Pt } from './measure';
import { CONTRAST_FILTER, actualWidthPx, boxScaleBar, type ZoomMode } from './viewBoxModel';
import { usePicture, type PictureState } from './usePicture';

// One picture of the view box (spec 2026-10-20-inbox-file-viewer-design.md decisions 1, 4, 6 and 8): the stored preview (about 1600 px; the original stays on the
// share), drawn to Fit its stage or at 1:1 of the original's pixels (or at a width the Compare stage asks for, so both panes share one scale), with a scale bar when
// the file says its pixel size, an optional contrast stretch, and, when Measure is on, a layer to drag a line on. A file with no picture says "No preview yet"; a
// picture that fails says so and offers Retry. The single stage (ViewBox) shows one of these and the Compare stage two; this only reports what was asked.
const props = withDefaults(
	defineProps<{
		file: FoundFile;
		zoom: ZoomMode;
		scaleBar: boolean;
		contrast: boolean;
		/** Draw the picture this wide (screen pixels), whatever the zoom: Compare's common scale. */
		forcedWidth?: number | null;
		/** Measure is on: a drag on the picture draws the line (only when the file says its scale). */
		measureOn?: boolean;
		/** The line to draw on this picture, with its length. */
		line?: MeasureLine | null;
		/** A length measured in the other pane, shown here as a label only (Common scale makes it the same size here). */
		echo?: number | null;
		/** The prefix of this pane's data-test names: "box" for the single stage, "a" / "b" in Compare. */
		side?: string;
	}>(),
	{ forcedWidth: null, measureOn: false, line: null, echo: null, side: 'box' },
);
const emit = defineEmits<{
	/** The preview's state, so the page's View rail knows whether there is a picture to adjust. */
	(e: 'state', s: PictureState): void;
	/** The line was dragged (or cleared, with null). */
	(e: 'measure', line: MeasureLine | null): void;
	/** The pane was scrolled: where it is, as fractions (0 to 1) of what can scroll (so a linked pane can follow). */
	(e: 'scroll', at: Pt): void;
}>();

const host = useExplorerHost();
const withPicture = computed(() => hasThumbnail(props.file));
const { state, url, retry } = usePicture(host.api, () => (withPicture.value ? props.file.candidate_id : null), 'preview', () => true, { priority: true });
watch(state, (s) => emit('state', s), { immediate: true });

const name = computed(() => nameOf(props.file.rel_path));
const icon = computed(() => kindIcon(props.file.kind));
const noPictureText = computed(() => (IMAGE_KINDS.includes(props.file.kind) ? 'The preview is not made yet.' : 'This kind of file has no preview.'));

// The preview's own size, known once it is in: 1:1 needs the width when the file does not say how wide the original is, and Measure needs both.
const img = ref<HTMLImageElement | null>(null);
const previewW = ref<number | null>(null);
watch(() => props.file.candidate_id, () => (previewW.value = null));
const drawnW = computed(() => props.forcedWidth ?? (props.zoom === 'actual' ? actualWidthPx(props.file.extracted, previewW.value) : null));
const bar = computed(() => (props.scaleBar ? boxScaleBar(props.file.extracted, props.zoom, drawnW.value) : null));
const imgStyle = computed(() => ({
	...(drawnW.value ? { width: `${drawnW.value}px` } : {}),
	...(props.contrast ? { filter: CONTRAST_FILTER } : {}),
}));
const sized = computed(() => props.forcedWidth !== null || props.zoom === 'actual');

// ---- Measure: drag a line; its ends are fractions of the picture, its length is worked out on the preview's natural size ----
const scale = computed(() => measureScale(props.file.extracted));
const interactive = computed(() => props.measureOn && !!scale.value && state.value === 'ready');
let drag: { pointer: number; a: Pt } | null = null;
const clamp = (v: number) => Math.min(1, Math.max(0, v));
function fraction(e: PointerEvent): Pt | null {
	const r = img.value?.getBoundingClientRect();
	if (!r || !r.width || !r.height) return null;
	return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
}
function make(a: Pt, b: Pt): MeasureLine {
	const el = img.value;
	return { a, b, um: lineUm(a, b, { width: el?.naturalWidth ?? 0, height: el?.naturalHeight ?? 0 }, scale.value) ?? 0 };
}
function down(e: PointerEvent): void {
	if (!interactive.value || (e.button ?? 0) > 0) return;
	const p = fraction(e);
	if (!p) return;
	drag = { pointer: e.pointerId, a: p };
	(e.currentTarget as Element | null)?.setPointerCapture?.(e.pointerId);
	e.preventDefault();
	emit('measure', make(p, p));
}
function move(e: PointerEvent): void {
	if (!drag || e.pointerId !== drag.pointer) return;
	const p = fraction(e);
	if (p) emit('measure', make(drag.a, p));
}
function up(e: PointerEvent): void {
	if (!drag || e.pointerId !== drag.pointer) return;
	const a = drag.a;
	drag = null;
	const p = fraction(e) ?? a;
	const r = img.value?.getBoundingClientRect();
	// a click that did not move is not a line
	if (r && Math.hypot((p.x - a.x) * r.width, (p.y - a.y) * r.height) < 3) emit('measure', null);
	else emit('measure', make(a, p));
}
const stop = () => (drag = null);
const mid = computed(() => (props.line ? { x: (props.line.a.x + props.line.b.x) / 2, y: (props.line.a.y + props.line.b.y) / 2 } : null));
const pct = (v: number) => `${v * 100}%`;

// ---- pan: reported as fractions so a linked pane can follow; a scroll this pane was told to make is not reported back ----
const scroller = ref<HTMLElement | null>(null);
let expected: Pt | null = null;
const room = (el: HTMLElement) => ({ x: el.scrollWidth - el.clientWidth, y: el.scrollHeight - el.clientHeight });
function onScroll(): void {
	const el = scroller.value;
	if (!el) return;
	const { x: mx, y: my } = room(el);
	if (expected && Math.abs(el.scrollLeft - expected.x) < 1 && Math.abs(el.scrollTop - expected.y) < 1) {
		expected = null;
		return;
	}
	expected = null;
	emit('scroll', { x: mx > 0 ? el.scrollLeft / mx : 0, y: my > 0 ? el.scrollTop / my : 0 });
}
function setScroll(at: Pt): void {
	const el = scroller.value;
	if (!el) return;
	const { x: mx, y: my } = room(el);
	const want = { x: Math.max(0, mx) * at.x, y: Math.max(0, my) * at.y };
	if (Math.abs(el.scrollLeft - want.x) < 1 && Math.abs(el.scrollTop - want.y) < 1) return;
	expected = want;
	el.scrollLeft = want.x;
	el.scrollTop = want.y;
}
defineExpose({ setScroll });
</script>

<template>
	<div class="pane" :data-state="state" :data-zoom="zoom" :data-test="`${side}-pane`">
		<template v-if="withPicture">
			<div v-if="state === 'ready' && url" ref="scroller" class="scroll" :data-test="`${side}-scroll`" @scroll.passive="onScroll">
				<div class="pic" :class="{ sized }">
					<img ref="img" :src="url" :alt="`Preview of ${name}`" :style="imgStyle" draggable="false" :data-test="`${side}-image`" @load="previewW = ($event.target as HTMLImageElement).naturalWidth || null" />
					<div v-if="bar" class="bar" :style="{ width: `${bar.fraction * 100}%` }" :data-test="`${side}-scalebar`">
						<span class="rule" aria-hidden="true" />
						<span class="len">{{ bar.label }}</span>
					</div>
					<svg v-if="line && line.um > 0" class="line" aria-hidden="true" :data-test="`${side}-line`">
						<line :x1="pct(line.a.x)" :y1="pct(line.a.y)" :x2="pct(line.b.x)" :y2="pct(line.b.y)" />
					</svg>
					<span v-if="line && line.um > 0 && mid" class="pill" :style="{ left: pct(mid.x), top: pct(mid.y) }" :data-test="`${side}-measure`">{{ formatLength(line.um) }}</span>
					<span v-else-if="echo !== null && echo > 0" class="pill echo" :data-test="`${side}-echo`">{{ formatLength(echo) }}</span>
					<div
						v-if="measureOn"
						class="layer"
						:class="{ on: interactive }"
						:data-test="`${side}-layer`"
						@pointerdown="down"
						@pointermove="move"
						@pointerup="up"
						@pointercancel="stop"
					/>
				</div>
			</div>
			<div v-else-if="state === 'failed'" class="blank err" role="alert" :data-test="`${side}-error`">
				<span>The preview could not be loaded.</span>
				<v-button small secondary :data-test="`${side}-retry`" @click="retry()">Retry</v-button>
			</div>
			<div v-else class="blank" aria-busy="true" :data-test="`${side}-loading`"><span class="shimmer" aria-hidden="true" /></div>
		</template>
		<div v-else class="blank" :data-test="`${side}-nopicture`">
			<v-icon :name="icon" />
			<strong>No preview yet</strong>
			<span>{{ noPictureText }}</span>
		</div>
	</div>
</template>

<style scoped src="./inboxShared.css"></style>
<style scoped>
.pane { min-width: 0; }
.scroll { display: flex; height: min(72dvh, 820px); min-height: 320px; overflow: auto; }
.pic { position: relative; margin: auto; flex: none; max-width: 100%; }
.pic img { display: block; max-width: 100%; max-height: min(72dvh, 820px); width: auto; height: auto; user-select: none; }
.pic.sized { max-width: none; }
.pic.sized img { max-width: none; max-height: none; }
.bar { position: absolute; left: 8px; bottom: 8px; display: flex; flex-direction: column; gap: 2px; box-sizing: border-box; padding: 3px 6px 2px; border-radius: 8px; background: color-mix(in srgb, var(--theme--background) 80%, transparent); pointer-events: none; }
.bar .rule { display: block; height: 4px; border: 2px solid var(--theme--foreground); border-top: 0; }
.bar .len { font-size: var(--fs-xs, 11px); font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.2; white-space: nowrap; }
/* The measure line: dashed, in the accent colour, over the picture; the layer under the pointer exists only while Measure is on. */
.line { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.line line { stroke: var(--d1-accent, var(--theme--primary)); stroke-width: 2; stroke-dasharray: 6 4; vector-effect: non-scaling-stroke; }
.pill {
	position: absolute; transform: translate(-50%, -140%); padding: 1px 8px; border-radius: 99px; pointer-events: none; white-space: nowrap;
	font-size: var(--fs-xs, 11px); font-weight: 650; line-height: 1.6; font-variant-numeric: tabular-nums;
	color: var(--theme--foreground); background: color-mix(in srgb, var(--theme--background) 85%, transparent); border: 1px solid var(--d1-accent, var(--theme--primary));
}
.pill.echo { left: 8px; top: 8px; transform: none; border-style: dashed; }
.layer { position: absolute; inset: 0; touch-action: none; pointer-events: none; }
.layer.on { pointer-events: auto; cursor: crosshair; }
.blank { min-height: 320px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 16px; font-size: var(--fs-sm, 12px); color: var(--d1-dim); text-align: center; }
.blank strong { font-size: var(--fs-md, 13px); color: var(--theme--foreground); }
.blank.err { color: var(--theme--foreground); }
.blank .shimmer { height: 320px; }
</style>
