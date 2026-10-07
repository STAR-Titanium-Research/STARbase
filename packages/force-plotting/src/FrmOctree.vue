<script setup lang="ts">
/*
 * Full-resolution FRM viewer (Phase 2). Streams a host-built Potree octree with
 * potree-core LOD, top-down orthographic, and colours it with OUR OWN ShaderMaterial
 * that reads the Fx/Fy/Fz force attributes and applies viridis — bypassing potree-core
 * 2.0.15's broken 2.0-octree colour pipeline (its new_format shader hard-codes rgba and
 * mis-decodes it). potree-core is used purely for octree management/streaming.
 *
 * The octree carries all three axes as attributes, so switching axis is just a uniform
 * change (no reload, no shader recompile). Served same-origin by Caddy at /octrees/<path>/.
 */
import { nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Potree, type PointCloudOctree } from 'potree-core';
import type { ColorScale } from './colorScale';
import { createScaleTexture, syncScaleTexture } from './scaleTexture';
import { exportFrmFigure } from './frmExport';
import { useForceHost } from './host';
import LoadingOverlay from './LoadingOverlay.vue';
import LinkRings from './LinkRings.vue';
import { createLoadToken } from './loadToken';
import { createGlLifecycle } from './glLifecycle';
import { sameStage, stageInfo, streamStage, type LoadStage, type StageInfo } from './loadStage';
import type { Cache } from './liveCache';
import type { TurningSpiralParams } from './path';
import {
	createClickTracker, displayedKeepIndex, octreePathParams, pickRadius, pickSpiral, pointInfo, settleRing,
	type PointMenuEvent,
} from './cloudPick';
import { nearestIndex } from './hoverIndex';
import { createPendingReveal } from './pendingReveal';
import { mappableWindow, noGeometryReason, parseOctreeBuild, type OctreeBuild } from './octreeBuild';
import { createMapProjector } from './mapProjector';
import { createLongPress, TOUCH_MENU_OFFSET_PX } from './longPress';
import { spiralPositionInto, spiralUniformValues, type SpiralPos, type SpiralUniforms } from './frmCloudShader';
import { shaderZ } from './octreePick';

const props = defineProps<{
	octreePath: string;                       // served subdir: /octrees/<octreePath>/
	axis: 'Fx' | 'Fy' | 'Fz';
	colorScale: ColorScale;
	pointSize: number;
	zSeries?: 'none' | 'Fx' | 'Fy' | 'Fz';    // drive the Z axis from a force series -> true 3D
	zScale?: number;                          // height exaggeration as a fraction of the x/y span
	totalPoints?: number;                     // octree's full point count -> sizes the LOD budget
	fill?: boolean;                           // grid octree: size points to tile cells into a surface
	cellSize?: number;                        // grid cell spacing (mm), for fill sizing
	minNodePx?: number;                       // Potree LOD cutoff (settings; default 1)
	budgetCap?: number;                       // Potree point-budget hard cap (settings; default 25M)
	// Linking to the Signals charts. Octree points carry no time, so a pick works by position
	// through the live cache's own path (see cloudPick.ts's header); without a cache the time
	// items are unavailable.
	sampleCache?: Cache | null;
	innerDiam?: number;                       // bore diameter (mm) the octree path was built with
	ppr?: number;                             // tacho pulses per revolution
	markTime?: number | null;                 // pinned ring (seconds on the chart axis)
	hoverTime?: number | null;                // hover ring
}>();
const emit = defineEmits<{
	(e: 'climits', v: { cmin: number; cmax: number }): void;
	(e: 'points', n: number): void;   // LOD-visible point count (for the resolution readout)
	(e: 'zscale', v: number): void;   // 3-finger vertical swipe adjusts the Z exaggeration
	(e: 'stage', v: StageInfo | null): void;   // what the view is busy with (null = idle), for the host's busy mark (#102)
	(e: 'pointmenu', v: PointMenuEvent): void;   // right-click or long-press on the map (point null = nothing resolvable)
}>();

