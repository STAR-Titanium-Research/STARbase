<script setup lang="ts">
/*
 * Live FRM point cloud — a thin WebGL renderer that replaces the static FRM PNG in
 * the dashboard's FRM column when Live mode is on. It downloads the point-cloud cache
 * (live_cache.bin) once via the module-singleton LRU (liveCache.ts), then draws the
 * spiral fingerprint for the CURRENT geometry props (crop / Feed / Diameter / speed
 * model) recomputed client-side by buildCloud (liveCloud.ts). All plotting state lives
 * in the parent (ForceDashboard); the interactive VIEW (zoom/pan/rect-zoom) is local to
 * this renderer since it's purely a display transform over the same cloud.
 */
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from 'vue';
import { useForceHost } from './host';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { type Cache, cacheGet, cachePut, idxOfTime, parseCache } from './liveCache';
import { type Axis, type Cloud, type CloudChannel, type SpeedMode, axisAutoLimits, buildCloud } from './liveCloud';
import { buildPath, type PathParams } from './path';
import { exportFrmFigure } from './frmExport';
import { buildScaleLUT, colorizeValues, lutKey, type ColorScale } from './colorScale';
import { createScaleTexture, syncScaleTexture } from './scaleTexture';
import { histogramFrom, type Histogram } from './histogram';
import {
	buildStaticAttributes, spiralUniformValues,
	TURNING_SPIRAL_FRAG, TURNING_SPIRAL_VERT,
} from './frmCloudShader';

const props = defineProps<{
	cacheFileId: string;
	/** New: an explicit path config overrides the flat turning-spiral props below when supplied. */
	path?: PathParams;
	channel?: CloudChannel;
	/** @deprecated use `channel` — kept so existing Fx/Fy/Fz toggles keep compiling untouched. */
	axis?: Axis;
	feed: number;
	diam: number;
	innerDiam: number;
	speedMode: SpeedMode;
	rpm: number;
	vc: number;
	timeScale: number;
	ppr: number;
	cropStartSec: number;
	cropEndSec: number;
	stride: number;
	gridding: boolean;
	gridN: number;
	pointSize: number;
	colorScale: ColorScale;
	zSeries?: 'none' | 'Fx' | 'Fy' | 'Fz';    // drive Z from a force series -> true 3D (like Full)
	zScale?: number;                          // height exaggeration as a fraction of the x/y span
	// Compare mode (filtering suite): a parent-owned view object shared by both panes so
	// pan/zoom in either drives both; a pre-parsed cache that bypasses the network load
	// (the filtered preview from the filter-service); a small corner label ("raw").
	sharedView?: { cx: number; cy: number; span: number; active: boolean };
	cacheOverride?: Cache | null;
	paneLabel?: string;
}>();
const emit = defineEmits<{
	(e: 'loaded', meta: { csSec: number; ceSec: number; feed: number; diam: number; rpm: number; Fs: number; N: number }): void;
	(e: 'climits', v: { cmin: number; cmax: number }): void;
	(e: 'histogram', v: Histogram): void;   // value distribution over the same auto-limits window, for ColorScaleEditor.vue's strip
	(e: 'points', n: number): void;   // rendered point count (for the resolution readout)
	(e: 'zscale', v: number): void;   // 3-finger vertical swipe adjusts the Z exaggeration
}>();

// `channel` wins when supplied; `axis` is the deprecated alias every existing caller still uses.
const effChannel = computed<CloudChannel>(() => props.channel ?? props.axis ?? 'Fz');
// `path` wins when supplied; otherwise assemble a turning_spiral from the flat props, exactly
// reproducing what this component computed inline before the path-model refactor.
const effPath = computed<PathParams>(() => props.path ?? {
	kind: 'turning_spiral', feed: props.feed, diam: props.diam, innerDiam: props.innerDiam,
	speedMode: props.speedMode, rpm: props.rpm, vc: props.vc, timeScale: props.timeScale, ppr: props.ppr,
});

const api = useForceHost().api;
const loading = ref(true);
const error = ref<string | null>(null);
const glRenderer = ref('');            // UNMASKED_RENDERER_WEBGL (for the software-GL badge)
const softwareGL = ref(false);
const cache = ref<Cache | null>(null);
const pointCount = ref(0);
// Declared up here (not next to scheduleDraw) because the cacheFileId watch below runs
// load() with immediate:true; when the cache is already in the LRU (precached), load()
// runs synchronously during setup and calls resetView()->scheduleDraw(), which reads
// these — so they must be initialised first (else a "Cannot access 'raf'…" TDZ error).
let raf = 0;
let pendingRebuild = false;

async function load(id: string) {
	loading.value = true; error.value = null;
	try {
		let c = cacheGet(id);
		if (!c) {
			const res = await api.get(`/assets/${id}`, { responseType: 'arraybuffer' });
			c = parseCache(res.data as ArrayBuffer);
			cachePut(id, c);
		}
		cache.value = c;
		emit('loaded', {
			csSec: c.csSec, ceSec: c.ceSec, feed: c.feed, diam: c.diam,
			rpm: Math.round(c.rpm[c.rpm.length - 1] || 1000), Fs: c.Fs, N: c.N,
		});
		resetView();
		nextTick(() => { setupRenderer(); scheduleRebuild(); });
	} catch (e: any) {
		error.value = e?.message || 'failed to load live cache';
		cache.value = null;
	} finally {
		loading.value = false;
	}
}
// NOT immediate: an immediate watch runs during setup(), and on the precached (cache
// already in the LRU) path load() runs *synchronously* there — before the view-state
// refs below (viewActive, vCx…) are initialised — throwing "Cannot access 'viewActive'
// before initialization". The initial load is kicked off from onMounted instead (after
// setup completes, so every ref exists); this watch only handles later cacheFileId
// changes (switching ops while mounted), which already run post-setup.
watch(() => props.cacheFileId, (id) => { if (id && !props.cacheOverride) load(id); });
// Compare mode: the filtered pane's data arrives pre-parsed from the filter-service.
watch(() => props.cacheOverride, (c) => {
	if (c) { cache.value = c; loading.value = false; error.value = null; nextTick(() => { setupRenderer(); scheduleRebuild(); }); }
});

