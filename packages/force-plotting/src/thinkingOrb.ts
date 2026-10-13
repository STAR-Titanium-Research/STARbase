// Geometry for the app's loading orb: three dotted strands plaiting around a faint dotted sphere,
// one strand per force axis (Fx red, Fy green, Fz blue: the three dots of the login brand mark).
//
// Ported from the "weaving" state of thinking-orbs (https://github.com/Jakubantalik/thinking-orbs,
// MIT, © 2026 Jakub Antalik). The upstream package is React-only, so the braid mode, its two tuned
// size presets and the helpers it needs are copied here. The one change: each dot carries which
// strand it belongs to (`strand`), so the painter can colour it, where upstream paints greyscale.
//
// Pure math over (size, t): no DOM, no canvas, so it is unit-tested directly.

export interface OrbDot {
	x: number;
	y: number;
	z: number;
	r: number;
	/** Opacity in [0, 1]. Carries depth: far dots are fainter. */
	a: number;
	/** 0 = Fx, 1 = Fy, 2 = Fz; -1 = the ghost sphere behind the strands. */
	strand: -1 | 0 | 1 | 2;
}

export interface OrbOpts {
	strandN: number;
	ghostN: number;
	turns: number;
	rBase: number;
	rDepth: number;
	rsPow: number;
	rMin: number;
}

/** Shipped tuning for one size: speed multiplies the clock, opts are the scaled dot counts/radii. */
export interface OrbPreset {
	speed: number;
	opts: OrbOpts;
}

// Upstream base profile (braid) times its per-size count/radius multipliers, resolved once.
// 64 is the avatar-scale design, 20 the inline-text one; they are separate designs, not a scale.
const BASE = { strandN: 52, ghostN: 150, turns: 3, rBase: 1.2, rDepth: 1.8, rsPow: 0.6, rMin: 0.3 };
function tuned(count: number, radius: number): OrbOpts {
	return {
		...BASE,
		strandN: Math.max(1, Math.round(BASE.strandN * count)),
		ghostN: Math.max(1, Math.round(BASE.ghostN * count)),
		rBase: BASE.rBase * radius,
		rDepth: BASE.rDepth * radius,
	};
}
// Upstream draws black/white ink; a coloured dot has less contrast against the ground, so the inline
// design's dots are 1.3x upstream's (1.36 → 1.77) to keep the three strands readable at 14-20 px.
export const ORB_PRESETS = {
	64: { speed: 1.625, opts: tuned(0.5, 1) },
	20: { speed: 2.75, opts: tuned(0.1125, 1.77) },
} satisfies Record<number, OrbPreset>;

/** Below 24 px the inline design reads better; from 24 px the large one already reads as a sphere. */
export function orbPreset(size: number): OrbPreset {
	return size >= 24 ? ORB_PRESETS[64] : ORB_PRESETS[20];
}

function frac(x: number): number {
	return x - Math.floor(x);
}

/** Stable directions on a unit sphere (Fibonacci lattice). */
function fibDir(i: number, n: number): [number, number, number] {
	const golden = Math.PI * (3 - Math.sqrt(5));
	const y = 1 - (2 * (i + 0.5)) / n;
	const rad = Math.sqrt(1 - y * y);
	const a = i * golden;
	return [rad * Math.cos(a), y, rad * Math.sin(a)];
}

/** Spin about y, tilt about x, orthographic projection into a size×size box. */
function makeProj(yaw: number, tilt: number, cx: number, cy: number) {
	const st = Math.sin(tilt);
	const ct = Math.cos(tilt);
	const sy = Math.sin(yaw);
	const cyw = Math.cos(yaw);
	return (x: number, y: number, z: number): [number, number, number] => {
		const x1 = x * cyw + z * sy;
		const z1 = -x * sy + z * cyw;
		const y1 = y * ct - z1 * st;
		const z2 = y * st + z1 * ct;
		return [cx + x1, cy - y1, z2];
	};
}

/**
 * One frame at `size` CSS px and clock `t` (seconds × preset speed). Returns the visible dots
 * z-sorted far to near, radii clamped, ready to draw in order.
 */
export function orbFrame(size: number, t: number, o: OrbOpts): OrbDot[] {
	const cx = size / 2;
	const cy = size / 2;
	const R = (size / 2) * 0.76;
	const pt = makeProj(t * 0.4, 0.3, cx, cy);
	// Radii were tuned for a 300 px frame; sub-linear scaling keeps small orbs legible.
	const rs = (size / 300) ** o.rsPow;

	const dots: OrbDot[] = [];
	for (let i = 0; i < o.ghostN; i++) {
		const d = fibDir(i, o.ghostN);
		const [x, y, z] = pt(d[0] * R, d[1] * R, d[2] * R);
		const depth = (z / R + 1) / 2;
		dots.push({ x, y, z, r: 0.8 * rs, a: 0.1 + 0.22 * depth, strand: -1 });
	}

	for (const s of [0, 1, 2] as const) {
		const phase = (s / 3) * 2 * Math.PI;
		for (let i = 0; i < o.strandN; i++) {
			// u walks pole to pole; the frac() drift slides the whole strand along
			const u = (frac(i / o.strandN + t * 0.045) * 2 - 1) * 0.96;
			const surf = Math.sqrt(Math.max(0, 1 - u * u));
			const endFade = Math.min(1, (1 - Math.abs(u)) / 0.1);
			const ang = u * Math.PI * o.turns + phase;
			// radial breathing: strands trade places, the over/under of a plait
			const weave = 1 + 0.075 * Math.sin(u * Math.PI * o.turns * 2 + phase * 2 + t * 0.8);
			const rr = surf * R * weave;
			const [x, y, z] = pt(Math.cos(ang) * rr, u * R * weave, Math.sin(ang) * rr);
			const depth = (z / R + 1) / 2;
			dots.push({
				x,
				y,
				z,
				r: (o.rBase + o.rDepth * depth) * rs,
				// the weave can push a dot a hair past the sphere, so depth slightly over 1
				a: Math.min(1, endFade * (0.45 + 0.55 * depth)),
				strand: s,
			});
		}
	}

	const visible = dots.filter((d) => d.a >= 0.02);
	for (const d of visible) d.r = Math.max(o.rMin, d.r);
	return visible.sort((p, q) => p.z - q.z);
}