const canvasEl = ref<HTMLCanvasElement | null>(null);
const loading = ref(true);
// 'open' while the metadata and root node load, then 'stream' while LOD nodes arrive: `loading`
// used to clear as soon as the root was in, so the rest of the full-res streaming looked finished
// (#102).
const stage = ref<LoadStage | null>({ kind: 'open' });
watch(stage, (s) => emit('stage', stageInfo(s)));
// Only the initial fill counts: after it, a pan or zoom re-streams a few nodes and a pill flashing
// on every gesture would be noise.
let lastChangeAt = performance.now();
let streamDone = false;
const error = ref<string | null>(null);
const pointCount = ref(0);

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.OrthographicCamera | null = null;
let controls: OrbitControls | null = null;
let potree: Potree | null = null;
let pco: PointCloudOctree | null = null;
let material: THREE.ShaderMaterial | null = null;
let raf = 0;
let cssW = 1, cssH = 1;
// Render-on-demand: the RAF loop still ticks potree's LOD/streaming, but only re-renders
// when something changed (interaction, appearance, newly streamed nodes). An unconditional
// render every frame burned CPU/GPU while the view just sat there.
let needsRender = true;
let lastVisibleN = -1;
function invalidate() { needsRender = true; }
// per-axis value ranges (from the octree metadata) for auto colour limits
const ranges: Record<string, [number, number]> = { Fx: [0, 1], Fy: [0, 1], Fz: [0, 1] };
const AXIS_IDX: Record<string, number> = { Fx: 0, Fy: 1, Fz: 2 };

// One material reads all three force attributes; a uAxis uniform selects which drives
// the colour, and uRange normalises it before the viridis lookup.
function makeMaterial(): THREE.ShaderMaterial {
	const s = props.colorScale;
	const m = new THREE.ShaderMaterial({
		uniforms: {
			uGradient: { value: createScaleTexture(s) },
			uRange: { value: new THREE.Vector2(s.satMin, s.satMax) },
			// Displayed-range filter, separate from uRange (saturation/colour): a point whose raw
			// value falls outside [uDisp.x, uDisp.y] is greyed (uGreyOOR>0.5) or discarded.
			uDisp: { value: new THREE.Vector2(s.dispMin, s.dispMax) },
			uGreyOOR: { value: s.greyOutOfRange ? 1 : 0 },
			uAxis: { value: AXIS_IDX[props.axis] ?? 2 },
			uSize: { value: props.pointSize || 1.5 },
			uZAxis: { value: -1 },                        // -1 = flat (2D); 0/1/2 = Fx/Fy/Fz drive Z
			uZRange: { value: new THREE.Vector2(0, 1) },
			uZScale: { value: 0 },                        // world-unit height for the [0,1]-normalised Z
			uFill: { value: props.fill ? 1 : 0 },         // 1 = size points in world units (grid octree)
			uPxPerMm: { value: 1 },                       // updated each frame from the camera/viewport
			uCell: { value: props.cellSize || 1 },        // grid cell spacing (mm)
		},
		vertexShader: `
			attribute float Fx; attribute float Fy; attribute float Fz;
			uniform vec2 uRange; uniform float uAxis; uniform float uSize;
			uniform float uZAxis; uniform vec2 uZRange; uniform float uZScale;
			uniform float uFill; uniform float uPxPerMm; uniform float uCell;
			uniform vec2 uDisp;
			varying float vT;
			varying float vOut;   // 1 = outside the displayed range
			float pick(float i) { return i < 0.5 ? Fx : (i < 1.5 ? Fy : Fz); }
			void main() {
				float v = pick(uAxis);
				// Tested here, in the (highp) vertex stage: the mediump fragment stage can be real
				// fp16, which quantises a force edge to ~1 N and overflows OPEN_DISP to inf.
				vOut = (v < uDisp.x || v > uDisp.y) ? 1.0 : 0.0;
				vT = clamp((v - uRange.x) / max(1e-6, uRange.y - uRange.x), 0.0, 1.0);
				float z = 0.0;
				if (uZAxis >= 0.0) {
					float zv = pick(uZAxis);
					z = (clamp((zv - uZRange.x) / max(1e-6, uZRange.y - uZRange.x), 0.0, 1.0) - 0.5) * uZScale;
				}
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, z, 1.0);
				gl_PointSize = uFill > 0.5 ? clamp(uCell * uPxPerMm, 1.0, 24.0) : uSize;
			}`,
		fragmentShader: `
			precision mediump float;
			uniform sampler2D uGradient; uniform float uGreyOOR;
			varying float vT; varying float vOut;
			void main() {
				vec2 d = gl_PointCoord - vec2(0.5); if (dot(d, d) > 0.25) discard;
				if (vOut > 0.5) {
					if (uGreyOOR > 0.5) { gl_FragColor = vec4(vec3(0.5), 1.0); return; }
					discard;
				}
				gl_FragColor = vec4(texture2D(uGradient, vec2(vT, 0.5)).rgb, 1.0);
			}`,
	});
	(m as any).updateMaterial = () => { /* potree calls this per frame; fixed-size = no-op */ };
	return m;
}