// ---- interactive view transform (equal-aspect, world = mm) ---------------------
// The view is a square-ish window on the world, expressed as centre + span (one
// span, since aspect is kept equal). viewActive=false means "auto-fit to data",
// recomputed every draw; any zoom/pan/rect-zoom switches it on. Reset returns to fit.
// When a sharedView is supplied (compare mode) BOTH panes read/write the same object, so
// pan/zoom/rect-zoom in either drives the other; standalone panes get their own state.
const view = props.sharedView ?? reactive({ cx: 0, cy: 0, span: 1, active: false });
// Redraw when the OTHER pane moves the shared view (our own writes also land here — the
// extra scheduleDraw coalesces into the same RAF, so it costs nothing).
watch(() => [view.cx, view.cy, view.span, view.active], () => scheduleDraw());
// updated each draw so the pointer handlers can map screen<->world
let fitCx = 0, fitCy = 0, fitSpan = 1, cssW = 1, cssH = 1;
const zoomed = computed(() => view.active);

function resetView() { view.active = false; scheduleDraw(); }
function effView() {
	return view.active
		? { cx: view.cx, cy: view.cy, span: view.span }
		: { cx: fitCx, cy: fitCy, span: fitSpan };
}
function scaleFor(span: number) {
	const s = (2 * 0.9) / (span || 1);
	const aspect = cssW / cssH;
	return aspect >= 1 ? { sx: s / aspect, sy: s } : { sx: s, sy: s * aspect };
}
// CSS-pixel (relative to canvas) -> world mm, under the current effective view
function screenToWorld(px: number, py: number) {
	const v = effView();
	const { sx, sy } = scaleFor(v.span);
	const offX = -v.cx * sx, offY = -v.cy * sy;
	const ndcX = (px / cssW) * 2 - 1, ndcY = 1 - (py / cssH) * 2;
	return { x: (ndcX - offX) / sx, y: (ndcY - offY) / sy, ndcX, ndcY, sx, sy };
}

// ---- overlays: colorbar + scale bar (reactive, refreshed each draw) ----
// The colorbar always shows exactly what's rendered, so it reads straight from props.colorScale
// rather than tracking a separately-updated ref -- see emitAutoRange() below for the SEPARATE
// signal (the 'climits' event) a host uses to seed/reseed a fresh ColorScale on a channel switch.
const climits = computed(() => (cache.value ? { cmin: props.colorScale.satMin, cmax: props.colorScale.satMax } : null));
const scaleBar = ref<{ px: number; label: string } | null>(null);
// Sampled from the SAME LUT the GPU renders with (buildScaleLUT), not a separate 0..1 colormap
// re-sample -- so this CSS ramp is pixel-consistent with the on-screen render, including step
// quantisation and log-scale banding, rather than a smooth approximation that could silently
// diverge from it.
const rampCss = computed(() => {
	const width = 32;
	const lut = buildScaleLUT(props.colorScale, width);
	const stops: string[] = [];
	for (let i = 0; i < width; i++) {
		stops.push(`rgb(${lut[i * 4]},${lut[i * 4 + 1]},${lut[i * 4 + 2]}) ${(i / (width - 1)) * 100}%`);
	}
	return `linear-gradient(to top, ${stops.join(', ')})`;
});
function fmtN(v: number): string {
	const a = Math.abs(v);
	if (a >= 1000) return (v / 1000).toFixed(1) + 'k';
	if (a >= 100) return v.toFixed(0);
	if (a >= 10) return v.toFixed(1);
	return v.toFixed(2);
}
function updateScaleBar() {
	const v = effView();
	const { sx } = scaleFor(v.span);
	const pxPerMm = (sx * cssW) / 2;                 // world(mm) -> css px
	if (!(pxPerMm > 0) || !isFinite(pxPerMm)) { scaleBar.value = null; return; }
	const targetPx = 90;
	const cands = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
	let mm = cands[0];
	for (const c of cands) { if (c * pxPerMm <= Math.min(targetPx, cssW * 0.42)) mm = c; }
	scaleBar.value = { px: Math.round(mm * pxPerMm), label: mm >= 1 ? `${mm} mm` : `${mm * 1000} µm` };
}

// ---- three.js point renderer ----
// three.js is the unified renderer stack (Phase 1): it draws the ≤3M full-resolution
// cloud directly here, and Phase 2's Potree octree LOD will drop into this same scene.
// The 2D orthographic camera is driven by the EXISTING view math (scaleFor/effView) so
// pointer interaction (pan/zoom/rect-zoom) and the scale bar stay pixel-consistent with
// the render — only the GL core changed, not the interaction model.
const canvasEl = ref<HTMLCanvasElement | null>(null);
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.OrthographicCamera | null = null;
let pointsGeom: THREE.BufferGeometry | null = null;
let pointsMat: THREE.PointsMaterial | null = null;
let pointsObj: THREE.Points | null = null;
let discTex: THREE.CanvasTexture | null = null;
let controls: OrbitControls | null = null;   // 3D mode only (Z series active)
let ready = false;
// GPU (turning-spiral) path — see usesGpuPath above and frmCloudShader.ts. gpuGeom's aT/aRevs/
// aVal attributes are STATIC (uploaded once per real geometry change); crop dragging only
// updates gpuMat.uniforms (updateGpuCropUniforms), never touches the geometry.
let gpuGeom: THREE.BufferGeometry | null = null;
let gpuMat: THREE.ShaderMaterial | null = null;
let gpuObj: THREE.Points | null = null;
let colormapTex: THREE.DataTexture | null = null;
let gpuUploaded = false;   // whether gpuGeom currently holds this op's data at all
// 3D when a Z series is selected: the cloud gets a Z displacement and OrbitControls owns
// the camera; the custom 2D pan/pinch/wheel/rect handlers stand down. Flat is unchanged.
const is3D = computed(() => !!props.zSeries && props.zSeries !== 'none');
// GPU shader path (frmCloudShader.ts) — the crop-drag lag fix. Deliberately narrow: gridding is
// a genuine many-to-one CPU reduction a per-vertex shader can't express, a Z-series overlay/3D
// needs OrbitControls + a second static attribute this file doesn't wire up, and linear_feed/
// machine_xyz have no shader implementation — none of those three is what a user drags
// continuously, so none needed the rewrite. Everything else (the default 2D turning-spiral
// scatter, which IS what was laggy) gets it.
const usesGpuPath = computed(() =>
	!props.gridding && (!props.zSeries || props.zSeries === 'none') && effPath.value.kind === 'turning_spiral');

