<script setup lang="ts">
/*
 * Diagnostics octree viewer. Streams a host-built Potree octree with potree-core LOD, top-down
 * orthographic, and colours it with OUR OWN ShaderMaterial that reads the diag attributes
 * (tsa_resid, resid_z) and applies viridis — bypassing potree-core 2.0.15's broken 2.0-octree
 * colour pipeline, same as FrmOctree.vue. potree-core is used purely for octree management/
 * streaming. Only analyse()'s own columns are ever registered as LAS extra dims by
 * process_diag_row (see scripts/force_orchestrator.py) — Fx/Fy/Fz are deliberately NOT among
 * the channel options here, unlike FrmOctree.vue's raw-cloud octrees which do carry them.
 *
 * This is FrmOctree.vue's pattern generalized two ways: the axis uniform becomes a wider
 * "channel" uniform covering the diag attributes too, and a selection-highlight uniform dims
 * points outside the active cross-panel selection (time / attribute-threshold; spatial lasso's
 * shader side is deferred — see selection.ts). Z-height and grid-fill are FrmOctree-specific
 * features not needed here and are not carried over.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Potree, type PointCloudOctree } from 'potree-core';
import { defaultScale, OPEN_DISP, type ColorScale } from './colorScale';
import { createScaleTexture, syncScaleTexture } from './scaleTexture';
import { CLUSTER_PALETTE } from './clusterPalette';
import { useForceHost } from './host';
import { percentileRange, type Selection } from './selection';
import type { DiagLayer } from './diagLayers';
import type { ViewportResult } from './diagViewport';

const props = defineProps<{
	octreePath: string;                       // served subdir: /octrees/diag/<octreePath>/
	channel: 'tsaResid' | 'residZ';
	colorScale: ColorScale;
	pointSize: number;
	totalPoints?: number;                     // octree's full point count -> sizes the LOD budget
	minNodePx?: number;                       // Potree LOD cutoff (settings; default 1)
	budgetCap?: number;                       // Potree point-budget hard cap (settings; default 25M)
	selection?: Selection;
	// Phase G: a full-resolution viewport recompute (Gi* / cluster_id / segment_id on the
	// framed region), rendered as a flat THREE.Points ABOVE the octree in this same scene --
	// a second canvas would need its own WebGL context and camera sync.
	analysisResult?: ViewportResult | null;
	analysisMode?: 'continuous' | 'categorical';
	/** Isolate one categorical class in the overlay (a cluster/segment id); null shows all.
	 *  Only the overlay honours this -- the base octree's shader has no per-class attribute,
	 *  so the underlying resid_z map stays fully visible as context. */
	isolateClass?: number | null;
	// Phase G: paint layers, ported verbatim from DiagScatter (same top-down ortho unproject).
	layers?: DiagLayer[];
	activeLayerName?: string | null;
	paintMode?: 'off' | 'draw';
}>();
const emit = defineEmits<{
	(e: 'climits', v: { cmin: number; cmax: number }): void;
	(e: 'points', n: number): void;   // LOD-visible point count (for the resolution readout)
	(e: 'polygon', ring: [number, number][]): void;
	// the x/y mm rectangle the camera currently shows -- emitted UNDEBOUNCED on every camera
	// change; the workbench owns the single settle debounce before it fires a viewport compute.
	(e: 'bounds', b: [number, number, number, number]): void;
}>();

const canvasEl = ref<HTMLCanvasElement | null>(null);
const paintEl = ref<HTMLDivElement | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const pointCount = ref(0);
const draft = ref<[number, number][]>([]);

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
// per-channel value ranges (from the octree metadata) for auto colour limits. Keyed by the
// prop's camelCase channel names; ATTR_NAME maps each to the octree's actual (snake_case) LAS
// extra-dim attribute name for matching against metadata.json's `attributes[].name`.
const ranges: Record<string, [number, number]> = { tsaResid: [0, 1], residZ: [0, 1] };
const ATTR_NAME: Record<string, string> = { tsaResid: 'tsa_resid', residZ: 'resid_z' };
const CHANNEL_IDX: Record<string, number> = { tsaResid: 0, residZ: 1 };
const SEL_KIND_IDX: Record<string, number> = { time: 1, attribute: 2, lasso: 3 };