// The colour range currently applied (for the figure export) -- mirrors props.colorScale's own
// satMin/satMax, tracked separately only so exportViewport() need not re-derive it.
let appliedLo = 0, appliedHi = 1;
function applyRange() {
	if (!material) return;
	const s = props.colorScale;
	appliedLo = s.satMin; appliedHi = s.satMax > s.satMin ? s.satMax : s.satMin + 1;
	material.uniforms.uRange.value.set(appliedLo, appliedHi);
	material.uniforms.uDisp.value.set(s.dispMin, s.dispMax);
	material.uniforms.uGreyOOR.value = s.greyOutOfRange ? 1 : 0;
	invalidate();
}
// The octree's OWN per-axis metadata range, detected independently of whatever is currently
// applied -- lets a host reseed a fresh ColorScale (colorScale.ts's defaultScale/applyParams) on
// an axis switch, the same "climits reports the data, colorScale drives the render" split Stage 1
// established for DiagScatter.vue.
function emitAutoRange() {
	const auto = ranges[props.axis] || [0, 1];
	emit('climits', { cmin: auto[0], cmax: auto[1] });
}

// Drive the Z axis from a chosen force series -> true 3D. 'none' keeps it flat + top-down;
// otherwise the points are displaced by the (normalised) series value * uZScale, and free
// rotation is enabled so the height can be inspected.
let baseSpan = 100;
function applyZ() {
	if (!material || !controls) return;
	const z = props.zSeries || 'none';
	const idx = z === 'Fx' ? 0 : z === 'Fy' ? 1 : z === 'Fz' ? 2 : -1;
	material.uniforms.uZAxis.value = idx;
	if (idx >= 0) {
		const r = ranges[z] || [0, 1];
		material.uniforms.uZRange.value.set(r[0], r[1] > r[0] ? r[1] : r[0] + 1);
		material.uniforms.uZScale.value = baseSpan * (props.zScale ?? 0.35);
		// 3D: drag / one-finger rotates (tilt), two-finger dollies+pans. Height is inspectable.
		controls.enableRotate = true;
		controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
		controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
	} else {
		material.uniforms.uZScale.value = 0;
		// 2D (top-down): drag / one-finger pans, two-finger dollies+pans; no rotation.
		controls.enableRotate = false;
		controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
		controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
		frameCamera();   // snap back to a clean top-down view when flattening
	}
	invalidate();
}

// Returns the metadata's per-axis ranges (empty on failure -> defaults); the caller applies them
// only if its load is still current, so a superseded load can't overwrite the ranges.
async function loadMeta(base: string): Promise<Record<string, [number, number]>> {
	const found: Record<string, [number, number]> = {};
	try {
		// no-store: this metadata drives the colour limits; never risk a stale cached copy
		// (a pre-repatch metadata.json would show the wrong, un-clipped colour range).
		const res = await fetch(`${base}metadata.json`, { cache: 'no-store' });
		const meta = await res.json();
		for (const a of meta.attributes || []) {
			if (a.name in ranges && Array.isArray(a.min) && Array.isArray(a.max)) {
				found[a.name] = [Number(a.min[0]), Number(a.max[0])];
			}
		}
	} catch { /* fall back to defaults */ }
	return found;
}

// The octree's build manifest (d1_build.json): the geometry and cut window the host integrated it
// with. null for an octree built before the manifest existed (404), an unreadable or malformed file:
// the map then falls back to the cache window and the row's values. no-store, like metadata.json: a
// stale copy would place picks against the previous build.
async function loadBuild(base: string): Promise<OctreeBuild | null> {
	try {
		const res = await fetch(`${base}d1_build.json`, { cache: 'no-store' });
		if (!res.ok) return null;
		return parseOctreeBuild(await res.json());
	} catch { return null; }
}

// Free the current octree: its node geometries, material and gradient texture. Reloading used to
// just drop the reference (only unmount disposed), which leaked GPU memory on every op switch once
// the component stayed mounted across them.
function disposeCloud() {
	// The rings belong to the octree being dropped: the loop that updates them only runs while a
	// pco exists, so without this the old operation's rings would sit frozen on the new load.
	markRing.value = null; hoverRing.value = null;
	build = null; buildReady = false;   // the next octree's manifest decides its geometry
	if (pco) {
		scene?.remove(pco);
		try { pco.dispose(); } catch { /* already disposed */ }
		pco = null;
	}
	(material?.uniforms.uGradient.value as THREE.Texture | undefined)?.dispose();
	material?.dispose();
	material = null;
}

// Each load() takes a token and re-checks it after every await; a superseded load disposes what
// it created and touches nothing else (two overlapping loads both reached scene.add before).
const loadToken = createLoadToken();

