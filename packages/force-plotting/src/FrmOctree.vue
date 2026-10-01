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
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Potree, type PointCloudOctree } from 'potree-core';
import type { ColorScale } from './colorScale';
import { createScaleTexture, syncScaleTexture } from './scaleTexture';
import { exportFrmFigure } from './frmExport';
import { useForceHost } from './host';

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
}>();
const emit = defineEmits<{
	(e: 'climits', v: { cmin: number; cmax: number }): void;
	(e: 'points', n: number): void;   // LOD-visible point count (for the resolution readout)
	(e: 'zscale', v: number): void;   // 3-finger vertical swipe adjusts the Z exaggeration
}>();

const canvasEl = ref<HTMLCanvasElement | null>(null);
const loading = ref(true);
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

async function loadMeta(base: string) {
	try {
		// no-store: this metadata drives the colour limits; never risk a stale cached copy
		// (a pre-repatch metadata.json would show the wrong, un-clipped colour range).
		const res = await fetch(`${base}metadata.json`, { cache: 'no-store' });
		const meta = await res.json();
		for (const a of meta.attributes || []) {
			if (a.name in ranges && Array.isArray(a.min) && Array.isArray(a.max)) {
				ranges[a.name] = [Number(a.min[0]), Number(a.max[0])];
			}
		}
	} catch { /* fall back to defaults */ }
}

async function load() {
	loading.value = true; error.value = null;
	// The octree host is configured, not assumed to be the SPA origin: the standalone app is
	// served from a different origin than the octree server, while the Directus module is
	// same-origin. The host supplies whichever applies.
	const base = `${useForceHost().octreeUrl}/${props.octreePath}/`;
	try {
		await loadMeta(base);
		potree = new Potree();
		potree.maxNumNodesLoading = 12;   // parallelise node fetches so full-res streams in faster
		// "Full-res" must mean full res: budget the LOD to cover the whole octree (a small
		// headroom factor so the top level isn't shaved off), not a fixed 3M cap that left
		// large maps showing ~49%. Capped for GPU safety on the biggest maps.
		potree.pointBudget = props.totalPoints && props.totalPoints > 0
			? Math.min(Math.ceil(props.totalPoints * 1.05), props.budgetCap || 25_000_000)
			: 15_000_000;
		pco = await potree.loadPointCloud('metadata.json', base);
		// potree culls any octree node projecting smaller than minNodePixelSize (default
		// 50px) BEFORE the point budget is even considered — so at fit-view every deep
		// leaf is sub-50px and dropped, leaving only coarse levels (~8-50%). "Full-res"
		// must actually be full res, so drop the cutoff to ~1px; the budget above then
		// bounds the total. (Sub-pixel nodes contribute nothing visible anyway.)
		(pco as any).minNodePixelSize = props.minNodePx || 1;
		material = makeMaterial();
		(pco as any).material = material;
		emitAutoRange();
		applyRange();
		scene!.add(pco);
		pco.updateMatrixWorld(true);
		frameCamera();
		applyZ();
		loading.value = false;
	} catch (e: any) {
		error.value = e?.message || 'failed to load octree';
		loading.value = false;
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
	controls.addEventListener('change', invalidate);
	const loop = () => {
		raf = requestAnimationFrame(loop);
		controls!.update();
		if (pco && potree && renderer && camera) {
			const r = potree.updatePointClouds([pco], camera, renderer);
			const n = (r as any)?.numVisiblePoints ?? pointCount.value;
			if (n !== lastVisibleN) { lastVisibleN = n; needsRender = true; }   // nodes streamed in/out
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
	if (ev.pointerType !== 'touch') return;
	zPointers.set(ev.pointerId, ev.clientY);
	if (zPointers.size === 3) { if (controls) controls.enabled = false; zBaseY = avgVals(zPointers); }
}
function onPtrMove(ev: PointerEvent) {
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
	zPointers.delete(ev.pointerId);
	if (zPointers.size < 3 && controls) controls.enabled = true;
}

function sizeCanvas() {
	const canvas = canvasEl.value; if (!canvas) return;
	const r = canvas.getBoundingClientRect();
	cssW = Math.max(1, r.width); cssH = Math.max(1, r.height);
	renderer?.setSize(cssW, cssH, false);
}

let ro: ResizeObserver | undefined;
onMounted(() => {
	ro = new ResizeObserver(() => { sizeCanvas(); frameCamera(); });
	nextTick(() => { setupGL(); if (canvasEl.value) ro!.observe(canvasEl.value); load(); });
});
onBeforeUnmount(() => {
	if (raf) cancelAnimationFrame(raf);
	const c = canvasEl.value;
	if (c) {
		c.removeEventListener('pointerdown', onPtrDown);
		c.removeEventListener('pointermove', onPtrMove);
		c.removeEventListener('pointerup', onPtrUp);
		c.removeEventListener('pointercancel', onPtrUp);
	}
	ro?.disconnect(); controls?.dispose();
	(material?.uniforms.uGradient.value as THREE.Texture | undefined)?.dispose();
	material?.dispose();
	try { renderer?.forceContextLoss(); } catch { /* ignore */ }   // release the GL context (not freed by dispose())
	renderer?.dispose();
});

watch(() => props.octreePath, () => { if (pco) { scene?.remove(pco); pco = null; } load(); });
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
defineExpose({ currentBounds, exportViewport });
</script>

<template>
	<div class="frm-octree">
		<div v-if="loading" class="fc-msg"><v-progress-circular indeterminate small /> streaming full-res…</div>
		<div v-else-if="error" class="fc-msg err"><v-icon name="error" small /> {{ error }}</div>
		<canvas v-show="!error" ref="canvasEl"></canvas>
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
