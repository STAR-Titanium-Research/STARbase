<script setup lang="ts">
/*
 * Flat point render of the diag analysis cloud (the D1AN WorkingSet). Top-down orthographic,
 * one THREE.Points draw call, no LOD.
 *
 * Deviation from the design spec, deliberate: the spec assumed potree-core LOD ("the browser
 * never holds all N points"), but analyse() angular-resamples to 256/rev, so the analysis
 * cloud is 18k-~1M points across every baked cut measured this session -- small enough to hold
 * in one buffer, recolour instantly on a channel switch, and swap wholesale when a preview
 * returns. potree-core's streaming would add latency and complexity for no benefit at this
 * size. DiagOctreeView.vue (potree-core) is retained for Phase D-2's full-resolution view.
 *
 * Two colour modes: continuous channels go through a viridis gradient with an auto 1/99
 * percentile range; clusterMode reads cluster_id categorically from a 12-entry palette with
 * the noise "cluster" (id < 0) dimmed. A selection-dim path multiplies rgb by 0.15 for points
 * outside the active cross-panel selection -- computed in JS (cheap at <=1M) rather than in
 * the shader, since the selection can be any predicate.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ColorScale } from './colorScale';
import { createScaleTexture, syncScaleTexture } from './scaleTexture';
import { CLUSTER_PALETTE } from './clusterPalette';
import { matches, percentileRange } from './selection';
import type { ChannelKey, Selection, WorkingSet } from './selection';
import type { DiagLayer } from './diagLayers';

const props = withDefaults(defineProps<{
	workingSet: WorkingSet | null;
	channel: ChannelKey;
	colorScale: ColorScale;
	pointSize?: number;
	selection?: Selection;
	clusterMode?: boolean;
	layers?: DiagLayer[];
	activeLayerName?: string | null;
	paintMode?: 'off' | 'draw';
}>(), {
	pointSize: 3, selection: null, clusterMode: false,
	layers: () => [], activeLayerName: null, paintMode: 'off',
});

const emit = defineEmits<{
	(e: 'climits', v: { cmin: number; cmax: number }): void;
	(e: 'polygon', ring: [number, number][]): void;
}>();

const draft = ref<[number, number][]>([]);

// Categorical colouring: cluster_id (via the clusterMode prop) OR segment_id (a categorical
// channel). Both are 0-based class ids with -1 = "none", so the same 12-entry palette path
// and the same "aValue < 0 -> grey" shader branch serve both.
const categorical = computed(() => props.clusterMode || props.channel === 'segmentId');

const canvasEl = ref<HTMLCanvasElement | null>(null);
const paintEl = ref<HTMLDivElement | null>(null);
const error = ref<string | null>(null);

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.OrthographicCamera | null = null;
let controls: OrbitControls | null = null;
let geom: THREE.BufferGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;
let points: THREE.Points | null = null;
let raf = 0;
let cssW = 1, cssH = 1;
let needsRender = true;
function invalidate() { needsRender = true; }


function makeMaterial(): THREE.ShaderMaterial {
	const paletteFlat = new Float32Array(CLUSTER_PALETTE.flat());
	const s = props.colorScale;
	return new THREE.ShaderMaterial({
		transparent: true,
		uniforms: {
			uGradient: { value: createScaleTexture(s) },
			uRange: { value: new THREE.Vector2(s.satMin, s.satMax) },
			// Displayed-range filter (separate from uRange, the saturation/colour range): points
			// whose raw value falls outside [uDisp.x, uDisp.y] are either greyed (uGreyOOR>0.5,
			// vColor overridden) or hidden (fragment discard via vHidden) -- never both, and never
			// applied to categorical/cluster mode, which has no continuous "out of range" concept.
			uDisp: { value: new THREE.Vector2(s.dispMin, s.dispMax) },
			uGreyOOR: { value: s.greyOutOfRange ? 1 : 0 },
			uSize: { value: props.pointSize },
			uCluster: { value: categorical.value ? 1 : 0 },
			uPalette: { value: paletteFlat },
			uSelActive: { value: 0 },
		},
		vertexShader: `
			attribute float aValue;
			attribute float aSelected;
			uniform sampler2D uGradient;
			uniform vec2 uRange;
			uniform vec2 uDisp;
			uniform float uGreyOOR;
			uniform float uSize;
			uniform float uCluster;
			uniform float uPalette[36];
			uniform float uSelActive;
			varying vec3 vColor;
			varying float vDim;
			varying float vHidden;
			void main() {
				bool isNan = (aValue != aValue);
				bool outOfDisplay = (!isNan) && (uCluster < 0.5) && (aValue < uDisp.x || aValue > uDisp.y);
				vHidden = (outOfDisplay && uGreyOOR < 0.5) ? 1.0 : 0.0;
				if (isNan) {
					vColor = vec3(0.12);
				} else if (uCluster > 0.5) {
					if (aValue < 0.0) {
						vColor = vec3(0.30);
					} else {
						int idx = int(mod(aValue, 12.0));
						vColor = vec3(uPalette[idx*3], uPalette[idx*3+1], uPalette[idx*3+2]);
					}
				} else {
					float u = clamp((aValue - uRange.x) / max(1e-6, uRange.y - uRange.x), 0.0, 1.0);
					vColor = texture2D(uGradient, vec2(u, 0.5)).rgb;
					if (outOfDisplay && uGreyOOR > 0.5) vColor = vec3(0.5);
				}
				vDim = isNan ? 0.25 : ((uSelActive > 0.5 && aSelected < 0.5) ? 0.15 : 1.0);
				gl_PointSize = uSize;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}
		`,
		fragmentShader: `
			precision mediump float;
			varying vec3 vColor;
			varying float vDim;
			varying float vHidden;
			void main() {
				if (vHidden > 0.5) discard;                     // displayed-range filter, hide mode
				vec2 d = gl_PointCoord - vec2(0.5);
				if (dot(d, d) > 0.25) discard;                 // round points
				gl_FragColor = vec4(vColor * vDim, vDim < 1.0 ? 0.5 : 1.0);
			}
		`,
	});
}

function channelArray(ws: WorkingSet, ch: ChannelKey): Float32Array {
	// CHANNEL_ACCESSOR is a per-index read; for the buffer we want the whole column. The
	// WorkingSet already stores each channel as a Float32Array under the camelCase key.
	return (ws as unknown as Record<string, Float32Array>)[ch];
}

function rebuildGeometry() {
	const ws = props.workingSet;
	geom?.dispose();
	if (!ws || ws.n === 0) { geom = null; if (points) points.visible = false; invalidate(); return; }
	geom = new THREE.BufferGeometry();
	const pos = new Float32Array(ws.n * 3);
	for (let i = 0; i < ws.n; i++) { pos[i * 3] = ws.x[i]; pos[i * 3 + 1] = ws.y[i]; pos[i * 3 + 2] = 0; }
	geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	geom.setAttribute('aValue', new THREE.BufferAttribute(new Float32Array(ws.n), 1));
	geom.setAttribute('aSelected', new THREE.BufferAttribute(new Float32Array(ws.n), 1));
	if (points) { points.geometry = geom; points.visible = true; }
	packValue();
	packSelected();
	frameCamera();
}

function packValue() {
	const ws = props.workingSet;
	if (!geom || !ws || !material) return;
	const col = channelArray(ws, props.channel);
	const attr = geom.getAttribute('aValue') as THREE.BufferAttribute;
	(attr.array as Float32Array).set(col.subarray(0, ws.n));
	attr.needsUpdate = true;
	if (!categorical.value) {
		// Detected purely from the data, for the host to seed a fresh ColorScale (colorScale.ts's
		// defaultScale/applyParams) on a channel switch. What is actually RENDERED always comes
		// from props.colorScale via the watcher below, never from this detection directly -- unlike
		// before this conversion, packValue() no longer writes to uRange itself.
		const [lo, hi] = percentileRange(col.subarray(0, ws.n));
		emit('climits', { cmin: lo, cmax: hi });
	}
	invalidate();
}

function packSelected() {
	const ws = props.workingSet;
	if (!geom || !ws || !material) return;
	const attr = geom.getAttribute('aSelected') as THREE.BufferAttribute;
	const arr = attr.array as Float32Array;
	const active = props.selection != null;
	for (let i = 0; i < ws.n; i++) arr[i] = matches(ws, props.selection ?? null, i) ? 1 : 0;
	attr.needsUpdate = true;
	material.uniforms.uSelActive.value = active ? 1 : 0;
	invalidate();
}

function frameCamera() {
	const ws = props.workingSet;
	if (!camera || !controls || !ws || ws.n === 0) return;
	let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
	for (let i = 0; i < ws.n; i++) {
		if (!Number.isFinite(ws.x[i]) || !Number.isFinite(ws.y[i])) continue;
		if (ws.x[i] < xmin) xmin = ws.x[i]; if (ws.x[i] > xmax) xmax = ws.x[i];
		if (ws.y[i] < ymin) ymin = ws.y[i]; if (ws.y[i] > ymax) ymax = ws.y[i];
	}
	if (!Number.isFinite(xmin)) return;
	const cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2;
	const span = Math.max(xmax - xmin, ymax - ymin, 1) * 1.08;
	const aspect = cssW / cssH;
	camera.left = (-span / 2) * aspect; camera.right = (span / 2) * aspect;
	camera.top = span / 2; camera.bottom = -span / 2;
	camera.position.set(cx, cy, 1e5); camera.up.set(0, 1, 0); camera.lookAt(cx, cy, 0);
	camera.zoom = 1; camera.updateProjectionMatrix();
	controls.target.set(cx, cy, 0); controls.update();
	invalidate();
}

// --- paint layers ------------------------------------------------------------------------
// Saved layers render as THREE.LineLoop rings (one material per role colour). Drawing happens
// on a transparent sibling <div> (template) so OrbitControls never contends for the pointer;
// controls.enabled is also flipped off while paintMode === 'draw'. canvasToWorld unprojects a
// screen point to angular-grid mm via the same ortho camera the points use.
let overlayGroup: THREE.Group | null = null;
let draftLine: THREE.Line | null = null;
const ROLE_COLOR: Record<string, number> = { mask: 0xf59e0b, label: 0x38bdf8, seed: 0xa78bfa };

function canvasToWorld(clientX: number, clientY: number): [number, number] {
	const el = canvasEl.value!;
	const r = el.getBoundingClientRect();
	const nx = ((clientX - r.left) / r.width) * 2 - 1;
	const ny = -(((clientY - r.top) / r.height) * 2 - 1);
	const v = new THREE.Vector3(nx, ny, 0).unproject(camera!);
	return [v.x, v.y];
}

function redrawDraft() {
	if (!scene) return;
	if (draftLine) { scene.remove(draftLine); (draftLine.geometry as THREE.BufferGeometry).dispose(); draftLine = null; }
	if (draft.value.length >= 2) {
		const pts = draft.value.map(([x, y]) => new THREE.Vector3(x, y, 2));
		const mat = new THREE.LineBasicMaterial({ color: 0xffffff });
		draftLine = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), mat);
		scene.add(draftLine);
	}
	invalidate();
}

function onPaintClick(ev: PointerEvent) {
	if (props.paintMode !== 'draw' || !camera) return;
	draft.value = [...draft.value, canvasToWorld(ev.clientX, ev.clientY)];
	redrawDraft();
}
function finishRing() {
	if (draft.value.length >= 3) emit('polygon', draft.value.slice());
	draft.value = [];
	redrawDraft();
}
function cancelRing() {
	draft.value = [];
	redrawDraft();
}

function rebuildOverlay() {
	if (!scene) return;
	if (overlayGroup) {
		scene.remove(overlayGroup);
		overlayGroup.traverse((o) => {
			const m = o as THREE.Mesh;
			m.geometry?.dispose?.();
			(m.material as THREE.Material | undefined)?.dispose?.();
		});
	}
	overlayGroup = new THREE.Group();
	for (const layer of props.layers ?? []) {
		const isActive = layer.name === props.activeLayerName;
		const mat = new THREE.LineBasicMaterial({
			color: ROLE_COLOR[layer.role] ?? 0xffffff,
			transparent: true,
			opacity: isActive ? 1 : 0.55,
		});
		for (const ring of layer.geometry?.polygons ?? []) {
			const pts = ring.map(([x, y]) => new THREE.Vector3(x, y, 1));
			if (pts.length >= 2) overlayGroup.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), mat));
		}
	}
	scene.add(overlayGroup);
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
	controls.addEventListener('change', invalidate);
	material = makeMaterial();
	points = new THREE.Points(new THREE.BufferGeometry(), material);
	points.frustumCulled = false;
	scene.add(points);
	rebuildGeometry();
	rebuildOverlay();
	controls.enabled = props.paintMode !== 'draw';
	const loop = () => {
		raf = requestAnimationFrame(loop);
		controls!.update();
		if (!needsRender || !renderer || !camera || !scene) return;
		needsRender = false;
		renderer.render(scene, camera);
	};
	loop();
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
	nextTick(() => { setupGL(); if (canvasEl.value) ro!.observe(canvasEl.value); });
});
onBeforeUnmount(() => {
	if (raf) cancelAnimationFrame(raf);
	ro?.disconnect(); controls?.dispose();
	if (overlayGroup) overlayGroup.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); (m.material as THREE.Material | undefined)?.dispose?.(); });
	(draftLine?.geometry as THREE.BufferGeometry | undefined)?.dispose?.();
	geom?.dispose(); material?.dispose();
	(material?.uniforms.uGradient.value as THREE.Texture | undefined)?.dispose();
	try { renderer?.forceContextLoss(); } catch { /* ignore */ }
	renderer?.dispose();
});