async function load() {
	if (life.suspended) return;   // deactivated: onActivated() reloads on a fresh canvas
	const mine = loadToken.next();
	disposeCloud();
	loading.value = true; error.value = null;
	stage.value = { kind: 'open' };
	streamDone = false;
	// The octree host is configured, not assumed to be the SPA origin: the standalone app is
	// served from a different origin than the octree server, while the Directus module is
	// same-origin. The host supplies whichever applies.
	const base = `${useForceHost().octreeUrl}/${props.octreePath}/`;
	let pt: Potree | null = null, loaded: PointCloudOctree | null = null;
	try {
		const [found, bld] = await Promise.all([loadMeta(base), loadBuild(base)]);
		if (!loadToken.isCurrent(mine)) return;
		Object.assign(ranges, found);
		build = bld; buildReady = true;
		pt = new Potree();
		pt.maxNumNodesLoading = 12;   // parallelise node fetches so full-res streams in faster
		// "Full-res" must mean full res: budget the LOD to cover the whole octree (a small
		// headroom factor so the top level isn't shaved off), not a fixed 3M cap that left
		// large maps showing ~49%. Capped for GPU safety on the biggest maps.
		pt.pointBudget = props.totalPoints && props.totalPoints > 0
			? Math.min(Math.ceil(props.totalPoints * 1.05), props.budgetCap || 25_000_000)
			: 15_000_000;
		loaded = await pt.loadPointCloud('metadata.json', base);
		if (!loadToken.isCurrent(mine)) { loaded.dispose(); return; }
		// potree culls any octree node projecting smaller than minNodePixelSize (default
		// 50px) BEFORE the point budget is even considered — so at fit-view every deep
		// leaf is sub-50px and dropped, leaving only coarse levels (~8-50%). "Full-res"
		// must actually be full res, so drop the cutoff to ~1px; the budget above then
		// bounds the total. (Sub-pixel nodes contribute nothing visible anyway.)
		(loaded as any).minNodePixelSize = props.minNodePx || 1;
		material = makeMaterial();
		(loaded as any).material = material;
		potree = pt; pco = loaded;
		emitAutoRange();
		applyRange();
		scene!.add(pco);
		pco.updateMatrixWorld(true);
		frameCamera();
		applyZ();
		loading.value = false;
		lastChangeAt = performance.now();
		stage.value = streamStage(0, props.totalPoints, 0);
	} catch (e: any) {
		if (!loadToken.isCurrent(mine)) { try { loaded?.dispose(); } catch { /* ignore */ } return; }
		error.value = e?.message || 'failed to load octree';
		loading.value = false;
		stage.value = null;
	}
}

function frameCamera() {
	if (!pco || !camera || !controls) return;
	const box = pco.boundingBox.clone().applyMatrix4(pco.matrixWorld);
	const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
	baseSpan = Math.max(sz.x, sz.y) || 100;
	const span = baseSpan * 1.08, aspect = cssW / cssH;
	camera.left = -span / 2 * aspect; camera.right = span / 2 * aspect; camera.top = span / 2; camera.bottom = -span / 2;
	camera.position.set(c.x, c.y, c.z + 1e5); camera.up.set(0, 1, 0); camera.lookAt(c.x, c.y, c.z);
	camera.updateProjectionMatrix();
	controls.target.set(c.x, c.y, c.z); controls.update();
	invalidate();
}

function setupGL() {
	const canvas = canvasEl.value!;
	sizeCanvas();
	try {
		renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
	} catch { error.value = 'WebGL unavailable'; return; }
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.setClearColor(0x000000, 0);
	scene = new THREE.Scene();
	camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1e7);
	controls = new OrbitControls(camera, canvas);
	controls.enableRotate = false;
	controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
	controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
	canvas.addEventListener('pointerdown', onPtrDown);
	canvas.addEventListener('pointermove', onPtrMove);
	canvas.addEventListener('pointerup', onPtrUp);
	canvas.addEventListener('pointercancel', onPtrUp);
	canvas.addEventListener('contextmenu', onContextMenu);
	controls.addEventListener('change', invalidate);
	const loop = () => {
		raf = requestAnimationFrame(loop);
		controls!.update();
		if (pco && potree && renderer && camera) {
			updateRings();   // before the render gate below: the rings follow the camera even on idle frames
			applyPendingReveal();   // moves the camera: next frame's rings follow
			const r = potree.updatePointClouds([pco], camera, renderer);
			const n = (r as any)?.numVisiblePoints ?? pointCount.value;
			if (n !== lastVisibleN) { lastVisibleN = n; needsRender = true; lastChangeAt = performance.now(); }   // nodes streamed in/out
			if (!loading.value && !streamDone) {
				const next = streamStage(n, props.totalPoints, performance.now() - lastChangeAt);
				if (!next) streamDone = true;
				if (!sameStage(stage.value, next)) stage.value = next;
			}
			if (Math.abs(n - pointCount.value) > pointCount.value * 0.02 + 1) { pointCount.value = n; emit('points', n); }
			if (!needsRender) return;
			needsRender = false;
			if (material && props.fill) {
				// orthographic: world width shown = (right-left)/zoom; px width = domElement.width.
				const worldW = (camera.right - camera.left) / (camera.zoom || 1);
				material.uniforms.uPxPerMm.value = worldW > 0 ? (renderer.domElement.width / worldW) : 1;
			}
			renderer.render(scene!, camera);
		}
	};
	loop();
}

