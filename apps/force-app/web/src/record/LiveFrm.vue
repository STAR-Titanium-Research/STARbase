<script setup lang="ts">
// Live FRM fingerprint: a three.js point cloud that accumulates the spiral as frames arrive from
// the RecordClient. Preallocated buffers filled incrementally (partial GPU upload of only the new
// points each frame).
//
// Stage 4 of the CloudCompare colour-scale port (see .claude/plans/parallel-drifting-twilight.md):
// converted from baking RGB into a colour attribute at append time (cm(tnorm), one cm() call per
// point) to the DiagScatter.vue/FrmOctree.vue model -- upload a raw scalar `aVal` attribute once,
// resolve colour in-shader from a LUT built from props.colorScale. This is the load-bearing
// conversion in the whole port: it's the ONLY renderer on the actual acquisition path (every other
// converted renderer works off an already-finished cut), so a colour-scale change here must never
// cost more than a uniform push -- before this conversion, EVERY colormap change replayed the
// entire accumulated spiral through a full CPU recolour + re-upload (the #65 bug this file used to
// carry a comment about), which is exactly the kind of per-drag-frame cost the "Full live editor"/
// "Applies live" design decisions for this feature cannot tolerate here.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import type { RecordClient } from './liveClient';
import { queueUpload } from './frmUpload';
import { createEmitThrottle } from './emitThrottle';
import { createAccumulator, createScaleTexture, syncScaleTexture, ColorBar, type Axis, type ColorScale, type Histogram, type HistogramAccumulator } from '@d1/force-plotting';

const props = withDefaults(defineProps<{ client: RecordClient; diam: number; colorScale: ColorScale; pointSize?: number; pointStride?: number; axis?: Axis }>(), {
	pointSize: 1.8, pointStride: 1, axis: 'Fz',
});
const emit = defineEmits<{
	(e: 'climits', v: { cmin: number; cmax: number }): void;
	(e: 'histogram', v: Histogram): void;
}>();

const canvasEl = ref<HTMLCanvasElement | null>(null);
// Matches RecordClient's own accumulator cap (liveClient.ts: `private cap = 2_000_000`) — this used
// to be capped lower at 1,000,000, so a long/dense cut whose live point count outgrew this buffer
// silently stopped rendering new points past it (TypedArray writes past the end are a silent
// no-op, not an error) while the accumulator kept counting fine. Sized for the worst case
// (pointStride=1); a stride > 1 just uploads fewer of the CAP slots.
const CAP = 2_000_000;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.OrthographicCamera | null = null;
let geom: THREE.BufferGeometry | null = null;
let posAttr: THREE.BufferAttribute | null = null;
let valAttr: THREE.BufferAttribute | null = null;   // raw per-point force value, CAP*1 (was colAttr, CAP*3 baked RGB)
let material: THREE.ShaderMaterial | null = null;
let raf = 0;
let uploaded = 0;   // source-side cursor into client.frm (every point seen, pre-decimation)
let rendered = 0;   // destination-side cursor into the GPU buffer (post-decimation)
let cssW = 1, cssH = 1;
let ro: ResizeObserver | null = null;
// tracked point bounds (mm) for auto-fit framing — robust for both sim and replayed real cuts
let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
// Render on demand: the loop still runs every frame (to pick up new points), but only draws when
// something visible changed -- a finished or paused spiral of up to 2M points costs nothing idle.
let needsRender = true;
function invalidate() { needsRender = true; }