// One material reads tsa_resid/resid_z; a uChannel uniform selects which drives the colour, and
// uRange normalises it before the viridis lookup. A separate selection-highlight
// path (uSelKind/uSelTimeRange/uSelAttrRange/uSelAttrChannel) dims points outside the active
// cross-panel selection -- evaluated per-vertex here rather than in JS, since re-testing every
// rendered point against the WorkingSet on every camera move would defeat LOD streaming
// entirely. Only 'time' and 'attribute' selections are wired into the shader; a spatial 'lasso'
// selection needs a variable-length polygon uniform (or a texture-encoded polygon), real
// complexity deferred to a later pass -- passing one here has no visible effect on this view
// (it still drives Panel A / the Inspector via the JS-side matches()/computeStats()).
function makeMaterial(): THREE.ShaderMaterial {
	const s = props.colorScale;
	const m = new THREE.ShaderMaterial({
		uniforms: {
			uGradient: { value: createScaleTexture(s) },
			uRange: { value: new THREE.Vector2(s.satMin, s.satMax) },
			// Displayed-range filter, separate from uRange (saturation/colour): out-of-range points
			// are greyed (uGreyOOR>0.5) or discarded -- independent of the selection-dim path below.
			uDisp: { value: new THREE.Vector2(s.dispMin, s.dispMax) },
			uGreyOOR: { value: s.greyOutOfRange ? 1 : 0 },
			uChannel: { value: CHANNEL_IDX[props.channel] ?? 1 },
			uSize: { value: props.pointSize || 1.5 },
			uSelKind: { value: 0 },                          // 0=none, 1=time, 2=attribute, 3=lasso
			uSelTimeRange: { value: new THREE.Vector2(0, 0) },
			uSelAttrRange: { value: new THREE.Vector2(0, 0) },
			uSelAttrChannel: { value: 0 },                   // 0=residZ, 1=tsaResid
		},
		vertexShader: `
			attribute float tsa_resid; attribute float resid_z;
			attribute float t;
			uniform vec2 uRange; uniform float uChannel; uniform float uSize;
			uniform float uSelKind;
			uniform vec2 uSelTimeRange;
			uniform vec2 uSelAttrRange;
			uniform float uSelAttrChannel;
			uniform vec2 uDisp;
			varying float vT;
			varying float vOut;   // 1 = outside the displayed range
			varying float vSelected;
			float pick(float i) {
				if (i < 0.5) return tsa_resid;
				return resid_z;
			}
			void main() {
				float v = pick(uChannel);
				// Tested here, in the (highp) vertex stage: the mediump fragment stage can be real
				// fp16, which quantises a range edge and overflows OPEN_DISP to inf.
				vOut = (v < uDisp.x || v > uDisp.y) ? 1.0 : 0.0;
				vT = clamp((v - uRange.x) / max(1e-6, uRange.y - uRange.x), 0.0, 1.0);
				vSelected = 1.0;
				if (uSelKind > 0.5 && uSelKind < 1.5) {
					vSelected = (t >= uSelTimeRange.x && t <= uSelTimeRange.y) ? 1.0 : 0.0;
				} else if (uSelKind > 1.5 && uSelKind < 2.5) {
					float av = uSelAttrChannel < 0.5 ? resid_z : tsa_resid;
					vSelected = (av >= uSelAttrRange.x && av <= uSelAttrRange.y) ? 1.0 : 0.0;
				}
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, 0.0, 1.0);
				gl_PointSize = uSize;
			}`,
		fragmentShader: `
			precision mediump float;
			uniform sampler2D uGradient; uniform float uGreyOOR;
			varying float vT; varying float vOut; varying float vSelected;
			void main() {
				vec2 d = gl_PointCoord - vec2(0.5); if (dot(d, d) > 0.25) discard;
				bool outOfDisplay = vOut > 0.5;
				if (outOfDisplay && uGreyOOR < 0.5) discard;
				vec3 c = outOfDisplay ? vec3(0.5) : texture2D(uGradient, vec2(vT, 0.5)).rgb;
				// Unselected points stay visible but muted -- an empty or wrong selection must
				// never read as "the map failed to load". Orthogonal to the displayed-range grey
				// above -- a point can be both greyed (out of range) and dimmed (unselected).
				float a = mix(0.15, 1.0, vSelected);
				gl_FragColor = vec4(c, a);
			}`,
	});
	(m as any).updateMaterial = () => { /* potree calls this per frame; fixed-size = no-op */ };
	return m;
}