// a soft white disc so points render as filled circles (matching the old fragment
// shader's round-point discard), not squares. alphaTest keeps them crisp + opaque.
function makeDisc(): THREE.CanvasTexture {
	const s = 64, cv = document.createElement('canvas'); cv.width = cv.height = s;
	const ctx = cv.getContext('2d')!;
	ctx.beginPath(); ctx.arc(s / 2, s / 2, s / 2 - 2, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
	const t = new THREE.CanvasTexture(cv); t.needsUpdate = true; return t;
}

function setupRenderer() {
	if (ready || !canvasEl.value) return;
	const canvas = canvasEl.value;
	try {
		renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
	} catch { error.value = 'WebGL unavailable in this browser'; return; }
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.setClearColor(0x000000, 0);
	// Because this context is created with preserveDrawingBuffer (needed for exportViewport's
	// pixel-identical downloads), the drawing buffer is NOT implicitly cleared before the first
	// render — on many GPU/driver combos its initial content is uninitialised memory, which
	// commonly reads back as solid white. draw() doesn't render at all until a cloud exists (which
	// can be a few frames away — the cache still needs to load/rebuild), so without an explicit
	// clear here the canvas shows that white flash the whole time. One clear right after context
	// creation paints the intended background immediately.
	renderer.clear();
	// Surface software-GL fallback (SwiftShader/llvmpipe — e.g. remote-desktop sessions or a
	// blocklisted driver): every render then runs on the CPU and pan feels like it burns a
	// core no matter what we optimise. The badge tells the user WHY, instantly.
	try {
		const gl = renderer.getContext();
		const dbg = gl.getExtension('WEBGL_debug_renderer_info');
		glRenderer.value = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
		softwareGL.value = /swiftshader|llvmpipe|software|basic render/i.test(glRenderer.value);
		if (softwareGL.value) console.info('[FrmCloud] software WebGL:', glRenderer.value);
	} catch { /* extension unavailable — assume hardware */ }
	scene = new THREE.Scene();
	camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1e6);   // far covers 3D orbit distances
	camera.position.set(0, 0, 10);
	discTex = makeDisc();
	pointsGeom = new THREE.BufferGeometry();
	pointsMat = new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, vertexColors: true, map: discTex, alphaTest: 0.5, transparent: false });
	pointsObj = new THREE.Points(pointsGeom, pointsMat);
	scene.add(pointsObj);

	colormapTex = createScaleTexture(props.colorScale);
	gpuGeom = new THREE.BufferGeometry();
	gpuMat = new THREE.ShaderMaterial({
		vertexShader: TURNING_SPIRAL_VERT, fragmentShader: TURNING_SPIRAL_FRAG,
		uniforms: {
			uFeed: { value: 0 }, uRho0: { value: 1 }, uInnerR: { value: 0 }, uSpeedMode: { value: 0 },
			uRevPerSec: { value: 0 }, uTimeScale: { value: 1 }, uPpr: { value: 1 }, uK: { value: 0 },
			uTCs: { value: 0 }, uRevsCs: { value: 0 }, uCropStart: { value: 0 }, uCropEnd: { value: 0 },
			uCmin: { value: props.colorScale.satMin }, uCmax: { value: props.colorScale.satMax },
			uDisp: { value: new THREE.Vector2(props.colorScale.dispMin, props.colorScale.dispMax) },
			uGreyOOR: { value: props.colorScale.greyOutOfRange ? 1 : 0 },
			uPointSize: { value: 1.4 }, uColormap: { value: colormapTex },
		},
		transparent: false,
	});
	gpuObj = new THREE.Points(gpuGeom, gpuMat);
	gpuObj.visible = false;
	// gpuGeom carries only aT/aRevs/aVal — position is computed procedurally in the vertex shader,
	// never uploaded as a real `position` attribute — so THREE has nothing to derive a meaningful
	// bounding sphere from and computeBoundingSphere() degenerates to a zero-radius sphere. Default
	// frustumCulled (true) then tests the camera frustum against THAT degenerate sphere instead of
	// where the spiral actually is, so the object gets silently culled — invisible, no error — once
	// the frustum shrinks enough for the (wrong) test to start failing, i.e. zoomed in a bit further
	// than usual (bug #14). There's no bounding volume to compute correctly here short of deriving
	// one from the geometry parameters every draw, so skip culling for this object entirely.
	gpuObj.frustumCulled = false;
	scene.add(gpuObj);
	// preventDefault keeps the canvas eligible for a restore event; on restore we re-upload
	// the resident buffers and resume, so a context the browser reclaimed (e.g. too many
	// live GL contexts while compare mode holds several clouds) recovers on its own instead
	// of dead-ending on "toggle Live to reload".
	canvas.addEventListener('webglcontextlost', onCtxLost, false);
	canvas.addEventListener('webglcontextrestored', onCtxRestored, false);
	ready = true;
	if (ro) ro.observe(canvas);
}
function onCtxLost(e: Event) { e.preventDefault(); ready = false; error.value = 'GPU context lost — restoring…'; }
function onCtxRestored() {
	error.value = null;
	// three re-creates its GL state on the restored context; re-flag our resources for
	// upload and rebuild from the (still-in-memory) cache.
	if (pointsGeom) { pointsGeom.dispose(); }
	ready = true;
	nextTick(() => { if (cache.value) scheduleRebuild(); });
}

let sizedW = 0, sizedH = 0;   // last size actually applied to the renderer
function sizeCanvas(canvas: HTMLCanvasElement) {
	const r = canvas.getBoundingClientRect();
	cssW = Math.max(1, r.width); cssH = Math.max(1, r.height);
	// Only touch the renderer when the size actually changed: three's setSize() assigns
	// canvas.width unconditionally, and that RESETS the drawing buffer even for the same
	// value — so calling it from draw() made every pan frame reallocate the framebuffer
	// (MSAA + preserved buffer included). That was the "high CPU just moving the map" bug.
	if (renderer && (cssW !== sizedW || cssH !== sizedH)) {
		renderer.setSize(cssW, cssH, false);   // three manages the drawing-buffer size + pixel ratio
		sizedW = cssW; sizedH = cssH;
	}
}

// The built cloud is the ONLY thing that depends on geometry/colour props. It is
// rebuilt (and re-uploaded to the GPU) only when one of those changes — NOT on
// pan/zoom/resize, which are pure view transforms handled by uniforms in draw().
// This is the core perf fix: dragging a million-point plot no longer re-runs the
// O(N) recompute + percentile sort + full buffer re-upload on every frame.
let cloud: Cloud | null = null;