function makeMaterial(): THREE.ShaderMaterial {
	const s = props.colorScale;
	return new THREE.ShaderMaterial({
		transparent: false,
		uniforms: {
			uGradient: { value: createScaleTexture(s) },
			uRange: { value: new THREE.Vector2(s.satMin, s.satMax) },
			uDisp: { value: new THREE.Vector2(s.dispMin, s.dispMax) },
			uGreyOOR: { value: s.greyOutOfRange ? 1 : 0 },
			uSize: { value: props.pointSize },
			// gl_PointSize is in device pixels; PointsMaterial (which this replaced) scaled by the
			// renderer's pixel ratio, so do the same to keep points the same on-screen size.
			uPixelRatio: { value: 1 },
		},
		vertexShader: `
			attribute float aVal;
			uniform sampler2D uGradient;
			uniform vec2 uRange;
			uniform vec2 uDisp;
			uniform float uGreyOOR;
			uniform float uSize;
			uniform float uPixelRatio;
			varying vec3 vColor;
			varying float vHidden;
			void main() {
				bool outOfDisplay = aVal < uDisp.x || aVal > uDisp.y;
				vHidden = (outOfDisplay && uGreyOOR < 0.5) ? 1.0 : 0.0;
				float u = clamp((aVal - uRange.x) / max(1e-6, uRange.y - uRange.x), 0.0, 1.0);
				vColor = texture2D(uGradient, vec2(u, 0.5)).rgb;
				if (outOfDisplay && uGreyOOR > 0.5) vColor = vec3(0.5);
				gl_PointSize = uSize * uPixelRatio;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}
		`,
		fragmentShader: `
			varying vec3 vColor;
			varying float vHidden;
			void main() {
				if (vHidden > 0.5) discard;               // displayed-range filter, hide mode
				vec2 d = gl_PointCoord - vec2(0.5);
				if (dot(d, d) > 0.25) discard;             // round points (was a disc texture + alphaTest)
				gl_FragColor = vec4(vColor, 1.0);
			}
		`,
	});
}

function setup() {
	const canvas = canvasEl.value!;
	renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.setClearColor(0x000000, 0);
	scene = new THREE.Scene();
	camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
	camera.position.set(0, 0, 5);
	geom = new THREE.BufferGeometry();
	posAttr = new THREE.BufferAttribute(new Float32Array(CAP * 3), 3);
	valAttr = new THREE.BufferAttribute(new Float32Array(CAP), 1);
	posAttr.setUsage(THREE.DynamicDrawUsage); valAttr.setUsage(THREE.DynamicDrawUsage);
	geom.setAttribute('position', posAttr);
	geom.setAttribute('aVal', valAttr);
	geom.setDrawRange(0, 0);
	material = makeMaterial();
	material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
	const points = new THREE.Points(geom, material);
	// #87, same fix as FrmCloud's #14: three computes the bounding sphere ONCE, on first render,
	// from whatever the buffer held then — here the all-zero preallocated buffer, a zero-radius
	// sphere at the origin. Zoomed in on a part of the spiral away from the origin, the camera
	// frustum no longer contains that sphere, the object is culled, and a culled object also skips
	// its attribute upload, so slices appended meanwhile never reached the GPU. The cloud always
	// fills the view it is framed for, so culling it buys nothing anyway.
	points.frustumCulled = false;
	scene.add(points);
	sizeCanvas(); frame();
	loop();
}

function sizeCanvas() {
	const c = canvasEl.value; if (!c || !renderer) return;
	const r = c.getBoundingClientRect();
	cssW = Math.max(1, r.width); cssH = Math.max(1, r.height);
	renderer.setSize(cssW, cssH, false);
	invalidate();
	frameCamera();
}

// ---- View framing -------------------------------------------------------------------------
// The current framing in world units (mm): centre + half-height. Auto-fit recomputes these from
// the point bounds every frame; once the user pans/zooms, `userView` latches and auto-fit stops
// touching them (#52 — the view read as "locked" precisely because the per-frame re-fit stomped
// any attempt to move it). Reset View hands control back to auto-fit.
let viewCx = 0, viewCy = 0, viewHalf = 1;
const userView = ref(false);

function halfExtents() {
	const aspect = cssW / cssH;
	return { hw: viewHalf * (aspect >= 1 ? aspect : 1), hh: viewHalf / (aspect >= 1 ? 1 : aspect) };
}

function applyCamera() {
	if (!camera) return;
	const { hw, hh } = halfExtents();
	// Called every frame by frameCamera(); only a real change should cost a redraw.
	if (camera.left === viewCx - hw && camera.right === viewCx + hw && camera.top === viewCy + hh && camera.bottom === viewCy - hh) return;
	camera.left = viewCx - hw; camera.right = viewCx + hw;
	camera.top = viewCy + hh; camera.bottom = viewCy - hh;
	camera.position.set(viewCx, viewCy, 5);
	camera.updateProjectionMatrix();
	invalidate();
}

