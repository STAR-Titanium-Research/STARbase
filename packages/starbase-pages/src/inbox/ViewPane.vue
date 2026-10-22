<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useExplorerHost } from '@d1/ui';
import type { FoundFile, SavedMeasurement } from './inboxApi';
import { IMAGE_KINDS, hasThumbnail, kindIcon, nameOf } from './inboxModel';
import ScaleBar from './ScaleBar.vue';
import { measureScale, measureText, shapeUm, type MeasureShape, type MeasureTool, type Pt } from './measure';
import { orderMeasurements, savedMeasure, savedToShape, valueText, type PreviewSize } from './measurements';
import { CONTRAST_FILTER, TEXT_ENTRY, actualWidthPx, boxScaleBar, type ZoomMode } from './viewBoxModel';
import { usePicture, type PictureState } from './usePicture';

// One picture of the view box (spec 2026-10-20-inbox-file-viewer-design.md decisions 1, 4, 6 and 8): the stored preview (about 1600 px; the original stays on the
// share), drawn to Fit its stage or at 1:1 of the original's pixels (or at a width the Compare stage asks for, so both panes share one scale), with a scale bar when
// the file says its pixel size, an optional contrast stretch, and, when Measure is on, a layer to draw a line, a circle or a polygon on. A file with no picture says "No preview yet"; a
// picture that fails says so and offers Retry. The single stage (ViewBox) shows one of these and the Compare stage two; this only reports what was asked.
const props = withDefaults(
	defineProps<{
		file: FoundFile;
		zoom: ZoomMode;
		scaleBar: boolean;
		contrast: boolean;
		/** Draw the picture this wide (screen pixels), whatever the zoom: Compare's common scale. */
		forcedWidth?: number | null;
		/** Measure is on: the pointer draws the shape of `tool` on the picture (only when the file says its scale). */
		measureOn?: boolean;
		/** What Measure draws: a line, a circle or a polygon. */
		tool?: MeasureTool;
		/** The finished shape to draw on this picture (fractions of it); what it measures is worked out here. */
		shape?: MeasureShape | null;
		/** The shapes saved on this file (corners in original pixels), drawn dimmer than the live shape while Measure is on; the selected one at full strength. */
		saved?: readonly SavedMeasurement[];
		selectedId?: string | null;
		/** The prefix of this pane's data-test names: "box" for the single stage, "a" / "b" in Compare. */
		side?: string;
	}>(),
	{ forcedWidth: null, measureOn: false, tool: 'line', shape: null, saved: () => [], selectedId: null, side: 'box' },
);
const emit = defineEmits<{
	/** The preview's state, so the page's View rail knows whether there is a picture to adjust. */
	(e: 'state', s: PictureState): void;
	/** The preview's natural size once it is in (the fractions of a drawn shape are of it; saving a shape needs it), null while it is not known. */
	(e: 'size', s: PreviewSize | null): void;
	/** A shape was finished (or the drag was only a click, which draws nothing: null). */
	(e: 'measure', shape: MeasureShape | null): void;
	/** The pane was scrolled: where it is, as fractions (0 to 1) of what can scroll (so a linked pane can follow). */
	(e: 'scroll', at: Pt): void;
	/** A press started on this pane's picture while Measure was drawing here: the Compare stage drops the other pane's unfinished polygon. */
	(e: 'press'): void;
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
watch(() => props.file.candidate_id, () => {
	previewW.value = null;
	emit('size', null);
});
function onLoad(e: Event): void {
	const el = e.target as HTMLImageElement;
	previewW.value = el.naturalWidth || null;
	tick.value += 1;
}
const drawnW = computed(() => props.forcedWidth ?? (props.zoom === 'actual' ? actualWidthPx(props.file.extracted, previewW.value) : null));
const bar = computed(() => (props.scaleBar ? boxScaleBar(props.file.extracted, props.zoom, drawnW.value) : null));
const imgStyle = computed(() => ({
	...(drawnW.value ? { width: `${drawnW.value}px` } : {}),
	...(props.contrast ? { filter: CONTRAST_FILTER } : {}),
}));
const sized = computed(() => props.forcedWidth !== null || props.zoom === 'actual');

// ---- Measure: draw a line, a circle or a polygon; each is kept as fractions of the picture, and what it measures is worked out on the preview's natural size ----
// A line or a circle is dragged (down, move, up); a polygon is clicked corner by corner and closed by a click on its first corner, a double-click or Enter. What is being
// drawn (the draft) is this pane's own and is shown instead of the finished shape until it is done; Esc drops it (the finished shape comes back), Backspace takes the last
// polygon corner off, and a press that did not move is not a shape.
const scale = computed(() => measureScale(props.file.extracted));
const interactive = computed(() => props.measureOn && !!scale.value && state.value === 'ready');
const draft = ref<MeasureShape | null>(null);
const hover = ref<Pt | null>(null);
let drag: { pointer: number } | null = null;
const CLICK_PX = 3; // a press that moves less than this is a click
const CLOSE_PX = 9; // a click this close to a polygon's first corner closes it
function dropDraft(): void {
	drag = null;
	draft.value = null;
	hover.value = null;
}
// a draft belongs to the picture it started on, and to the tool and the switch it started under: another file, the same one coming in again (Retry), another tool or Measure off drops it
watch([() => props.file.candidate_id, url, () => props.tool, () => props.measureOn], dropDraft);
const clamp = (v: number) => Math.min(1, Math.max(0, v));
function fraction(e: PointerEvent): Pt | null {
	const r = img.value?.getBoundingClientRect();
	if (!r || !r.width || !r.height) return null;
	return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
}
/** The distance between two points (fractions) as drawn on the screen, in screen pixels. */
function onScreen(a: Pt, b: Pt): number {
	const r = img.value?.getBoundingClientRect();
	return r ? Math.hypot((a.x - b.x) * r.width, (a.y - b.y) * r.height) : 0;
}
function finishDrag(): void {
	const d = draft.value;
	drag = null;
	draft.value = null;
	if (!d || d.kind === 'polygon') return;
	// a press that did not move is not a shape (and clears the old one, as it always did)
	emit('measure', onScreen(d.kind === 'line' ? d.a : d.c, d.kind === 'line' ? d.b : d.r) < CLICK_PX ? null : d);
}
function closePolygon(): void {
	const d = draft.value;
	if (d?.kind !== 'polygon' || d.pts.length < 3) return;
	draft.value = null;
	hover.value = null;
	emit('measure', { kind: 'polygon', pts: d.pts, closed: true });
}
function addCorner(p: Pt): void {
	const d = draft.value?.kind === 'polygon' ? draft.value : null;
	const pts = d?.pts ?? [];
	if (pts.length >= 3 && onScreen(p, pts[0]) < CLOSE_PX) return closePolygon();
	if (pts.some((q) => onScreen(p, q) < CLICK_PX)) return; // the second press of a double-click, or a click on a corner already there
	draft.value = { kind: 'polygon', pts: [...pts, p], closed: false };
	hover.value = p;
}
const DOUBLE_MS = 500; // a second press this soon, on the same spot, is a double-click's
let lastPress: { at: Pt; t: number } | null = null;
function down(e: PointerEvent): void {
	if (!interactive.value || (e.button ?? 0) > 0) return;
	const p = fraction(e);
	if (!p) return;
	tick.value += 1;
	e.preventDefault();
	emit('press');
	// the second press of a double-click adds no corner: the double-click itself closes the polygon (a press on the first corner has just closed it, and must not start a new one)
	// (a pointerdown's `detail` is 0 in some browsers, so a quick second press on the same spot counts too)
	const again = !!lastPress && Date.now() - lastPress.t < DOUBLE_MS && onScreen(p, lastPress.at) < CLICK_PX;
	lastPress = { at: p, t: Date.now() };
	if (props.tool === 'polygon') {
		if (e.detail < 2 && !again) addCorner(p);
		return;
	}
	drag = { pointer: e.pointerId };
	(e.currentTarget as Element | null)?.setPointerCapture?.(e.pointerId);
	draft.value = props.tool === 'circle' ? { kind: 'circle', c: p, r: p } : { kind: 'line', a: p, b: p };
}
function move(e: PointerEvent): void {
	const d = draft.value;
	if (!d) return;
	const p = fraction(e);
	if (!p) return;
	if (d.kind === 'polygon') hover.value = p;
	else if (drag && e.pointerId === drag.pointer) draft.value = d.kind === 'line' ? { ...d, b: p } : { ...d, r: p };
}
function up(e: PointerEvent): void {
	if (!drag || e.pointerId !== drag.pointer) return;
	move(e);
	finishDrag();
}
const leave = () => (hover.value = null);
/** Esc drops what is being drawn, Enter closes a polygon, Backspace takes its last corner off; with nothing being drawn these keys are the page's. Capture phase, so the page's Esc (back to the list) does not see them first. */
function onDrawKey(e: KeyboardEvent): void {
	const d = draft.value;
	if (!d || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
	if (e.target instanceof Element && e.target.closest(TEXT_ENTRY)) return;
	if (e.key === 'Escape') {
		e.preventDefault();
		dropDraft();
	} else if (d.kind === 'polygon' && e.key === 'Enter' && d.pts.length >= 3) {
		e.preventDefault();
		closePolygon();
	} else if (d.kind === 'polygon' && e.key === 'Backspace') {
		e.preventDefault();
		if (d.pts.length > 1) draft.value = { ...d, pts: d.pts.slice(0, -1) };
		else dropDraft();
	}
}
onMounted(() => document.addEventListener('keydown', onDrawKey, true));
onBeforeUnmount(() => document.removeEventListener('keydown', onDrawKey, true));

// What is shown: the draft, else the finished shape. The preview's natural size is read from the image (not reactive), so it is read again when the picture loads and when a press starts.
const tick = ref(0);
const shown = computed(() => draft.value ?? props.shape ?? null);
const natural = computed(() => {
	void tick.value;
	return { width: img.value?.naturalWidth ?? 0, height: img.value?.naturalHeight ?? 0 };
});
// the natural size is reported whenever it is read again (the picture loaded, or a press started), so saving a shape always has the size its fractions are of
watch(natural, (n) => emit('size', n.width > 0 && n.height > 0 ? { width: n.width, height: n.height } : null));
const result = computed(() => (shown.value ? shapeUm(shown.value, natural.value, scale.value) : null));
const openPolygon = computed(() => shown.value?.kind === 'polygon' && !shown.value.closed);
const words = computed(() => (openPolygon.value ? '' : measureText(result.value)));
/** The drawing's own space: the preview's natural pixels (1 x 1 until they are known), so a circle stays round on a picture of any shape. */
const space = computed(() => ({ w: natural.value.width || 1, h: natural.value.height || 1 }));
const viewBox = computed(() => `0 0 ${space.value.w} ${space.value.h}`);
const at = (p: Pt) => ({ x: p.x * space.value.w, y: p.y * space.value.h });
/** A circle's radius in the drawing's space (0 for any other shape). */
const radiusOf = (s: MeasureShape | null): number => (s?.kind === 'circle' ? Math.hypot((s.r.x - s.c.x) * space.value.w, (s.r.y - s.c.y) * space.value.h) : 0);
const pointsAttr = (s: MeasureShape | null): string => (s?.kind === 'polygon' ? s.pts.map((p) => `${at(p).x},${at(p).y}`).join(' ') : '');
const circleR = computed(() => radiusOf(shown.value));
const polyPoints = computed(() => pointsAttr(shown.value));
/** The small handles: a line's ends, a circle's centre and rim point, a polygon's corners. */
const handles = computed<Pt[]>(() => {
	const s = shown.value;
	if (!s) return [];
	return s.kind === 'line' ? [s.a, s.b] : s.kind === 'circle' ? [s.c, s.r] : s.pts;
});
/** Where the pill sits: over the middle of a line, on top of a circle, in the middle of a polygon. */
const anchorOf = (s: MeasureShape): { x: number; y: number; inside: boolean } => {
	if (s.kind === 'line') return { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2, inside: false };
	if (s.kind === 'circle') return { x: s.c.x, y: Math.max(0.06, s.c.y - radiusOf(s) / space.value.h), inside: false };
	const n = s.pts.length || 1;
	return { x: s.pts.reduce((t, p) => t + p.x, 0) / n, y: s.pts.reduce((t, p) => t + p.y, 0) / n, inside: true };
};
const pillAt = computed<{ x: number; y: number; inside: boolean } | null>(() => (shown.value ? anchorOf(shown.value) : null));
const pct = (v: number) => `${v * 100}%`;

// The shapes saved on this file, drawn under the live one (dimmer; the selected one at full strength with its number and size). They are stored in original pixels, so
// they need the scale and the preview's natural size (read again when the picture loads, like the live shape's); a shape that cannot be placed is left out.
const showKept = computed(() => props.measureOn && !!scale.value && state.value === 'ready');
const kept = computed(() => {
	if (!showKept.value) return [];
	const size = natural.value;
	return orderMeasurements(props.saved).flatMap((m, i) => {
		const shape = savedToShape(m, size, scale.value);
		if (!shape) return [];
		const selected = m.measurement_id === props.selectedId;
		return [{ id: m.measurement_id, shape, selected, tag: selected ? [i + 1, valueText(savedMeasure(m, scale.value))].filter((p) => p !== '').join(' · ') : String(i + 1), r: radiusOf(shape), points: pointsAttr(shape), anchor: anchorOf(shape) }];
	});
});

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
defineExpose({ setScroll, cancelDraft: dropDraft });
</script>

<template>
	<div class="pane" :data-state="state" :data-zoom="zoom" :data-test="`${side}-pane`">
		<template v-if="withPicture">
			<div v-if="state === 'ready' && url" ref="scroller" class="scroll" :data-test="`${side}-scroll`" @scroll.passive="onScroll">
				<div class="pic" :class="{ sized }">
					<img ref="img" :src="url" :alt="`Preview of ${name}`" :style="imgStyle" draggable="false" :data-test="`${side}-image`" @load="onLoad" />
					<ScaleBar v-if="bar" :bar="bar" :data-test="`${side}-scalebar`" />
					<svg v-if="kept.length" class="line kept" :viewBox="viewBox" preserveAspectRatio="none" aria-hidden="true" :data-test="`${side}-kept`">
						<g v-for="k in kept" :key="k.id" :class="{ sel: k.selected }" :data-test="`${side}-kept-shape`" :data-id="k.id" :data-shape="k.shape.kind" :data-selected="k.selected ? 'true' : 'false'">
							<line v-if="k.shape.kind === 'line'" :x1="at(k.shape.a).x" :y1="at(k.shape.a).y" :x2="at(k.shape.b).x" :y2="at(k.shape.b).y" />
							<circle v-else-if="k.shape.kind === 'circle'" :cx="at(k.shape.c).x" :cy="at(k.shape.c).y" :r="k.r" />
							<polygon v-else :points="k.points" />
						</g>
					</svg>
					<span
						v-for="k in kept"
						:key="`tag-${k.id}`"
						class="pill tag"
						:class="{ inside: k.anchor.inside, sel: k.selected }"
						:style="{ left: pct(k.anchor.x), top: pct(k.anchor.y) }"
						:data-test="`${side}-kept-tag`"
						:data-id="k.id"
						:data-selected="k.selected ? 'true' : 'false'"
					>{{ k.tag }}</span>
					<svg v-if="shown" class="line" :viewBox="viewBox" preserveAspectRatio="none" aria-hidden="true" :data-test="`${side}-line`" :data-shape="shown.kind">
						<line v-if="shown.kind === 'line'" :x1="at(shown.a).x" :y1="at(shown.a).y" :x2="at(shown.b).x" :y2="at(shown.b).y" />
						<circle v-else-if="shown.kind === 'circle'" :cx="at(shown.c).x" :cy="at(shown.c).y" :r="circleR" />
						<polygon v-else-if="shown.closed" :points="polyPoints" />
						<template v-else>
							<polyline :points="polyPoints" />
							<line v-if="hover && shown.pts.length" class="rubber" :x1="at(shown.pts[shown.pts.length - 1]).x" :y1="at(shown.pts[shown.pts.length - 1]).y" :x2="at(hover).x" :y2="at(hover).y" />
						</template>
					</svg>
					<span v-for="(h, i) in handles" :key="i" class="vtx" :class="{ first: openPolygon && i === 0 && handles.length >= 3 }" :style="{ left: pct(h.x), top: pct(h.y) }" aria-hidden="true" :data-test="`${side}-vertex`" />
					<span v-if="words && pillAt" class="pill" :class="{ inside: pillAt.inside }" :style="{ left: pct(pillAt.x), top: pct(pillAt.y) }" :data-test="`${side}-measure`">{{ words }}</span>
					<div
						v-if="measureOn"
						class="layer"
						:class="{ on: interactive }"
						:data-test="`${side}-layer`"
						@pointerdown="down"
						@pointermove="move"
						@pointerup="up"
						@pointercancel="dropDraft"
						@pointerleave="leave"
						@dblclick="closePolygon"
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
/* The measure shape (line, circle or polygon): dashed, in the accent colour, over the picture, drawn in the preview's own pixels so a circle stays round; the layer under the pointer exists only while Measure is on. */
.line { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.line line, .line circle, .line polygon, .line polyline { fill: none; stroke: var(--d1-accent, var(--theme--primary)); stroke-width: 2; stroke-dasharray: 6 4; vector-effect: non-scaling-stroke; }
.line circle, .line polygon { fill: color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 12%, transparent); }
.line .rubber { opacity: 0.55; }
/* Saved shapes: the same dashed outline, dimmer (the opacity of the rubber band); the selected one at full strength. Each has a pill with its number, the selected one adds its size. */
.kept g { opacity: 0.55; }
.kept g.sel { opacity: 1; }
.pill.tag { opacity: 0.55; }
.pill.tag.sel { opacity: 1; }
/* A small round handle on each end, centre, rim point or corner; a polygon's first corner grows once a click on it would close the shape. */
.vtx {
	position: absolute; width: 8px; height: 8px; margin: -4px 0 0 -4px; box-sizing: border-box; border-radius: 99px; pointer-events: none;
	background: var(--theme--background); border: 2px solid var(--d1-accent, var(--theme--primary));
}
.vtx.first { width: 14px; height: 14px; margin: -7px 0 0 -7px; }
.pill.inside { transform: translate(-50%, -50%); }
.pill {
	position: absolute; transform: translate(-50%, -140%); padding: 1px 8px; border-radius: 99px; pointer-events: none; white-space: nowrap;
	font-size: var(--fs-xs, 11px); font-weight: 650; line-height: 1.6; font-variant-numeric: tabular-nums;
	color: var(--theme--foreground); background: color-mix(in srgb, var(--theme--background) 85%, transparent); border: 1px solid var(--d1-accent, var(--theme--primary));
}
.layer { position: absolute; inset: 0; touch-action: none; pointer-events: none; }
.layer.on { pointer-events: auto; cursor: crosshair; }
</style>