// Shared teardown for the two GPU resources this component owns outright (potree-core owns
// `pco`'s own geometry buffers via its own dispose(), but never touches OUR material/texture).
// Used both on unmount and whenever octreePath swaps in a new octree -- without this, switching
// between operations leaked a full material + gradient texture + the old octree's geometry
// buffers on every switch, pushing the GL context toward exhaustion over a long session.
function disposeMaterial() {
	if (!material) return;
	(material.uniforms.uGradient.value as THREE.Texture | undefined)?.dispose();
	material.dispose();
	material = null;
}
function disposePco() {
	if (!pco) return;
	scene?.remove(pco);
	pco.dispose();
	pco = null;
}

function applyRange() {
	if (!material) return;
	const s = props.colorScale;
	material.uniforms.uRange.value.set(s.satMin, s.satMax > s.satMin ? s.satMax : s.satMin + 1);
	material.uniforms.uDisp.value.set(s.dispMin, s.dispMax);
	material.uniforms.uGreyOOR.value = s.greyOutOfRange ? 1 : 0;
	invalidate();
}
// The octree's OWN per-channel metadata range, detected independently of whatever is currently
// applied -- lets a host reseed a fresh ColorScale on a channel switch. Same "climits reports the
// data, colorScale drives the render" split as FrmOctree.vue / DiagScatter.vue.
function emitAutoRange() {
	const auto = ranges[props.channel] || [0, 1];
	emit('climits', { cmin: auto[0], cmax: auto[1] });
}

function applySelection() {
	if (!material) return;
	const sel = props.selection;
	if (!sel) {
		material.uniforms.uSelKind.value = 0;
		invalidate();
		return;
	}
	material.uniforms.uSelKind.value = SEL_KIND_IDX[sel.kind];
	if (sel.kind === 'time') {
		material.uniforms.uSelTimeRange.value.set(sel.t0, sel.t1);
	} else if (sel.kind === 'attribute') {
		material.uniforms.uSelAttrRange.value.set(sel.min, sel.max);
		material.uniforms.uSelAttrChannel.value = sel.column === 'residZ' ? 0 : 1;
	}
	invalidate();
}

// --- Phase G: full-resolution analysis overlay -----------------------------------------
// A separate THREE.Points (not potree-managed) fed by props.analysisResult. Reuses
// DiagScatter's viridis / cluster-palette shader, minus the selection-dim path.
let analysisPoints: THREE.Points | null = null;

function makeAnalysisMaterial(): THREE.ShaderMaterial {
	const paletteFlat = new Float32Array(CLUSTER_PALETTE.flat());
	const categorical = props.analysisMode === 'categorical';
	return new THREE.ShaderMaterial({
		transparent: true,
		uniforms: {
			uGradient: { value: createScaleTexture(defaultScale(0, 1)) },   // rebuilt to the real range below
			uRange: { value: new THREE.Vector2(0, 1) },
			// Displayed-range filter, wired for parity with the base octree material, but held
			// permanently open (+-OPEN_DISP) here: this overlay has no host-driven ColorScale or
			// editor yet (unlike the base octree, whose scale comes from props.colorScale) -- an
			// auto percentile-derived displayed range would silently start greying the very 1%/99%
			// tails this overlay's own auto-ranging already clips colour at, with no UI to see or
			// undo it. Ready for a future pass that gives this overlay its own scale. Finite
			// sentinel, not literal Infinity -- see colorScale.ts's OPEN_DISP doc comment (GLSL ES
			// 1.00 does not guarantee IEEE Infinity semantics in a uniform).
			uDisp: { value: new THREE.Vector2(-OPEN_DISP, OPEN_DISP) },
			uGreyOOR: { value: 1 },
			uSize: { value: (props.pointSize || 1.5) + 1.5 },   // read on top of the octree
			uCluster: { value: categorical ? 1 : 0 },
			uPalette: { value: paletteFlat },
			// -9999 = "no isolation". A sentinel rather than a second bool uniform because a
			// valid class id is any integer >= -1 (noise), so 0 cannot mean "off".
			uIsolate: { value: props.isolateClass ?? -9999 },
		},
		vertexShader: `
			attribute float aValue;
			uniform sampler2D uGradient;
			uniform vec2 uRange;
			uniform vec2 uDisp;
			uniform float uGreyOOR;
			uniform float uSize;
			uniform float uCluster;
			uniform float uPalette[36];
			uniform float uIsolate;
			varying vec3 vColor;
			varying float vDim;
			varying float vHidden;
			void main() {
				bool isNan = (aValue != aValue);
				bool outOfDisplay = (!isNan) && (uCluster < 0.5) && (aValue < uDisp.x || aValue > uDisp.y);
				vHidden = (outOfDisplay && uGreyOOR < 0.5) ? 1.0 : 0.0;
				if (isNan) {
					vColor = vec3(0.12); vDim = 0.25;
				} else if (uCluster > 0.5) {
					if (aValue < 0.0) { vColor = vec3(0.30); }
					else {
						int idx = int(mod(aValue, 12.0));
						vColor = vec3(uPalette[idx*3], uPalette[idx*3+1], uPalette[idx*3+2]);
					}
					// Isolating a cluster fades the others right down rather than hiding them,
					// so the isolated region is still read in the context of the whole map.
					vDim = (uIsolate < -9000.0 || abs(aValue - uIsolate) < 0.5) ? 1.0 : 0.08;
				} else {
					float u = clamp((aValue - uRange.x) / max(1e-6, uRange.y - uRange.x), 0.0, 1.0);
					vColor = texture2D(uGradient, vec2(u, 0.5)).rgb;
					if (outOfDisplay && uGreyOOR > 0.5) vColor = vec3(0.5);
					vDim = 1.0;
				}
				gl_PointSize = uSize;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}`,
		fragmentShader: `
			precision mediump float;
			varying vec3 vColor; varying float vDim; varying float vHidden;
			void main() {
				if (vHidden > 0.5) discard;
				vec2 d = gl_PointCoord - vec2(0.5);
				if (dot(d, d) > 0.25) discard;
				gl_FragColor = vec4(vColor * vDim, vDim < 1.0 ? 0.5 : 1.0);
			}`,
	});
}