// Fit to the actual point bounds (falls back to diam when empty), unless the user owns the view.
function frameCamera() {
	if (!camera) return;
	if (!userView.value) {
		const has = bx1 >= bx0;
		viewCx = has ? (bx0 + bx1) / 2 : 0;
		viewCy = has ? (by0 + by1) / 2 : 0;
		const span = has ? Math.max(bx1 - bx0, by1 - by0, 1) : props.diam;
		viewHalf = (span * 1.12) / 2;
	}
	applyCamera();
}

function resetView() { userView.value = false; frameCamera(); }

// ---- Pan / zoom ---------------------------------------------------------------------------
// Hand-rolled against the orthographic camera rather than OrbitControls: this is a flat XY
// fingerprint map, so orbiting has no meaning here — only pan and zoom do, and OrbitControls
// would additionally fight the auto-fit above for ownership of the camera each frame.
const MIN_HALF = 0.05;            // mm — stop zooming in once a single point fills the panel
const ZOOM_OUT_FACTOR = 20;       // relative to the auto-fit span, so "way out" is still bounded

function worldAt(ev: { clientX: number; clientY: number }) {
	const c = canvasEl.value!;
	const r = c.getBoundingClientRect();
	const { hw, hh } = halfExtents();
	return {
		x: viewCx - hw + ((ev.clientX - r.left) / r.width) * 2 * hw,
		y: viewCy + hh - ((ev.clientY - r.top) / r.height) * 2 * hh,
	};
}

function onWheel(ev: WheelEvent) {
	const before = worldAt(ev);
	userView.value = true;
	const span = bx1 >= bx0 ? Math.max(bx1 - bx0, by1 - by0, 1) : props.diam;
	const maxHalf = (span * 1.12) / 2 * ZOOM_OUT_FACTOR;
	viewHalf = Math.min(maxHalf, Math.max(MIN_HALF, viewHalf * Math.exp(ev.deltaY * 0.0015)));
	// Keep the point under the cursor pinned while the scale changes.
	const after = worldAt(ev);
	viewCx += before.x - after.x;
	viewCy += before.y - after.y;
	applyCamera();
}

const dragging = ref(false);
let lastX = 0, lastY = 0;
function onPointerDown(ev: PointerEvent) {
	if (ev.button !== 0) return;
	dragging.value = true; lastX = ev.clientX; lastY = ev.clientY;
	canvasEl.value?.setPointerCapture(ev.pointerId);
}
function onPointerMove(ev: PointerEvent) {
	if (!dragging.value) return;
	const c = canvasEl.value; if (!c) return;
	const r = c.getBoundingClientRect();
	const { hw, hh } = halfExtents();
	userView.value = true;
	viewCx -= ((ev.clientX - lastX) / r.width) * 2 * hw;
	viewCy += ((ev.clientY - lastY) / r.height) * 2 * hh;
	lastX = ev.clientX; lastY = ev.clientY;
	applyCamera();
}
function onPointerUp(ev: PointerEvent) {
	if (!dragging.value) return;
	dragging.value = false;
	canvasEl.value?.releasePointerCapture?.(ev.pointerId);
}