// 3-finger vertical swipe adjusts the Z exaggeration (only when a Z series is loaded). Swiping
// up spreads the points apart in Z; down flattens. Tracked via POINTER events (not touch) so it
// coexists with OrbitControls' pointer capture — touch events can be suppressed once a pointer is
// captured, which is why a touch-based handler didn't fire. OrbitControls is paused for the
// gesture; the new value is emitted and the parent owns zScale, feeding it back.
const zPointers = new Map<number, number>();   // pointerId -> clientY
let zBaseY = 0;
function avgVals(m: Map<number, number>): number { let s = 0; for (const v of m.values()) s += v; return s / (m.size || 1); }
function onPtrDown(ev: PointerEvent) {
	// OrbitControls pans on right-drag (2D and 3D): remember where the button went down so the
	// release can tell a click (opens the menu) from a pan.
	rightClick.down(ev);
	longPress.down(ev);
	if (ev.pointerType !== 'touch') return;
	zPointers.set(ev.pointerId, ev.clientY);
	if (zPointers.size === 3) { if (controls) controls.enabled = false; zBaseY = avgVals(zPointers); }
}
function onPtrMove(ev: PointerEvent) {
	longPress.move(ev);
	if (!zPointers.has(ev.pointerId)) return;
	zPointers.set(ev.pointerId, ev.clientY);
	if (zPointers.size >= 3 && props.zSeries && props.zSeries !== 'none') {
		const y = avgVals(zPointers);
		const dy = zBaseY - y;   // swipe up (dy > 0) => more Z separation
		zBaseY = y;
		const cur = Math.max(0.02, props.zScale ?? 0.35);
		emit('zscale', Number(Math.min(3, Math.max(0, cur * Math.exp(dy * 0.006))).toFixed(4)));
	}
}
function onPtrUp(ev: PointerEvent) {
	if (rightClick.up(ev)) pickAt(ev.clientX, ev.clientY);
	longPress.up(ev);   // also cancels on pointercancel
	zPointers.delete(ev.pointerId);
	if (zPointers.size < 3 && controls) controls.enabled = true;
}

// ---- Linking to the Signals charts: right-click picking and time rings ----
// The octree has no per-point time, so both directions go through the live cache, laid out with
// the geometry the octree was built with (octreePathParams: the same mm frame; see cloudPick.ts's
// header). Positions are true world mm (potree-core restores the LAS offset), so no pco matrix is
// applied to them. Nothing here ever builds a path (~20 B per sample, about 100 MB at 5M): a pick
// streams the samples through the shader's own maths (pickSpiral, stride 1 over the whole cache,
// which is the octree window), and rings and reveal place one sample in closed form.
const rightClick = createClickTracker();
// A one-finger hold opens the same menu on a touchscreen (longPress.ts). OrbitControls keeps its own
// touch pan/dolly: a move or a second finger cancels the hold.
const longPress = createLongPress((x, y) => pickAt(x, y, TOUCH_MENU_OFFSET_PX));

// What the spiral maths needs, per (sampleCache, innerDiam, ppr): small objects only. The render
// loop places rings every frame, so none of this may be rebuilt there.
// With the build manifest the geometry is the build's own (feed, diameters, ppr, window), and the
// row's inner diameter / ppr are ignored: they may have been edited since. Without one (an older
// octree) it is the cache window with the row's values. `win` is what can be mapped: the window
// clipped to the cache's t range, null when the cache starts after the build's cut start (`covered`
// false: the r = 0 anchor has no sample, so nothing can be placed).
interface OctreeGeo {
	c: Cache; innerDiam: number; ppr: number; build: OctreeBuild | null; path: TurningSpiralParams;
	cs: number; ce: number; win: { start: number; end: number } | null; u: SpiralUniforms;
	anchor: { tCs: number; revsCs: number };
}
let geo: OctreeGeo | null = null;
let build: OctreeBuild | null = null;
let buildReady = false;   // the manifest fetch has settled: before that, picks would use the wrong geometry
function octreeGeometry(): OctreeGeo | null {
	const c = props.sampleCache;
	if (!c || !c.N) { geo = null; return null; }   // never keep a dropped cache (100+ MB) reachable
	if (!buildReady) return null;
	const innerDiam = props.innerDiam ?? 0, ppr = props.ppr ?? 1;
	if (geo && geo.c === c && geo.innerDiam === innerDiam && geo.ppr === ppr && geo.build === build) return geo;
	const g = octreePathParams(c, innerDiam, ppr, build);
	if (g.path.kind !== 'turning_spiral') return null;
	const cs = g.window.cropStartSec, ce = g.window.cropEndSec;
	geo = {
		c, innerDiam, ppr, build, path: g.path, cs, ce, win: mappableWindow(c, build),
		anchor: g.anchor, u: spiralUniformValues({ ...g.path, ...g.anchor }),
	};
	return geo;
}