function disposeAnalysis() {
	if (!analysisPoints) return;
	scene?.remove(analysisPoints);
	analysisPoints.geometry.dispose();
	const m = analysisPoints.material as THREE.ShaderMaterial;
	(m.uniforms.uGradient.value as THREE.Texture | undefined)?.dispose();
	m.dispose();
	analysisPoints = null;
}

function rebuildAnalysis() {
	disposeAnalysis();
	const r = props.analysisResult;
	// r.value is absent when the caller requested `outputs` instead of the legacy single
	// column (see diagViewport.ts) -- this view only ever renders one column, so it has
	// nothing to draw in that case rather than something to guess at.
	if (!r || r.n === 0 || !scene || !r.value) { invalidate(); return; }
	const value = r.value;
	const g = new THREE.BufferGeometry();
	const pos = new Float32Array(r.n * 3);
	for (let i = 0; i < r.n; i++) { pos[i * 3] = r.x[i]; pos[i * 3 + 1] = r.y[i]; pos[i * 3 + 2] = 1; }
	g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	g.setAttribute('aValue', new THREE.BufferAttribute(Float32Array.from(value), 1));
	const mat = makeAnalysisMaterial();
	if (props.analysisMode !== 'categorical') {
		const [lo, hi] = percentileRange(value);
		mat.uniforms.uRange.value.set(lo, hi);
	}
	analysisPoints = new THREE.Points(g, mat);
	analysisPoints.renderOrder = 1;
	analysisPoints.frustumCulled = false;
	scene.add(analysisPoints);
	invalidate();
}

// --- Phase G: paint layers (ported verbatim from DiagScatter.vue) -----------------------
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
	if ((props.paintMode ?? 'off') !== 'draw' || !camera) return;
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

function disposeOverlay() {
	if (overlayGroup) {
		overlayGroup.traverse((o) => {
			const m = o as THREE.Mesh;
			m.geometry?.dispose?.();
			(m.material as THREE.Material | undefined)?.dispose?.();
		});
		overlayGroup = null;
	}
	(draftLine?.geometry as THREE.BufferGeometry | undefined)?.dispose?.();
	draftLine = null;
}

// The world rectangle the camera shows, as [x0, y0, x1, y1]. Emitted undebounced -- the
// workbench debounces before firing a viewport compute. Suppressed until the octree has
// loaded and framed: OrbitControls can emit 'change' during the first loop tick while the
// camera is still the constructor's (-1,1,1,-1), which would emit a 2x2 mm box and (if the
// channel is already Gi*) fire a /diag/viewport that 422s "empty viewport".
function emitBounds() {
	if (!pco || loading.value) return;
	const b = currentBounds();
	emit('bounds', [b.xmin, b.ymin, b.xmax, b.ymax]);
}