// Auto range, computed once per frame purely for the host to seed/reseed a fresh ColorScale
// (colorScale.ts's defaultScale/applyParams) as the recording progresses -- decoupled from what is
// actually RENDERED, which always comes from props.colorScale (the uRange uniform below). Same
// "climits reports the data, colorScale drives the render" split every other converted renderer
// uses, but with two differences forced by this being the only renderer on the live acquisition
// path: it has its own (not axisAutoLimits) range logic, and cAbsMaxByAxis is a running max that
// can change on almost every frame, not a one-shot/axis-switch-triggered detection.
let lastEmittedAutoKey = '';
// Incremental value-distribution accumulator (histogram.ts) for ColorScaleEditor.vue's strip --
// the live-recording use case that module's push()/rebin() split was designed for: only the
// newly-arrived slice each tick is pushed (O(1) amortised), and a domain change (a fresh
// emitAutoRange() key, same trigger as a climits re-seed) rebins from the resident client.frm.cx/
// cy/cz buffer, which holds every point up to fm.count (capped at 2M) -- bounded, no re-fetch.
let histAcc: HistogramAccumulator | null = null;
const HIST_BINS = 64;
const HIST_EMIT_MS = 100;   // ~10Hz throttle, per histogram.ts's own doc guidance
// Leading + trailing (#103): loop() flushes the last throttled change, so the strip never stays on
// a stale or empty snapshot once updates stop (paused, or a scrub that has settled).
const histThrottle = createEmitThrottle(HIST_EMIT_MS);
// Mirrored into refs for this component's OWN colorbar overlay (below). This surface renders both
// live recording and all of replay -- replay never reaches FrmCloud -- so until now the most-used
// FRM view showed a colour-coded cloud with no legend at all, which is the complaint the whole
// colour-scale port started from.
const autoLo = ref(0);
const autoHi = ref(1);
const liveHistogram = ref<Histogram | null>(null);
function publishHistogram() {
	if (!histAcc) return;
	const snap = histAcc.snapshot();
	liveHistogram.value = snap;
	emit('histogram', snap);
}
function emitHistogram(force: boolean) {
	if (histAcc && histThrottle.mark(performance.now(), force)) publishHistogram();
}
// Returns true when it re-seeded the range (and so rebinned the histogram), which frame() then
// publishes AFTER its own push: publishing here, before the push, is what made a backward scrub
// (a reset) flash an empty strip and then throttle away the refill that followed it (#103).
function emitAutoRange(): boolean {
	const fm = props.client.frm;
	// Prefer the percentile-based cLo/cHi playback sets at load time (matches the finished-cut
	// view's own colour scale exactly, computed once over the whole cut). A true live recording
	// never sets these — it can't know its final range while still acquiring — so it falls back
	// to the running |max|, symmetric about zero. A mode switch, not a fallback ordering: silently
	// preferring one shape over the other would desync this view's colours from the finished-cut
	// FrmCloud view's, which is exactly the parity haveRange exists to preserve.
	const axisMax = fm.cAbsMaxByAxis[props.axis];
	const haveRange = fm.cHi !== undefined && fm.cLo !== undefined && fm.cHi > fm.cLo;
	const lo = haveRange ? fm.cLo! : -Math.max(1e-6, axisMax);
	const hi = haveRange ? fm.cHi! : Math.max(1e-6, axisMax);
	// cAbsMaxByAxis ticks up on nearly every frame of a live recording; each emit re-seeds the host's
	// scale and rebins up to 2M points, so only re-emit when the range moved by >2% of its span.
	const key = `${props.axis}:${haveRange ? 'r' : 'm'}`;
	if (key === lastEmittedAutoKey) {
		const tol = (autoHi.value - autoLo.value) * 0.02;
		if (Math.abs(lo - autoLo.value) <= tol && Math.abs(hi - autoHi.value) <= tol) return false;
	}
	lastEmittedAutoKey = key;
	autoLo.value = lo; autoHi.value = hi;
	emit('climits', { cmin: lo, cmax: hi });
	// Domain changed -- rebin to match and backfill from everything already uploaded as of the END
	// of the LAST frame ([0, uploaded)); frame()'s own incremental push below covers
	// [uploaded, fm.count) every tick and never overlaps this backfill.
	const cArr = props.axis === 'Fx' ? fm.cx : props.axis === 'Fy' ? fm.cy : fm.cz;
	if (!histAcc) histAcc = createAccumulator(lo, hi, HIST_BINS);
	else histAcc.rebin(lo, hi);
	if (uploaded > 0) histAcc.push(cArr, 0, uploaded);
	return true;
}

function resetUpload() {
	uploaded = 0; rendered = 0;
	geom?.setDrawRange(0, 0);
	invalidate();
	bx0 = by0 = Infinity; bx1 = by1 = -Infinity;
	lastEmittedAutoKey = '';
	histAcc = null;
}