// Auto colour limits, computed once per (cache, axis) over the WHOLE cut window, purely for a
// host to seed/reseed a fresh ColorScale (colorScale.ts's defaultScale/applyParams) on a channel
// switch -- decoupled from what is actually RENDERED, which always comes from props.colorScale
// (climits.value above). Same "climits reports the data, colorScale drives the render" split
// Stage 1/2 established for every other converted renderer.
watch(cache, () => { gpuUploaded = false; lastEmittedAutoKey = ''; });
let lastEmittedAutoKey = '';
function emitAutoRange() {
	const auto = cache.value ? axisAutoLimits(cache.value, effChannel.value) : [0, 1];   // memoised per (cache, channel)
	const key = `${effChannel.value}:${auto[0]}:${auto[1]}`;
	if (key === lastEmittedAutoKey) return;   // avoid re-seeding the host's scale on every rebuild
	lastEmittedAutoKey = key;
	emit('climits', { cmin: auto[0], cmax: auto[1] });
	// Same array/window axisAutoLimits sampled above -- the distribution ColorScaleEditor.vue's
	// strip shows always matches the range climits just reported, never a different population.
	const channelArr = cache.value ? (cache.value as any)[effChannel.value] as Float32Array | undefined : undefined;
	if (channelArr && channelArr.length) emit('histogram', histogramFrom(channelArr, channelArr.length, auto[0], auto[1], 64));
}
function rebuild() {
	if (!ready || !canvasEl.value || !cache.value) return;
	if (usesGpuPath.value) {
		if (pointsObj) pointsObj.visible = false;
		if (gpuObj) gpuObj.visible = true;
		cloud = null;
		uploadGpuGeometry();
		return;
	}
	if (gpuObj) gpuObj.visible = false;
	if (pointsObj) pointsObj.visible = true;
	if (!pointsGeom) return;
	emitAutoRange();
	const s = props.colorScale;
	cloud = buildCloud(cache.value, {
		channel: effChannel.value,
		path: effPath.value,
		window: { cropStartSec: props.cropStartSec, cropEndSec: props.cropEndSec, stride: props.stride },
		gridding: props.gridding, gridN: props.gridN,
		cmin: s.satMin, cmax: s.satMax,   // no colormap: colour comes from colorizeValues below
		zSeries: props.zSeries || 'none',
	});
	pointCount.value = cloud?.count ?? 0;
	emit('points', pointCount.value);
	if (!cloud) { scaleBar.value = null; return; }

	// data-fit params (used when the view is in auto-fit mode + as reset target)
	fitCx = (cloud.bounds.minX + cloud.bounds.maxX) / 2; fitCy = (cloud.bounds.minY + cloud.bounds.maxY) / 2;
	fitSpan = Math.max(cloud.bounds.maxX - cloud.bounds.minX, cloud.bounds.maxY - cloud.bounds.minY) || 1;

	// upload ONCE per rebuild. cloud.pos is already stride-3 (buildPath emits x,y,z directly).
	// Colour is RGBA from colorizeValues (the full colour scale: steps, log, displayed range), and
	// a colour-only change recolours this buffer in place (recolorCpu) rather than rebuilding.
	const n = cloud.count;
	pointsGeom.setAttribute('position', new THREE.BufferAttribute(cloud.pos, 3));
	const rgba = new Uint8Array(n * 4);
	colorizeValues(cloud.val, n, s, rgba);
	pointsGeom.setAttribute('color', new THREE.BufferAttribute(rgba, 4, true));
	pointsGeom.setDrawRange(0, n);
	applyZScale();
	if (is3D.value && !controls) enter3D();   // mounted straight into 3D (Z picked before Lite)
}

// ---- GPU (turning-spiral) path: static geometry uploaded once, crop is a free uniform -------
// Real geometry change (op load, channel select, stride change, colormap change, or the
// gridding/zSeries/path-kind toggles that flip usesGpuPath itself) — mirrors the CPU rebuild's
// cost, just for the shader's static attributes instead of a pre-coloured/pre-positioned buffer.
function uploadGpuGeometry() {
	if (!gpuGeom || !gpuMat || !cache.value) return;
	const c = cache.value;
	const pp = effPath.value;
	if (pp.kind !== 'turning_spiral') return;   // usesGpuPath already guards this; defensive only

	const { aT, aRevs, aVal, count } = buildStaticAttributes(c, effChannel.value, props.stride);
	gpuGeom.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
	gpuGeom.setAttribute('aRevs', new THREE.BufferAttribute(aRevs, 1));
	gpuGeom.setAttribute('aVal', new THREE.BufferAttribute(aVal, 1));
	gpuGeom.setDrawRange(0, count);
	gpuUploaded = true;

	// Apply whatever colour scale is currently in effect -- a real geometry change (e.g. switching
	// channel) must render with today's colorScale, not stale defaults. Ongoing colour-only
	// changes (dragging a saturation/displayed handle) are handled by the dedicated colorScale
	// watcher further down WITHOUT re-running this O(N) attribute rebuild -- that watcher is the
	// actual point of this GPU path, so this function must never become its trigger.
	// The LUT too: colour changes made while the CPU path was active never touched colormapTex.
	if (colormapTex) syncScaleTexture(colormapTex, props.colorScale);
	pushGpuColorUniforms(props.colorScale);
	emitAutoRange();

	updateGpuCropUniforms();
	refineGpuPointCount();   // exact count — cheap enough to also pay here, not just at drag-end
	scaleBar.value = null;   // recomputed by draw()/updateScaleBar()
}

// Crop drag: the free path. O(log N) index lookup + a handful of uniform writes, no CPU
// recompute over the point data and no GPU re-upload — this is the actual Phase-5 fix.
function updateGpuCropUniforms() {
	if (!gpuMat || !cache.value) return;
	const c = cache.value;
	const pp = effPath.value;
	if (pp.kind !== 'turning_spiral') return;
	const cs = idxOfTime(c.t, props.cropStartSec);
	const tCs = cs >= 0 ? c.t[cs] : 0, revsCs = cs >= 0 ? c.revs[cs] : 0;
	const u = spiralUniformValues({ ...pp, tCs, revsCs });
	const uni = gpuMat.uniforms;
	uni.uFeed.value = u.uFeed; uni.uRho0.value = u.uRho0; uni.uInnerR.value = u.uInnerR;
	uni.uSpeedMode.value = u.uSpeedMode; uni.uRevPerSec.value = u.uRevPerSec; uni.uTimeScale.value = u.uTimeScale;
	uni.uPpr.value = u.uPpr; uni.uK.value = u.uK; uni.uTCs.value = u.uTCs; uni.uRevsCs.value = u.uRevsCs;
	uni.uCropStart.value = props.cropStartSec; uni.uCropEnd.value = props.cropEndSec;

	// O(1) analytic fit: r=0 exactly AT the crop-start sample by construction (see
	// frmCloudShader.ts), so rho there is always rho0 — for any window spanning at least one
	// full revolution (virtually every real cut) the bounding box is the square of side 2*rho0,
	// regardless of where the crop-end/inner-diameter cutoff lands.
	fitCx = 0; fitCy = 0; fitSpan = Math.max(1, u.uRho0 * 2);
}