async function loadMeta(base: string) {
	try {
		// no-store: this metadata drives the colour limits; never risk a stale cached copy
		// (a pre-repatch metadata.json would show the wrong, un-clipped colour range).
		const res = await fetch(`${base}metadata.json`, { cache: 'no-store' });
		const meta = await res.json();
		// meta.attributes[].name is the octree's own (snake_case) LAS extra-dim name, e.g.
		// 'resid_z' -- ranges/ATTR_NAME are keyed by the prop's camelCase channel name, so match
		// via ATTR_NAME rather than `a.name in ranges` (which never matches, since 'resid_z' is
		// never a key of `ranges`; this silently left every channel on the [0,1] placeholder).
		const byAttrName = Object.fromEntries(Object.entries(ATTR_NAME).map(([k, v]) => [v, k]));
		for (const a of meta.attributes || []) {
			const propKey = byAttrName[a.name];
			if (propKey && Array.isArray(a.min) && Array.isArray(a.max)) {
				ranges[propKey] = [Number(a.min[0]), Number(a.max[0])];
			}
		}
	} catch { /* fall back to defaults */ }
}

async function load() {
	loading.value = true; error.value = null;
	// The octree host is configured, not assumed to be the SPA origin: the standalone app is
	// served from a different origin than the octree server, while the Directus module is
	// same-origin. The host supplies whichever applies.
	// "/octrees/diag/<octreePath>/" per this component's own prop contract above: octreePath is
	// the bare operation id that diag_path stores, and the "diag/" segment is this component's
	// to add -- it is what distinguishes the diagnostics octree from the raw spiral octree
	// FrmOctree.vue serves at /octrees/<octreePath>/. Dropping it silently loads that raw
	// octree instead (200, not 404) for any operation that has one.
	const base = `${useForceHost().octreeUrl}/diag/${props.octreePath}/`;
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
		applySelection();
		scene!.add(pco);
		pco.updateMatrixWorld(true);
		loading.value = false;   // before frameCamera(): emitBounds() is gated on !loading
		frameCamera();
		rebuildAnalysis();
		rebuildOverlay();
		if (controls) controls.enabled = (props.paintMode ?? 'off') !== 'draw';
	} catch (e: any) {
		error.value = e?.message || 'failed to load octree';
		loading.value = false;
	}
}

let baseSpan = 100;
// Fit-view: recenter on the octree bounding box and reset zoom. Load / cut-switch only --
// NOT the resize path (which must keep the analyst's framing; see adjustAspect).
function frameCamera() {
	if (!pco || !camera || !controls) return;
	const box = pco.boundingBox.clone().applyMatrix4(pco.matrixWorld);
	const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
	baseSpan = Math.max(sz.x, sz.y) || 100;
	const span = baseSpan * 1.08, aspect = cssW / cssH;
	camera.left = -span / 2 * aspect; camera.right = span / 2 * aspect; camera.top = span / 2; camera.bottom = -span / 2;
	camera.zoom = 1;   // OrbitControls dolly leaves zoom > 1 on the ortho camera; a fit-view must clear it
	camera.position.set(c.x, c.y, c.z + 1e5); camera.up.set(0, 1, 0); camera.lookAt(c.x, c.y, c.z);
	camera.updateProjectionMatrix();
	controls.target.set(c.x, c.y, c.z); controls.update();
	invalidate();
	emitBounds();
}

// Resize keeps the analyst's framing: only the horizontal frustum extent tracks the new
// aspect ratio; the vertical world-span, pan target and zoom are all preserved.
function adjustAspect() {
	if (!camera) return;
	const halfV = (camera.top - camera.bottom) / 2;
	const aspect = cssW / cssH;
	camera.left = -halfV * aspect;
	camera.right = halfV * aspect;
	camera.updateProjectionMatrix();
	invalidate();
	emitBounds();
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
	controls.addEventListener('change', () => { invalidate(); emitBounds(); });
	controls.enabled = (props.paintMode ?? 'off') !== 'draw';
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
			renderer.render(scene!, camera);
		}
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
	ro = new ResizeObserver(() => { sizeCanvas(); adjustAspect(); });
	nextTick(() => { setupGL(); if (canvasEl.value) ro!.observe(canvasEl.value); load(); });
});
onBeforeUnmount(() => {
	if (raf) cancelAnimationFrame(raf);
	ro?.disconnect(); controls?.dispose();
	disposePco(); disposeMaterial(); disposeAnalysis(); disposeOverlay();
	try { renderer?.forceContextLoss(); } catch { /* ignore */ }   // release the GL context (not freed by dispose())
	renderer?.dispose();
});