function frame() {
	const fm = props.client.frm;
	// New run detected (buffers reset) -> clear our upload cursor + bounds. Must run BEFORE
	// emitAutoRange()/the histogram backfill below, which both read `uploaded` as "everything
	// already accounted for".
	if (fm.count < uploaded) resetUpload();
	// Runs every tick, unconditionally -- NOT inside the `to > from` block below. cAbsMaxByAxis can
	// tick up on a frame that appends no new points (or while paused, if a future editor lets the
	// user drag a handle mid-pause), and the reported range must never go stale just because
	// appends stalled.
	const reseeded = emitAutoRange();
	const preUploaded = uploaded;
	const from = uploaded, to = fm.count;
	if (to > from && posAttr && valAttr) {
		const cArr = props.axis === 'Fx' ? fm.cx : props.axis === 'Fy' ? fm.cy : fm.cz;
		const pos = posAttr.array as Float32Array;
		const val = valAttr.array as Float32Array;
		// pointStride thins the LIVE map by keeping every Nth accumulated point (indexed on the
		// absolute source index, so the kept subset is stable regardless of chunking) — this is
		// what lets a long/dense cut stay responsive and under the GPU buffer cap, independent of
		// the coarser decimation the backend already applies per-chunk.
		const stride = Math.max(1, Math.round(props.pointStride) || 1);
		const firstKept = from + ((stride - (from % stride)) % stride);
		const writeStart = rendered;
		for (let i = firstKept; i < to; i += stride) {
			const x = fm.xy[i * 2], y = fm.xy[i * 2 + 1];
			const w = rendered;
			if (w >= CAP) break;
			pos[w * 3] = x; pos[w * 3 + 1] = y; pos[w * 3 + 2] = 0;
			if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
			val[w] = cArr[i];
			rendered++;
		}
		// Only re-upload the newly-written slice, not the whole CAP-sized buffer — a plain
		// needsUpdate=true (default updateRange covers the entire array) re-transfers the full
		// 2M-point buffer to the GPU on every frame that adds even one point, which is what made
		// long replays/recordings visibly stutter as the spiral grew. addUpdateRange restricts the
		// upload to [writeStart, rendered) so transfer cost stays proportional to new points only.
		// NOTE the offsets differ per attribute: pos is stride-3, val is stride-1 (was colAttr,
		// also stride-3) -- the one place this conversion changes the update-range arithmetic.
		// #87: queued as the union of everything not yet uploaded, not just this slice (frmUpload.ts).
		if (rendered > writeStart) {
			queueUpload(posAttr, valAttr, writeStart, rendered);
			invalidate();
		}
		geom!.setDrawRange(0, rendered);
		uploaded = to;
		// Incremental histogram push -- the contiguous [preUploaded, to) slice this frame appended,
		// independent of pointStride (the distribution is over the full resident data, not just the
		// decimated live-map subset) and never overlapping emitAutoRange()'s own backfill above.
		histAcc?.push(cArr, preUploaded, to);
		emitHistogram(reseeded);
	} else if (reseeded) {
		emitHistogram(true);
	}
}

function loop() {
	raf = requestAnimationFrame(loop);
	frame();
	if (histThrottle.pending && histThrottle.flush(performance.now())) publishHistogram();
	frameCamera();  // cheap; keeps the view fitted as the spiral grows
	if (material && material.uniforms.uSize.value !== props.pointSize) { material.uniforms.uSize.value = props.pointSize; invalidate(); }
	if (needsRender && renderer && scene && camera) { renderer.render(scene, camera); needsRender = false; }
}

// Reactive point count for the label (client.frm.count is a plain field; frameSeq bumps per frame).
const ptsLabel = computed(() => { void props.client.frameSeq.value; return props.client.frm.count; });