// Exact visible-point count needs the inner-diameter cutoff, which (per frmCloudShader.ts's
// documented, real-cache-checked assumption) isn't a closed-form function of crop time alone for
// measured-speed mode — so debounce a single CPU pass rather than either running it every drag
// frame (defeats the point of this rewrite) or leaving the "N pts" readout permanently stale.
let gpuRefineTimer = 0;
function scheduleGpuRefine() {
	if (gpuRefineTimer) window.clearTimeout(gpuRefineTimer);
	gpuRefineTimer = window.setTimeout(() => { gpuRefineTimer = 0; refineGpuPointCount(); }, 150);
}
function refineGpuPointCount() {
	const c = cache.value; const pp = effPath.value;
	if (!c || pp.kind !== 'turning_spiral') return;
	const path = buildPath(c, pp, { cropStartSec: props.cropStartSec, cropEndSec: props.cropEndSec, stride: props.stride });
	pointCount.value = path?.count ?? 0;
	emit('points', pointCount.value);
}

// Z exaggeration in world units = fraction of the data span; applied via the Points
// object's scale.z over the centred (-0.5..0.5) Z attribute (free — no rebuild).
function applyZScale() {
	if (!pointsObj) return;
	pointsObj.scale.z = is3D.value ? Math.max(0.001, fitSpan * (props.zScale ?? 0.35)) : 1;
}

// Enter 3D: OrbitControls takes the camera (rotate/dolly/pan) framed on the cloud.
// Exit: reset the camera pose so the 2D per-draw frustum math is authoritative again.
function enter3D() {
	if (!canvasEl.value || !camera) return;
	if (!controls) {
		controls = new OrbitControls(camera, canvasEl.value);
		controls.addEventListener('change', scheduleDraw);
		controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
		controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
		controls.enableDamping = false;
	}
	controls.enabled = true;
	// frame: top-down on the data centre; frustum sized to the fit span
	const aspect = cssW / cssH || 1;
	const half = (fitSpan * 1.1) / 2;
	camera.left = -half * (aspect >= 1 ? aspect : 1); camera.right = -camera.left;
	camera.top = half / (aspect >= 1 ? 1 : aspect); camera.bottom = -camera.top;
	camera.zoom = 1;
	camera.position.set(fitCx, fitCy, fitSpan * 2);
	camera.up.set(0, 1, 0);
	camera.lookAt(fitCx, fitCy, 0);
	camera.updateProjectionMatrix();
	controls.target.set(fitCx, fitCy, 0);
	controls.update();
}
function exit3D() {
	if (controls) controls.enabled = false;
	if (camera) { camera.rotation.set(0, 0, 0); camera.up.set(0, 1, 0); camera.zoom = 1; }
}
watch(is3D, (on) => {
	if (on) enter3D(); else exit3D();
	applyZScale();
	scheduleDraw();
});
watch(() => props.zScale, () => { applyZScale(); scheduleDraw(); });

// View-only redraw: no recompute, no re-upload — just drive the orthographic camera
// from the current view and render the resident geometry. Cheap enough per frame.
function draw() {
	if (!ready || !renderer || !scene || !camera || !canvasEl.value) return;
	sizeCanvas(canvasEl.value);
	const hasContent = usesGpuPath.value ? gpuUploaded : !!cloud;
	if (!hasContent) {
		// Nothing to show yet (still loading, or a degenerate/empty crop window) — explicitly
		// clear rather than skipping the render entirely, so the canvas shows the intended
		// background instead of whatever was left in the (preserveDrawingBuffer) buffer before.
		renderer.clear();
		scaleBar.value = null;
		return;
	}
	if (is3D.value) {
		// OrbitControls owns the camera; just render.
		if (pointsMat) pointsMat.size = Math.max(1, props.pointSize || 1.4);
		renderer.render(scene, camera);
		scaleBar.value = null;   // a rotated view has no single mm-per-px
		return;
	}
	const v = effView();
	// scaleFor maps world→NDC as ndc = (world-centre)*s; the ortho half-extents are
	// therefore 1/s, so the camera frustum reproduces the exact same mapping the pointer
	// math (screenToWorld) uses — keeping interaction and render perfectly aligned.
	const { sx, sy } = scaleFor(v.span);
	camera.left = -1 / sx; camera.right = 1 / sx;
	camera.top = 1 / sy; camera.bottom = -1 / sy;
	camera.position.set(v.cx, v.cy, 10);
	camera.updateProjectionMatrix();
	if (pointsMat) pointsMat.size = Math.max(1, props.pointSize || 1.4);
	if (gpuMat) gpuMat.uniforms.uPointSize.value = Math.max(1, props.pointSize || 1.4);
	renderer.render(scene, camera);

	updateScaleBar();
}

let pendingRecolor = false;
function scheduleDraw() {
	if (raf) return;
	raf = requestAnimationFrame(() => {
		raf = 0;
		if (pendingRebuild) { pendingRebuild = false; pendingRecolor = false; rebuild(); }
		else if (pendingRecolor) { pendingRecolor = false; recolorCpu(); }
		draw();
	});
}
// Coalesce a rebuild into the next frame (geometry change).
function scheduleRebuild() { pendingRebuild = true; scheduleDraw(); }
// CPU path colour-only change: O(N) repaint of the resident colour buffer, at most once a frame.
function scheduleRecolor() { pendingRecolor = true; scheduleDraw(); }
function recolorCpu() {
	if (!cloud || !pointsGeom) return;
	const attr = pointsGeom.getAttribute('color') as THREE.BufferAttribute | undefined;
	if (!attr || attr.itemSize !== 4 || attr.count !== cloud.count) { scheduleRebuild(); return; }
	colorizeValues(cloud.val, cloud.count, props.colorScale, attr.array as Uint8Array);
	attr.needsUpdate = true;
}
function pushGpuColorUniforms(s: ColorScale) {
	if (!gpuMat) return;
	gpuMat.uniforms.uCmin.value = s.satMin;
	gpuMat.uniforms.uCmax.value = s.satMax > s.satMin ? s.satMax : s.satMin + 1;
	gpuMat.uniforms.uDisp.value.set(s.dispMin, s.dispMax);
	gpuMat.uniforms.uGreyOOR.value = s.greyOutOfRange ? 1 : 0;
}