// The vertex shader's Z for this frame (flat, or the series, range and scale it reads), read from
// the uniforms into one reused object: it runs per frame for the rings.
const zMap = { on: false, series: null as Float32Array | null, r0: 0, r1: 1, scale: 0 };
function readZ(c: Cache): void {
	const u = material?.uniforms;
	const zAxis = u ? (u.uZAxis.value as number) : -1;
	zMap.on = !!u && zAxis >= 0;
	if (zMap.on) {
		const r = u!.uZRange.value as THREE.Vector2;
		zMap.series = zAxis === 0 ? c.Fx : zAxis === 1 ? c.Fy : c.Fz;
		zMap.r0 = r.x; zMap.r1 = r.y; zMap.scale = u!.uZScale.value as number;
	}
}
const zAt = (i: number) => (zMap.on ? shaderZ(zMap.series![i], zMap.r0, zMap.r1, zMap.scale) : 0);

const _v = new THREE.Vector3();
const _pt = { px: 0, py: 0 };
const proj = createMapProjector();
// _v (world) -> CSS px relative to the canvas in `out`; false when outside the view. For one-off
// callers (rings, reveal): a pick folds the camera once (proj.setup) and projects per sample.
function toScreen(v: THREE.Vector3, out: { px: number; py: number }): boolean {
	proj.setup(camera!, null, cssW, cssH);
	const p = proj.project(v.x, v.y, v.z);
	if (!p) return false;
	out.px = p.px; out.py = p.py;
	return true;
}

// `contextmenu` only suppresses the browser's menu: macOS/Linux fire it on press, when a click and
// a right-drag pan can't be told apart yet, so the pick runs from the right-button pointerup
// (onPtrUp). OrbitControls adds its own pointerup listener on the same element without stopping
// propagation, so ours still sees the release.
function onContextMenu(ev: MouseEvent) { ev.preventDefault(); }
function pickAt(clientX: number, clientY: number, menuOffset = 0) {
	if (!canvasEl.value || !camera) return;
	const base = { clientX: clientX + menuOffset, clientY: clientY + menuOffset };   // where the menu opens; the pick stays under the finger
	const g = octreeGeometry();
	if (!g) {
		// The cache is here but the manifest fetch hasn't settled: the geometry isn't known yet, which is not "no cache".
		emit('pointmenu', { ...base, point: null, reason: noGeometryReason(!!props.sampleCache?.N, buildReady) });
		return;
	}
	if (!g.win) { emit('pointmenu', { ...base, point: null, reason: 'outside-cache' }); return; }
	const c = g.c;
	const r = canvasEl.value.getBoundingClientRect();
	camera.updateMatrixWorld();   // controls.update() moved it since the last render
	readZ(c);   // hoisted: read the uniforms once, not per sample
	// Gridded octrees (`fill`) still pick the nearest SAMPLE to the spot: cells aren't samples.
	proj.setup(camera, null, cssW, cssH);
	const px = clientX - r.left, py = clientY - r.top, radius = pickRadius(props.pointSize);
	// Only the flat top-down view can skip samples by radius: with a Z series the view tilts and
	// the height moves points, so a sample's distance from the click isn't its radius difference.
	const cull = zMap.on ? null : proj.discAt(px, py, radius);
	const hit = pickSpiral(c, g.path, g.cs, g.ce, 1, (x, y, i) => proj.project(x, y, zAt(i)),
		px, py, radius, displayedKeepIndex(c[props.axis], props.colorScale), cull, g.anchor);
	emit('pointmenu', { ...base, point: hit ? pointInfo(c, hit.i, hit.x, hit.y, hit.rho) : null });
}

// World position of the sample at time `sec` into _v (Z as the shader draws it); false when there
// is none (no cache, outside the octree's cut window or the cache's, or past the inner-diameter cut-out).
const _pos: SpiralPos = { x: 0, y: 0, rho: 0, visible: false };
function timeToWorld(sec: number | null | undefined): boolean {
	const g = octreeGeometry();
	if (sec == null || !g || !g.win || sec < g.win.start || sec > g.win.end) return false;
	const c = g.c;
	const i = nearestIndex(c.t, sec);
	spiralPositionInto(g.u, c.t[i], c.revs[i], g.cs, g.ce, _pos);
	if (!_pos.visible) return false;
	readZ(c);
	_v.set(_pos.x, _pos.y, zAt(i));
	return true;
}