watch(() => props.diam, () => sizeCanvas());
// Changing the decimation live re-renders the WHOLE accumulated spiral at the new density
// (not just future points) so the displayed map is consistent at a single stride throughout.
watch(() => props.pointStride, () => resetUpload());
// Switching axis must recolour the entire accumulated spiral (all cx/cy/cz are already
// resident client-side), not just future points — same rebuild as a stride change, and unlike a
// colour-scale change, this genuinely needs a full re-pack: aVal's SOURCE array changes (cx vs cy
// vs cz), not just how it's mapped to colour.
watch(() => props.axis, () => resetUpload());
// A colour-scale change (including what used to be the separate `colormap` prop) is now a plain
// uniform push -- colour is resolved in-shader from the resident aVal attribute, so unlike before
// this conversion (colour baked into the GPU buffer at upload time, needing a full resetUpload()
// to recolour anything already drawn -- the #65 bug this file used to carry a comment about) NO
// re-pack is needed here at all. This is Stage 4's actual point: a saturation/displayed-range drag
// during a live recording costs an in-place LUT rewrite (only if lutKey changed) plus four uniform
// writes, never an O(N) CPU pass over up to 2M already-accumulated points.
watch(() => props.colorScale, (s) => {
	if (!material) return;
	syncScaleTexture(material.uniforms.uGradient.value, s);
	material.uniforms.uRange.value.set(s.satMin, s.satMax);
	material.uniforms.uDisp.value.set(s.dispMin, s.dispMax);
	material.uniforms.uGreyOOR.value = s.greyOutOfRange ? 1 : 0;
	invalidate();
}, { deep: true });
onMounted(() => { setup(); window.addEventListener('resize', sizeCanvas); ro = new ResizeObserver(sizeCanvas); if (canvasEl.value) ro.observe(canvasEl.value); nextTick(sizeCanvas); });
onBeforeUnmount(() => {
	cancelAnimationFrame(raf);
	window.removeEventListener('resize', sizeCanvas);
	ro?.disconnect();
	geom?.dispose(); material?.dispose();
	(material?.uniforms.uGradient.value as THREE.Texture | undefined)?.dispose();
	try { renderer?.forceContextLoss(); } catch { /* ignore */ }
	renderer?.dispose();
});
</script>

<template>
	<div class="live-frm">
		<canvas
			ref="canvasEl"
			:class="{ grabbing: dragging }"
			@wheel.prevent="onWheel"
			@pointerdown="onPointerDown"
			@pointermove="onPointerMove"
			@pointerup="onPointerUp"
			@pointercancel="onPointerUp"
			@dblclick="resetView"
		></canvas>
		<!-- Only offered once the user has actually moved the view: until then auto-fit IS the
		     reset state, so the button would do nothing. Doubles as the discoverability cue that
		     the map is pannable at all. -->
		<button v-if="userView" class="reset-view" title="Back to auto-fit (or double-click the map)" @click="resetView">
			<span class="material-symbols-rounded">recenter</span> Reset view
		</button>
		<!-- The legend this whole feature exists to provide. Driven by the same ColorScale the
			 shader renders from, so it can never drift from the cloud it describes. -->
		<div v-if="colorScale.barVisible" class="lf-cbar">
			<ColorBar :color-scale="colorScale" :domain-lo="autoLo" :domain-hi="autoHi"
				:histogram="liveHistogram" :height="34" :unit="`${axis} (N)`" />
		</div>
		<span class="pts">{{ ptsLabel.toLocaleString() }} pts</span>
	</div>
</template>

<style scoped>
.live-frm { position: relative; width: 100%; height: 100%; min-height: 200px; border-radius: 8px; overflow: hidden; background: var(--plot-bg); }
.live-frm canvas { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
.live-frm canvas.grabbing { cursor: grabbing; }
/* Bottom-right so it clears the Reset-view button (bottom-left) and the point count (top-right).
   pointer-events: none keeps it from stealing pan/zoom drags on the map underneath. */
.lf-cbar {
	position: absolute; right: 8px; bottom: 6px; width: min(210px, 45%);
	padding: 5px 7px 1px; border-radius: 7px;
	background: color-mix(in srgb, var(--bg-2) 82%, transparent);
	border: 1px solid var(--border); pointer-events: none;
}
.reset-view {
	position: absolute; left: 6px; bottom: 4px;
	display: inline-flex; align-items: center; gap: 3px;
	padding: 2px 7px 2px 5px; font-size: var(--fs-xs); line-height: 1.6;
	color: var(--text); background: var(--bg-2); border: 1px solid var(--border);
	border-radius: 999px; cursor: pointer; opacity: 0.85;
}
.reset-view:hover { opacity: 1; }
.reset-view .material-symbols-rounded { font-size: var(--icon-xs); }
.pts { position: absolute; right: 6px; top: 4px; font-size: var(--fs-xs); color: var(--text-dim); font-variant-numeric: tabular-nums; }
</style>