// Current visible world rectangle (mm) — the same (cx±1/sx, cy±1/sy) extents the
// camera renders — so the parent can ask the host to re-render exactly this viewport
// at full resolution for a pixel-identical download.
function currentBounds(): { xmin: number; xmax: number; ymin: number; ymax: number } {
	const v = effView();
	const { sx, sy } = scaleFor(v.span);
	return { xmin: v.cx - 1 / sx, xmax: v.cx + 1 / sx, ymin: v.cy - 1 / sy, ymax: v.cy + 1 / sy };
}
// Export the CURRENT viewport (whatever zoom/pan the user is looking at) as a formatted FRM
// figure — instant, client-side, no host round-trip. Forces a fresh draw first (the renderer
// keeps preserveDrawingBuffer) and composites the report styling (axes/colorbar/title) around it.
function exportViewport(filename: string, subtitle?: string) {
	if (is3D.value) return false;   // a rotated 3D view has no meaningful 2D axes -> fall back
	const c = canvasEl.value;
	if (!c || !ready) return false;
	draw();
	const s = props.colorScale;
	return exportFrmFigure({
		canvas: c, bounds: currentBounds(),
		cmin: s.satMin, cmax: s.satMax, colorScale: s,
		axis: effChannel.value, subtitle, filename,
	});
}
defineExpose({ currentBounds, exportViewport });

let ro: ResizeObserver | undefined;
onMounted(() => {
	ro = new ResizeObserver(() => scheduleDraw());
	// Kick off the initial cache load here (post-setup) rather than via an immediate
	// watch, so the synchronous precached path can't touch not-yet-initialised refs.
	// cacheOverride (compare mode's filtered pane) bypasses the network entirely.
	if (props.cacheOverride) { cache.value = props.cacheOverride; loading.value = false; nextTick(() => { setupRenderer(); scheduleRebuild(); }); }
	else if (props.cacheFileId) load(props.cacheFileId);
	else if (cache.value) nextTick(() => { setupRenderer(); scheduleRebuild(); });
});
// #57: ForceDashboard's Plot route is kept alive across navigation (<keep-alive>), and Vue
// propagates onActivated/onDeactivated (not onBeforeUnmount) to components nested inside that
// cached subtree — this component is one of them (rendered via v-if inside ForceDashboard). Left
// as onBeforeUnmount-only, an operator who opens FRM then leaves /plot and returns repeatedly
// would never hit this cleanup, accumulating live WebGL contexts for the rest of the session.
// teardownRenderer mirrors onMounted's setupRenderer()/scheduleRebuild() pair below so a
// deactivated cloud tears down exactly like an unmounted one, and reactivating re-runs the same
// first-mount setup path (setupRenderer's `if (ready ...) return` guard is why this is safe to
// call again — ready is reset to false here).
function teardownRenderer() {
	if (raf) cancelAnimationFrame(raf);
	ro?.disconnect();
	if (cropTimer) clearTimeout(cropTimer);
	controls?.dispose();
	pointsGeom?.dispose(); pointsMat?.dispose(); discTex?.dispose();
	gpuGeom?.dispose(); gpuMat?.dispose(); colormapTex?.dispose();
	if (gpuRefineTimer) clearTimeout(gpuRefineTimer);
	// dispose() alone does NOT free the WebGL context; forceContextLoss() releases it so a
	// mode/filter toggle (which unmounts one cloud and mounts another) can't accumulate live
	// contexts until the browser reclaims one — the "Lite never recovered" bug on big ops.
	try { renderer?.forceContextLoss(); } catch { /* ignore */ }
	renderer?.dispose();
	if (canvasEl.value) {
		canvasEl.value.removeEventListener('webglcontextlost', onCtxLost, false);
		canvasEl.value.removeEventListener('webglcontextrestored', onCtxRestored, false);
	}
	renderer = null; scene = null; camera = null; controls = null;
	pointsGeom = null; pointsMat = null; pointsObj = null; discTex = null;
	gpuGeom = null; gpuMat = null; gpuObj = null; colormapTex = null;
	gpuUploaded = false;
	ready = false;
}
onBeforeUnmount(teardownRenderer);
onDeactivated(teardownRenderer);
onActivated(() => { if (!ready) nextTick(() => { setupRenderer(); scheduleRebuild(); }); });

// Geometry/colour props → rebuild immediately. pointSize is view-only (a uniform). Crop
// (cropStartSec/cropEndSec) is DELIBERATELY excluded here — it has its own throttled watcher
// below (onCropChange), since it's dragged continuously and an unthrottled rebuild on every
// drag frame is the O(N) recompute + percentile sort + GPU re-upload lag this file's other
// comments describe. Including it in this list too would silently bypass that throttle.
watch(() => [effChannel.value, effPath.value, props.stride,
	props.gridding, props.gridN, props.zSeries], scheduleRebuild, { deep: true });
watch(() => props.pointSize, scheduleDraw);

// A host's colorScale is often a fresh object on every recompute, so the deep watch fires on
// identity alone; skip when nothing either path reads has changed (lutKey covers log scale).
function colorScaleUnchanged(a: ColorScale, b: ColorScale | null): boolean {
	return !!b && lutKey(a) === lutKey(b) &&
		a.satMin === b.satMin && a.satMax === b.satMax &&
		a.dispMin === b.dispMin && a.dispMax === b.dispMax &&
		a.greyOutOfRange === b.greyOutOfRange;
}
// Compared against a copy, not the watcher's `prev`: when a host mutates the scale in place, `prev`
// IS the new object and every change would look like a no-op.
let lastScale: ColorScale | null = { ...props.colorScale };
// Neither path re-runs geometry for a colour change: the GPU path pushes uniforms (and rewrites
// the LUT texture when lutKey changes); the CPU path repaints its resident colour buffer and
// leaves the texture to uploadGpuGeometry's resync on the way back to the GPU path.
watch(() => props.colorScale, (s) => {
	if (colorScaleUnchanged(s, lastScale)) return;
	lastScale = { ...s };
	if (!usesGpuPath.value) { scheduleRecolor(); return; }
	if (colormapTex) syncScaleTexture(colormapTex, s);
	pushGpuColorUniforms(s);
	scheduleDraw();
}, { deep: true });

// Crop is DRAGGED, and — for the CPU path only (gridded mode, a Z-series overlay/3D, or a
// linear_feed/machine_xyz path; see usesGpuPath) — its rebuild is still the full O(N) recompute +
// percentile sort + GPU re-upload that makes millions-of-points laggy. So throttle IT to ~12fps
// (leading rebuild, then a trailing one so the final crop is exact). The GPU (turning-spiral,
// ungridded, flat) path below skips this entirely — that's the actual Phase-5 fix; this throttle
// is now only a fallback for the cases that were deliberately kept on the old CPU path.
// The force charts' crop shading stays instant regardless (cheap SVG overlay).
let cropTimer = 0, cropTrailing = false;
function onCropChange() {
	if (usesGpuPath.value) {
		// The actual Phase-5 fix: no CPU recompute, no GPU re-upload, no throttle — just a
		// handful of uniform writes, so this runs on every single drag frame for free.
		updateGpuCropUniforms();
		scheduleDraw();
		scheduleGpuRefine();
		return;
	}
	if (cropTimer) { cropTrailing = true; return; }
	scheduleRebuild();
	const step = () => {
		cropTimer = 0;
		if (cropTrailing) { cropTrailing = false; scheduleRebuild(); cropTimer = window.setTimeout(step, 80); }
	};
	cropTimer = window.setTimeout(step, 80);
}
watch(() => [props.cropStartSec, props.cropEndSec], onCropChange);