// Ring overlays (CSS px in the canvas box). The render loop runs every frame, so the rings are
// placed there: two O(log N) lookups, and settleRing keeps idle frames from touching reactivity.
const markRing = ref<{ x: number; y: number } | null>(null);
const hoverRing = ref<{ x: number; y: number } | null>(null);
function ringPos(sec: number | null | undefined, cur: { x: number; y: number } | null) {
	return timeToWorld(sec) && toScreen(_v, _pt) ? settleRing(cur, _pt.px, _pt.py) : null;
}
function updateRings() {
	if (!camera) return;
	if (props.markTime == null && props.hoverTime == null) {
		if (markRing.value) markRing.value = null;
		if (hoverRing.value) hoverRing.value = null;
		return;
	}
	camera.updateMatrixWorld();
	markRing.value = ringPos(props.markTime, markRing.value);
	hoverRing.value = ringPos(props.hoverTime, hoverRing.value);
}

// Bring the sample at time t into view (pans the target and camera together so the view angle
// is unchanged).
//
// Returns false only when there is definitely no sample for t (outside the octree's window, past
// the inner cut-out). While the view isn't ready (octree still loading, no sample cache yet) the
// request is kept in `pendingReveal` and applied by the render loop once both exist, and true is
// returned: the host asked in good faith and has nothing to retry.
const pendingReveal = createPendingReveal();
function revealTime(t: number): boolean {
	const g = octreeGeometry();
	if (g && (!g.win || t < g.win.start || t > g.win.end)) { pendingReveal.drop(); return false; }
	if (!g || !camera || !controls || !pco || loading.value) { pendingReveal.hold(t); return true; }
	pendingReveal.drop();
	return revealNow(t);
}
function applyPendingReveal() {
	if (!pendingReveal.held || loading.value || !octreeGeometry()) return;   // none, or not ready: keep it for the next frame
	revealNow(pendingReveal.take()!);
}
// A different octree or cache is a different cut: a reveal asked for the old one means nothing.
// (Not when the cache goes from none to some: that is what the pending reveal waits for.)
watch(() => props.sampleCache, (_n, old) => { if (old) pendingReveal.drop(); });
function revealNow(t: number): boolean {
	if (!camera || !controls || !timeToWorld(t)) return false;
	camera.updateMatrixWorld();
	const d = _v.clone().sub(controls.target);   // a rare call: allocation is fine here
	if (toScreen(_v, _pt)) return true;   // already in view
	if (!zMap.on) d.z = 0;
	controls.target.add(d); camera.position.add(d);
	controls.update(); invalidate();
	return true;
}

function sizeCanvas() {
	const canvas = canvasEl.value; if (!canvas) return;
	const r = canvas.getBoundingClientRect();
	cssW = Math.max(1, r.width); cssH = Math.max(1, r.height);
	renderer?.setSize(cssW, cssH, false);
}

let ro: ResizeObserver | undefined;
// Bumped on reactivation: teardown force-loses the GL context and a canvas never gets a lost
// context back, so the template swaps in a new element (see glLifecycle.ts).
const canvasKey = ref(0);
function boot() {
	setupGL();
	if (canvasEl.value) ro?.observe(canvasEl.value);
	load();
}
// Stops the rAF/Potree loop, frees the octree's GPU memory and the GL context, and makes any load
// still in flight stale. Runs on unmount AND on deactivate: this viewer lives inside the kept-alive
// Plot route (#24/#57), so without the deactivate half it kept streaming (up to ~25M points of GPU
// memory) while the operator was on the Record page (review 3.6).
function teardownGL() {
	loadToken.cancel();
	longPress.cancel();   // a canvas swap loses the old canvas's pointerups: forget its touches
	// The stage watcher is already stopped on unmount: say "idle" directly so the host's busy bar clears.
	if (stage.value) emit('stage', null);
	stage.value = null;
	if (raf) cancelAnimationFrame(raf);
	raf = 0;
	const c = canvasEl.value;
	if (c) {
		c.removeEventListener('pointerdown', onPtrDown);
		c.removeEventListener('pointermove', onPtrMove);
		c.removeEventListener('pointerup', onPtrUp);
		c.removeEventListener('pointercancel', onPtrUp);
		c.removeEventListener('contextmenu', onContextMenu);
	}
	zPointers.clear();
	ro?.disconnect(); controls?.dispose();
	disposeCloud();
	try { renderer?.forceContextLoss(); } catch { /* ignore */ }   // release the GL context (not freed by dispose())
	renderer?.dispose();
	renderer = null; scene = null; camera = null; controls = null; potree = null;
	loading.value = true;
}
const life = createGlLifecycle({
	teardown: teardownGL,
	replaceCanvas: () => { canvasKey.value++; error.value = null; },
	start: () => nextTick(boot),
});
onMounted(() => {
	ro = new ResizeObserver(() => { sizeCanvas(); frameCamera(); });
	nextTick(boot);
});
onBeforeUnmount(() => { longPress.cancel(); life.unmount(); });
onDeactivated(() => { longPress.cancel(); life.deactivate(); });   // a finger down as the page hides never sends its pointerup here
onActivated(() => { life.activate(); });

