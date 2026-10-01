// GPU point-cloud path for FrmCloud.vue's default (flat, ungridded, no Z-overlay)
// turning-spiral render — the one crop-dragging was actually slow on. Position, visibility
// (crop + inner-diameter cutoff) and colour all move into the vertex/fragment shader below, off
// STATIC per-vertex attributes (aT, aRevs, aVal) uploaded once per real geometry change. Dragging
// the crop handles then only updates a few uniforms (uCropStart/uCropEnd/uTCs/uRevsCs/uCmin/
// uCmax) — no per-frame CPU recompute, no GPU re-upload.
//
// Scope, deliberately narrow (see the Phase-5 plan): gridded mode, a Z-series overlay (3D/
// OrbitControls), and the linear_feed/machine_xyz path kinds all stay on FrmCloud.vue's existing
// CPU buildCloud() path — none of them is what a user drags continuously, so none of them needed
// the GPU rewrite. FrmCloud.vue picks this path only when
// `!gridding && (!zSeries || zSeries==='none') && path.kind==='turning_spiral'`.
//
// Two things this file assumes about the maths in path.ts's buildTurningSpiral, both checked
// against 5 real live-cache files (including the only inner-diameter/"donut" cut on hand) before
// relying on them — see the throwaway probe referenced in the Phase-5 plan write-up:
//   1. `revs` is non-decreasing (a real tacho never runs backwards) — confirmed, 0 violations.
//   2. The set {i : rho(i) >= innerR} is a contiguous prefix of the crop window — confirmed, 0
//      counterexamples — so a per-vertex `rho < innerR` discard reproduces the CPU version's
//      sequential `break` exactly, without needing cross-vertex ordering in the shader.
// If a future cache with a genuinely noisy/decelerating tacho breaks assumption 1, the symptom
// is a scattering of points beyond where the CPU path would have stopped; re-run the probe.
import type { Cache } from './liveCache';
import type { SpeedMode, CloudChannel } from './liveCloud';

export const SPEED_MODE_CODE: Record<SpeedMode, number> = { measured: 0, rpm: 1, vc: 2 };

export const TURNING_SPIRAL_VERT = /* glsl */ `
attribute float aT;
attribute float aRevs;
attribute float aVal;

uniform float uFeed;
uniform float uRho0;
uniform float uInnerR;
uniform int uSpeedMode;      // 0 measured, 1 rpm, 2 vc — see SPEED_MODE_CODE
uniform float uRevPerSec;
uniform float uTimeScale;
uniform float uPpr;
uniform float uK;            // vc mode constant: feed*vc*1000/(PI*120)
uniform float uTCs;          // t at the crop-start sample
uniform float uRevsCs;       // revs at the crop-start sample
uniform float uCropStart;
uniform float uCropEnd;
uniform float uCmin;
uniform float uCmax;
uniform vec2 uDisp;          // displayed-range filter: [dispMin, dispMax] on the RAW value
uniform float uGreyOOR;      // 1 = grey out-of-displayed-range points, 0 = hide them
uniform float uPointSize;
uniform sampler2D uColormap; // 1D LUT, sampled at (t, 0.5)

varying vec3 vColor;

const float PI = 3.14159265358979;

void main() {
	bool visible = aT >= uCropStart && aT <= uCropEnd;
	float rho = uRho0;
	float r = 0.0;
	if (uSpeedMode == 2) {
		float under = uRho0 * uRho0 - 2.0 * uK * (aT - uTCs) * uTimeScale;
		if (under < uInnerR * uInnerR) visible = false;
		rho = sqrt(max(under, 0.0));
		r = uFeed != 0.0 ? (uRho0 - rho) / uFeed : 0.0;
	} else {
		r = uSpeedMode == 1
			? uRevPerSec * (aT - uTCs) * uTimeScale
			: (aRevs - uRevsCs) / uPpr;
		rho = uRho0 - uFeed * r;
		if (rho < uInnerR) visible = false;
	}
	float theta = 2.0 * PI * r;
	vec3 pos = vec3(rho * cos(theta), rho * sin(theta), 0.0);

	// Displayed-range filter: colour is resolved entirely in THIS stage already (vColor is the
	// only varying -- see the file header), so the out-of-range decision belongs here too, using
	// the same off-clip trick as the crop/inner-radius visibility above rather than a new varying.
	bool outOfDisplay = aVal < uDisp.x || aVal > uDisp.y;
	if (outOfDisplay && uGreyOOR < 0.5) visible = false;

	float ct = clamp((aVal - uCmin) / max(uCmax - uCmin, 1e-9), 0.0, 1.0);
	vColor = (outOfDisplay && uGreyOOR > 0.5) ? vec3(0.5) : texture2D(uColormap, vec2(ct, 0.5)).rgb;

	if (!visible) {
		// Push off-clip rather than discard (vertex shaders can't discard) — 1e6 is far outside
		// any realistic ortho frustum (a few mm to a few hundred mm), so it reliably clips.
		gl_Position = vec4(1.0e6, 1.0e6, 1.0e6, 1.0);
		return;
	}
	vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
	gl_Position = projectionMatrix * mvPosition;
	gl_PointSize = uPointSize;
}
`;