// ---- pointer interaction: wheel-zoom, drag-pan, rectangular zoom ----
const rectTool = ref(false);                       // when on, drag draws a zoom rectangle
const rectSel = ref<{ x: number; y: number; w: number; h: number } | null>(null);
let panning = false, rectDrag = false;
let startPx = 0, startPy = 0;
let grab: { x: number; y: number } | null = null;   // world point grabbed for pan

function localXY(ev: PointerEvent | WheelEvent) {
	const r = canvasEl.value!.getBoundingClientRect();
	return { px: (ev as any).clientX - r.left, py: (ev as any).clientY - r.top };
}
function onWheel(ev: WheelEvent) {
	if (!cache.value) return;
	if (is3D.value) return;   // OrbitControls owns wheel-zoom in 3D
	ev.preventDefault();
	const { px, py } = localXY(ev);
	const w = screenToWorld(px, py);
	// Magnitude-aware zoom. The old code stepped a fixed 1.2x per wheel EVENT (sign only),
	// so a free-spinning / high-res wheel — which emits a burst of events per physical
	// notch — multiplied that dozens of times and slammed straight to max zoom. Normalise
	// the delta across device units (px / lines / pages), clamp a single event's reach,
	// and scale continuously so one notch ≈ 1.2x regardless of how it's delivered.
	let dy = ev.deltaY;
	if (ev.deltaMode === 1) dy *= 16;                       // lines -> ~px
	else if (ev.deltaMode === 2) dy *= (cssH || 600);       // pages -> ~px
	dy = Math.max(-100, Math.min(100, dy));                 // cap one event to ~one notch
	const f = Math.exp(-dy * 0.00182);                      // ~1.2x per 100px notch
	const v = effView();
	const newSpan = Math.min(fitSpan * 8, Math.max(fitSpan / 500, v.span / f));
	const { sx, sy } = scaleFor(newSpan);
	view.cx = w.x - w.ndcX / sx;
	view.cy = w.y - w.ndcY / sy;
	view.span = newSpan;
	view.active = true;
	scheduleDraw();
}
// Active pointers, so touch can pinch-zoom (two fingers) as well as pan (one). Desktop
// still uses the wheel; mobile had NO zoom before this — a single pointer only panned.
const pointers = new Map<number, { px: number; py: number }>();
let pinch: { dist: number; span: number; cx: number; cy: number } | null = null;
function pointerList() { return [...pointers.values()]; }
function pointerDist() { const p = pointerList(); return Math.hypot(p[0].px - p[1].px, p[0].py - p[1].py); }
function pointerMid() { const p = pointerList(); return { px: (p[0].px + p[1].px) / 2, py: (p[0].py + p[1].py) / 2 }; }
function seedView() { if (!view.active) { view.cx = fitCx; view.cy = fitCy; view.span = fitSpan; view.active = true; } }

// 3-finger vertical drag adjusts the Z exaggeration in 3D (same gesture as Full).
let zGestureY: number | null = null;
function avgPy(): number { let s = 0; for (const p of pointers.values()) s += p.py; return s / (pointers.size || 1); }