watch(() => props.workingSet, rebuildGeometry);
watch([() => props.channel, categorical], () => {
	if (material) material.uniforms.uCluster.value = categorical.value ? 1 : 0;
	packValue();
});
// LUT bytes resync only when lutKey changes; saturation/displayed-range/grey-vs-hide are uniforms.
watch(() => props.colorScale, (s) => {
	if (!material) return;
	syncScaleTexture(material.uniforms.uGradient.value, s);
	material.uniforms.uRange.value.set(s.satMin, s.satMax);
	material.uniforms.uDisp.value.set(s.dispMin, s.dispMax);
	material.uniforms.uGreyOOR.value = s.greyOutOfRange ? 1 : 0;
	invalidate();
}, { deep: true });
watch(() => props.pointSize, () => { if (material) { material.uniforms.uSize.value = props.pointSize; invalidate(); } });
watch(() => props.selection, packSelected, { deep: true });
watch(() => [props.layers, props.activeLayerName], rebuildOverlay, { deep: true });
watch(() => props.paintMode, () => {
	if (controls) controls.enabled = props.paintMode !== 'draw';
	if (props.paintMode !== 'draw') cancelRing();
	else nextTick(() => paintEl.value?.focus());
});
</script>

<template>
	<div class="diag-scatter">
		<div v-if="error" class="ds-msg err">{{ error }}</div>
		<div v-else-if="!workingSet" class="ds-msg">no analysis loaded</div>
		<canvas v-show="!error" ref="canvasEl"></canvas>
		<div
			v-if="paintMode === 'draw'"
			ref="paintEl"
			class="ds-paint"
			tabindex="0"
			@pointerdown.prevent="onPaintClick"
			@keyup.enter="finishRing"
			@keyup.esc="cancelRing"
		>
			<span class="ds-paint-hint">
				click to add points · Enter to close ({{ draft.length }}) · Esc to cancel
			</span>
		</div>
		<span v-if="workingSet && !error" class="ds-count">{{ workingSet.n.toLocaleString() }} pts</span>
	</div>
</template>

<style scoped>
.diag-scatter { position: relative; width: 100%; height: 100%; min-height: 160px; background: var(--plot-bg, #0b1020); border-radius: 6px; overflow: hidden; }
.diag-scatter canvas { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
.ds-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text-dim, #94a3b8); font-size: var(--fs-sm, 12px); }
.ds-msg.err { color: var(--danger, #fca5a5); }
.ds-count { position: absolute; right: 8px; bottom: 6px; font-size: var(--fs-xs, 11px); color: var(--text-dim, #94a3b8); background: rgba(0,0,0,0.35); padding: 1px 5px; border-radius: 4px; font-variant-numeric: tabular-nums; }
.ds-paint { position: absolute; inset: 0; cursor: crosshair; outline: none; }
.ds-paint-hint { position: absolute; left: 8px; top: 6px; font-size: var(--fs-xs, 11px); color: #fcd34d; background: rgba(0,0,0,0.5); padding: 2px 6px; border-radius: 4px; pointer-events: none; }
</style>