export const TURNING_SPIRAL_FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
	vec2 c = gl_PointCoord - vec2(0.5);
	if (dot(c, c) > 0.25) discard;   // round point, matches the disc-texture look of the CPU path
	gl_FragColor = vec4(vColor, 1.0);
}
`;

export interface SpiralUniformParams {
	feed: number; diam: number; innerDiam: number;
	speedMode: SpeedMode; rpm: number; vc: number; timeScale: number; ppr: number;
	tCs: number; revsCs: number;
}

// Everything a vertex needs beyond its own aT/aRevs/aVal, computed once per uniform push (not
// per vertex) — mirrors the scalar prep at the top of path.ts's buildTurningSpiral.
export function spiralUniformValues(p: SpiralUniformParams) {
	const ts = p.timeScale > 0 ? p.timeScale : 1;
	const ppr = p.ppr > 0 ? p.ppr : 1;
	return {
		uFeed: p.feed, uRho0: p.diam / 2, uInnerR: Math.max(0, (p.innerDiam || 0) / 2),
		uSpeedMode: SPEED_MODE_CODE[p.speedMode], uRevPerSec: p.rpm / 60, uTimeScale: ts, uPpr: ppr,
		uK: p.feed * p.vc * 1000 / (Math.PI * 120), uTCs: p.tCs, uRevsCs: p.revsCs,
	};
}

// Pure JS mirror of the vertex shader's position math — same formula, same branches, same
// discard conditions — so it can be unit-tested against buildTurningSpiral's CPU output without
// a GPU. Keep this and TURNING_SPIRAL_VERT's `main()` in lockstep by construction: if one
// changes, re-derive the other from this file's own doc comment, don't hand-edit both separately.
export function computeSpiralVertexJS(
	aT: number, aRevs: number, p: SpiralUniformParams, cropStart: number, cropEnd: number,
): { x: number; y: number; rho: number; visible: boolean } {
	const u = spiralUniformValues(p);
	let visible = aT >= cropStart && aT <= cropEnd;
	let rho = u.uRho0, r = 0;
	if (u.uSpeedMode === 2) {
		const under = u.uRho0 * u.uRho0 - 2 * u.uK * (aT - u.uTCs) * u.uTimeScale;
		if (under < u.uInnerR * u.uInnerR) visible = false;
		rho = Math.sqrt(Math.max(under, 0));
		r = u.uFeed !== 0 ? (u.uRho0 - rho) / u.uFeed : 0;
	} else {
		r = u.uSpeedMode === 1
			? u.uRevPerSec * (aT - u.uTCs) * u.uTimeScale
			: (aRevs - u.uRevsCs) / u.uPpr;
		rho = u.uRho0 - u.uFeed * r;
		if (rho < u.uInnerR) visible = false;
	}
	const theta = 2 * Math.PI * r;
	return { x: rho * Math.cos(theta), y: rho * Math.sin(theta), rho, visible };
}

// Decimate the FULL cache (index 0..N, not just the crop window) into the static per-vertex
// attributes the shader reads. Uploaded once per real geometry change (op load, channel select,
// stride change) — crop dragging alone never touches this. `stride` here intentionally uses the
// SAME phase (starting at index 0) regardless of where the crop window currently sits, unlike the
// CPU path's cs-anchored decimation (path.ts's buildTurningSpiral iterates from `cs`, not 0).
// The GPU buffer stays phase-0 forever, including at rest — FrmCloud.vue only re-derives the
// cs-anchored count (via refineGpuPointCount/buildPath) for the "N pts" readout, it never
// re-uploads geometry at drag-end. This is safe: each shader vertex's position depends only on
// its OWN aT/aRevs plus the crop-start uniforms (uTCs/uRevsCs), never on decimation phase, so a
// phase-0-kept point renders at the exact same (correct) place a cs-anchored one would. The one
// observable effect is a point COUNT that can differ from the cs-anchored exact count by at most
// one point (verified across strides 2/5/10/25 in frmCloudShader.test.ts) — never a wrong shape,
// never a resolution loss.
export function buildStaticAttributes(
	c: Cache, channel: CloudChannel, stride: number,
): { aT: Float32Array; aRevs: Float32Array; aVal: Float32Array; count: number } {
	const st = Math.max(1, Math.round(stride) || 1);
	const channelArr = (c as any)[channel] as Float32Array | undefined;
	const n = Math.ceil(c.N / st);
	const aT = new Float32Array(n), aRevs = new Float32Array(n), aVal = new Float32Array(n);
	let k = 0;
	for (let i = 0; i < c.N; i += st, k++) {
		aT[k] = c.t[i]; aRevs[k] = c.revs[i];
		aVal[k] = channelArr ? channelArr[i] : 0;
	}
	return { aT, aRevs, aVal, count: k };
}

// The colour-scale LUT builder that used to live here has moved to colorScale.ts's
// buildScaleLUT -- the last of three near-duplicate implementations (this one, FrmOctree.vue's,
// DiagScatter.vue's) to be consolidated. It bakes every ColorScale parameter except the
// displayed-range filter (steps, symmetrical, always-show-zero, log scale) into the LUT bytes,
// so TURNING_SPIRAL_VERT above only ever needed the one addition: the uDisp/uGreyOOR branch.