function onDown(ev: PointerEvent) {
	if (!cache.value) return;
	const { px, py } = localXY(ev);
	(ev.currentTarget as Element).setPointerCapture(ev.pointerId);
	pointers.set(ev.pointerId, { px, py });
	if (is3D.value) {
		// OrbitControls handles 1/2-finger via its own listeners; we only run the 3-finger gesture
		if (pointers.size === 3 && controls) { controls.enabled = false; zGestureY = avgPy(); }
		return;
	}
	if (pointers.size === 2) {
		// second finger down -> start a pinch; abandon any pan/rect in progress
		panning = false; rectDrag = false; rectSel.value = null;
		seedView();
		const mid = pointerMid(); const w = screenToWorld(mid.px, mid.py);
		pinch = { dist: pointerDist() || 1, span: view.span, cx: w.x, cy: w.y };
		return;
	}
	if (pointers.size > 2) return;
	if (rectTool.value) {
		rectDrag = true; startPx = px; startPy = py; rectSel.value = { x: px, y: py, w: 0, h: 0 };
	} else {
		panning = true; grab = { x: screenToWorld(px, py).x, y: screenToWorld(px, py).y };
		seedView();
	}
}
function onMove(ev: PointerEvent) {
	if (!cache.value) return;
	const { px, py } = localXY(ev);
	if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { px, py });
	if (is3D.value) {
		if (zGestureY != null && pointers.size >= 3 ) {
			const y = avgPy(); const dy = zGestureY - y; zGestureY = y;   // up = more separation
			const cur = Math.max(0.02, props.zScale ?? 0.35);
			emit('zscale', Number(Math.min(3, Math.max(0, cur * Math.exp(dy * 0.006))).toFixed(4)));
		}
		return;
	}
	if (pinch && pointers.size >= 2) {
		// pinch-zoom: keep the world point under the finger midpoint fixed (spread = zoom in)
		const d = pointerDist();
		if (d > 0) {
			const newSpan = Math.min(fitSpan * 8, Math.max(fitSpan / 500, pinch.span * (pinch.dist / d)));
			const mid = pointerMid();
			const { sx, sy } = scaleFor(newSpan);
			const ndcX = (mid.px / cssW) * 2 - 1, ndcY = 1 - (mid.py / cssH) * 2;
			view.span = newSpan; view.cx = pinch.cx - ndcX / sx; view.cy = pinch.cy - ndcY / sy;
			scheduleDraw();
		}
		return;
	}
	if (rectDrag && rectSel.value) {
		rectSel.value = { x: Math.min(px, startPx), y: Math.min(py, startPy), w: Math.abs(px - startPx), h: Math.abs(py - startPy) };
	} else if (panning && grab) {
		// keep the grabbed world point glued under the cursor
		const { sx, sy } = scaleFor(view.span);
		const ndcX = (px / cssW) * 2 - 1, ndcY = 1 - (py / cssH) * 2;
		view.cx = grab.x - ndcX / sx;
		view.cy = grab.y - ndcY / sy;
		scheduleDraw();
	}
}
function onUp(ev: PointerEvent) {
	try { (ev.currentTarget as Element).releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
	pointers.delete(ev.pointerId);
	if (is3D.value) {
		if (pointers.size < 3) { zGestureY = null; if (controls) controls.enabled = true; }
		return;
	}
	if (pointers.size < 2) pinch = null;
	if (rectDrag && rectSel.value) {
		const s = rectSel.value;
		if (s.w > 6 && s.h > 6) {
			const a = screenToWorld(s.x, s.y + s.h), b = screenToWorld(s.x + s.w, s.y);
			view.cx = (a.x + b.x) / 2; view.cy = (a.y + b.y) / 2;
			view.span = Math.max(Math.abs(b.x - a.x), Math.abs(a.y - b.y)) || view.span;
			view.active = true;
		}
		rectSel.value = null;
	}
	rectDrag = false; panning = false; grab = null;
	scheduleDraw();
}
</script>

<template>
	<div class="frm-cloud">
		<div v-if="loading" class="fc-msg"><v-progress-circular indeterminate small /></div>
		<div v-else-if="error" class="fc-msg err"><v-icon name="error" small /> {{ error }}</div>
		<canvas v-show="!loading && !error" ref="canvasEl"
			:class="{ rect: rectTool }"
			@wheel="onWheel" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp"></canvas>

		<!-- rubber-band zoom rectangle -->
		<div v-if="rectSel" class="fc-rect" :style="{ left: rectSel.x + 'px', top: rectSel.y + 'px', width: rectSel.w + 'px', height: rectSel.h + 'px' }"></div>

		<!-- colorbar (force -> colour); the editor's "Show colour bar on render" drives barVisible -->
		<div v-if="climits && colorScale.barVisible && !loading && !error" class="fc-cbar">
			<span class="fc-cval">{{ fmtN(climits.cmax) }}</span>
			<div class="fc-ramp" :style="{ background: rampCss }"></div>
			<span class="fc-cval">{{ fmtN(climits.cmin) }}</span>
			<span class="fc-cunit">{{ axis }} (N)</span>
		</div>

		<!-- scale bar (mm) -->
		<div v-if="scaleBar && !loading && !error" class="fc-scale">
			<div class="fc-scale-line" :style="{ width: scaleBar.px + 'px' }"></div>
			<span>{{ scaleBar.label }}</span>
		</div>

		<!-- view tools -->
		<div v-if="!loading && !error" class="fc-tools">
			<button class="fc-tbtn" :class="{ on: rectTool }" title="Rectangular zoom (drag a box)" @click="rectTool = !rectTool">
				<v-icon name="crop_free" x-small />
			</button>
			<button class="fc-tbtn" :disabled="!zoomed" title="Reset view" @click="resetView">
				<v-icon name="restart_alt" x-small />
			</button>
		</div>

		<span v-if="!loading && !error" class="fc-count">{{ pointCount.toLocaleString() }} pts</span>
		<span v-if="paneLabel && !loading && !error" class="fc-pane">{{ paneLabel }}</span>
		<span v-if="softwareGL && !loading && !error" class="fc-swgl"
			:title="`WebGL is running in SOFTWARE (${glRenderer}) — rendering uses the CPU, so pan/zoom will feel heavy. Common causes: remote-desktop session, blocklisted GPU driver, or hardware acceleration disabled in the browser.`">
			⚠ software WebGL</span>
	</div>
</template>

<style scoped>
.frm-cloud { position: relative; width: 100%; height: 100%; min-height: 160px; background: var(--plot-bg, #0b1020); border-radius: 6px; overflow: hidden; }
.frm-cloud canvas { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
.frm-cloud canvas:active { cursor: grabbing; }
.frm-cloud canvas.rect { cursor: crosshair; }
.fc-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 8px; color: #94a3b8; }
.fc-msg.err { color: #fca5a5; font-size: var(--fs-sm, 12px); padding: 12px; text-align: center; }
.fc-count { position: absolute; right: 6px; bottom: 4px; font-size: var(--fs-xs, 11px); color: var(--text-dim, #94a3b8); font-variant-numeric: tabular-nums; }
.fc-swgl { position: absolute; left: 6px; bottom: 4px; font-size: var(--fs-xs, 11px); font-weight: 700; color: #fbbf24; cursor: help; }
.fc-pane { position: absolute; left: 6px; top: 4px; font-size: var(--fs-xs, 11px); font-weight: 600; color: var(--text-dim, rgba(255,255,255,0.75)); letter-spacing: 0.01em; }

.fc-rect { position: absolute; border: 1px solid var(--accent, #38bdf8); background: color-mix(in srgb, var(--accent, #38bdf8) 14%, transparent); pointer-events: none; border-radius: 2px; }

.fc-cbar { position: absolute; top: 10px; right: 8px; display: flex; flex-direction: column; align-items: center; gap: 3px; pointer-events: none; }
.fc-ramp { width: 10px; height: 96px; border-radius: 3px; border: 1px solid var(--border-2, rgba(255,255,255,0.25)); }
.fc-cval { font-size: var(--fs-xs, 11px); color: var(--text, rgba(255,255,255,0.82)); font-variant-numeric: tabular-nums; }
.fc-cunit { font-size: var(--fs-xs, 11px); color: var(--text-dim, rgba(255,255,255,0.6)); margin-top: 1px; }

.fc-scale { position: absolute; left: 10px; bottom: 8px; display: flex; flex-direction: column; align-items: center; gap: 2px; pointer-events: none; }
.fc-scale-line { height: 3px; background: var(--text, rgba(255,255,255,0.85)); border-left: 1px solid var(--text, rgba(255,255,255,0.85)); border-right: 1px solid var(--text, rgba(255,255,255,0.85)); box-sizing: border-box; }
.fc-scale span { font-size: var(--fs-xs, 11px); color: var(--text, rgba(255,255,255,0.85)); font-variant-numeric: tabular-nums; }

.fc-tools { position: absolute; top: 8px; left: 8px; display: flex; gap: 5px; }
.fc-tbtn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 7px; cursor: pointer;
	color: var(--text, rgba(255,255,255,0.85)); background: var(--overlay, rgba(15,23,42,0.55)); border: 1px solid var(--border-2, rgba(255,255,255,0.18)); }
.fc-tbtn:hover { background: var(--surface-2, rgba(15,23,42,0.8)); }
.fc-tbtn.on { background: var(--accent, #38bdf8); border-color: var(--accent, #38bdf8); color: var(--accent-ink, #0b1020); }
.fc-tbtn:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