watch(() => props.octreePath, () => { disposePco(); disposeMaterial(); load(); });
// One watcher, not two: a focus=true run sets analysisResult and (via the workbench) the
// channel/analysisMode in the same tick -- separate watchers would build the up-to-1M-point
// geometry twice for one result. A multi-source watch coalesces to one callback per flush.
watch([() => props.analysisResult, () => props.analysisMode], rebuildAnalysis);
// Isolation is a uniform swap, not a geometry rebuild -- clicking through cluster rows must
// not reallocate an up-to-1M-point buffer per click.
watch(() => props.isolateClass, (v) => {
	if (!analysisPoints) return;
	(analysisPoints.material as THREE.ShaderMaterial).uniforms.uIsolate.value = v ?? -9999;
	invalidate();
});
watch(() => [props.layers, props.activeLayerName], rebuildOverlay, { deep: true });
watch(() => props.paintMode, () => {
	if (controls) controls.enabled = (props.paintMode ?? 'off') !== 'draw';
	if ((props.paintMode ?? 'off') !== 'draw') cancelRing();
	else nextTick(() => paintEl.value?.focus());
});
watch(() => props.channel, () => { if (material) { material.uniforms.uChannel.value = CHANNEL_IDX[props.channel] ?? 1; emitAutoRange(); } });
// LUT bytes resync only when lutKey changes; saturation/displayed-range/grey-vs-hide are uniforms.
watch(() => props.colorScale, (s) => {
	if (!material) return;
	syncScaleTexture(material.uniforms.uGradient.value, s);
	applyRange();
}, { deep: true });
watch(() => props.pointSize, () => { if (material) { material.uniforms.uSize.value = props.pointSize || 1.5; invalidate(); } });
watch(() => props.selection, applySelection, { deep: true });

// The world rectangle (mm) the orthographic camera currently shows (pan target ± half the
// zoom-scaled frustum). Meaningful in the flat 2D view.
function currentBounds(): { xmin: number; xmax: number; ymin: number; ymax: number } {
	if (!camera) return { xmin: -1, xmax: 1, ymin: -1, ymax: 1 };
	const cx = controls?.target.x ?? camera.position.x;
	const cy = controls?.target.y ?? camera.position.y;
	const hw = (camera.right - camera.left) / 2 / (camera.zoom || 1);
	const hh = (camera.top - camera.bottom) / 2 / (camera.zoom || 1);
	return { xmin: cx - hw, xmax: cx + hw, ymin: cy - hh, ymax: cy + hh };
}
</script>

<template>
	<div class="diag-octree">
		<div v-if="loading" class="fc-msg"><v-progress-circular indeterminate small /> streaming diagnostics…</div>
		<div v-else-if="error" class="fc-msg err"><v-icon name="error" small /> {{ error }}</div>
		<canvas v-show="!error" ref="canvasEl"></canvas>
		<div
			v-if="(paintMode ?? 'off') === 'draw'"
			ref="paintEl"
			class="do-paint"
			tabindex="0"
			@pointerdown.prevent="onPaintClick"
			@keyup.enter="finishRing"
			@keyup.esc="cancelRing"
		>
			<span class="do-paint-hint">
				click to add points · Enter to close ({{ draft.length }}) · Esc to cancel
			</span>
		</div>
		<span v-if="!loading && !error" class="fc-count">{{ pointCount.toLocaleString() }} pts (LOD)</span>
	</div>
</template>

<style scoped>
.diag-octree { position: relative; width: 100%; height: 100%; min-height: 160px; background: var(--plot-bg, #0b1020); border-radius: 6px; overflow: hidden; }
.diag-octree canvas { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
.diag-octree canvas:active { cursor: grabbing; }
.fc-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--text-dim, #94a3b8); }
.fc-msg.err { color: var(--danger, #fca5a5); font-size: var(--fs-sm, 12px); padding: 12px; text-align: center; }
.fc-count { position: absolute; right: 6px; bottom: 4px; font-size: var(--fs-xs, 11px); color: var(--text-dim, rgba(255,255,255,0.6)); font-variant-numeric: tabular-nums; }
.do-paint { position: absolute; inset: 0; cursor: crosshair; outline: none; }
.do-paint-hint { position: absolute; left: 8px; top: 6px; font-size: var(--fs-xs, 11px); color: #fcd34d; background: rgba(0,0,0,0.5); padding: 2px 6px; border-radius: 4px; pointer-events: none; }
</style>