watch(() => props.octreePath, () => { pendingReveal.drop(); load(); });
watch(() => props.axis, () => { if (material) { material.uniforms.uAxis.value = AXIS_IDX[props.axis] ?? 2; emitAutoRange(); } });
// LUT bytes resync only when lutKey changes; saturation/displayed-range/grey-vs-hide are uniforms.
watch(() => props.colorScale, (s) => {
	if (!material) return;
	syncScaleTexture(material.uniforms.uGradient.value, s);
	applyRange();
}, { deep: true });
watch(() => props.pointSize, () => { if (material) { material.uniforms.uSize.value = props.pointSize || 1.5; invalidate(); } });
watch(() => [props.fill, props.cellSize], () => {
	if (material) {
		material.uniforms.uFill.value = props.fill ? 1 : 0;
		material.uniforms.uCell.value = props.cellSize || 1;
		invalidate();
	}
});
watch(() => [props.zSeries, props.zScale], applyZ);

// The world rectangle (mm) the orthographic camera currently shows (pan target ± half the
// zoom-scaled frustum). Meaningful in the flat 2D view; the export is a 2D figure anyway.
function currentBounds(): { xmin: number; xmax: number; ymin: number; ymax: number } {
	if (!camera) return { xmin: -1, xmax: 1, ymin: -1, ymax: 1 };
	const cx = controls?.target.x ?? camera.position.x;
	const cy = controls?.target.y ?? camera.position.y;
	const hw = (camera.right - camera.left) / 2 / (camera.zoom || 1);
	const hh = (camera.top - camera.bottom) / 2 / (camera.zoom || 1);
	return { xmin: cx - hw, xmax: cx + hw, ymin: cy - hh, ymax: cy + hh };
}
// Export the current view as a formatted FRM figure (client-side, no host round-trip). The
// render loop paints every frame + preserveDrawingBuffer is on, so the canvas pixels are live.
function exportViewport(filename: string, subtitle?: string) {
	const c = canvasEl.value;
	if (!c) return false;
	return exportFrmFigure({
		canvas: c, bounds: currentBounds(),
		cmin: appliedLo, cmax: appliedHi, colorScale: props.colorScale,
		axis: props.axis, subtitle, filename,
	});
}
// The time span the map can place samples for (the build's window within the cache): the host uses it
// to say why "Show position on map" is off.
// undefined while that isn't known yet (no sample cache, manifest still loading); null when nothing
// can be mapped (the cache doesn't reach the build's cut start, or doesn't overlap its window).
function timeWindow(): { start: number; end: number } | null | undefined {
	const g = octreeGeometry();
	return g ? g.win : undefined;
}
defineExpose({ currentBounds, exportViewport, revealTime, timeWindow });
</script>

<template>
	<div class="frm-octree">
		<LoadingOverlay v-if="stage" :stage="stage" />
		<div v-if="error" class="fc-msg err"><v-icon name="error" small /> {{ error }}</div>
		<canvas :key="canvasKey" v-show="!error" ref="canvasEl"></canvas>
		<!-- linked-moment rings (shared with FrmCloud); placed by updateRings() -->
		<LinkRings :pin="markRing" :hover="hoverRing" />
		<span v-if="!loading && !error" class="fc-count">{{ pointCount.toLocaleString() }} pts (LOD)</span>
	</div>
</template>

<style scoped>
.frm-octree { position: relative; width: 100%; height: 100%; min-height: 160px; background: var(--plot-bg, #0b1020); border-radius: 6px; overflow: hidden; }
.frm-octree canvas { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
.frm-octree canvas:active { cursor: grabbing; }
.fc-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--text-dim, #94a3b8); }
.fc-msg.err { color: var(--danger, #fca5a5); font-size: var(--fs-sm, 12px); padding: 12px; text-align: center; }
.fc-count { position: absolute; right: 6px; bottom: 4px; font-size: var(--fs-xs, 11px); color: var(--text-dim, rgba(255,255,255,0.6)); font-variant-numeric: tabular-nums; }
</style>
