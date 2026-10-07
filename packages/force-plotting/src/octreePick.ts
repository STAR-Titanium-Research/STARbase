// Pure helpers for FrmOctree's position-based picking (see cloudPick.ts's header for why the
// octree is picked by position through the live cache).

/**
 * The world Z the octree vertex shader gives a point whose Z-series value is v:
 * (clamp((v - r0) / max(1e-6, r1 - r0), 0, 1) - 0.5) * zScale. Kept in lockstep with the
 * `uZAxis >= 0` branch in FrmOctree.vue's vertexShader so a projected sample lands on the
 * point the operator sees. zScale 0 (flat 2D) gives 0.
 */
export function shaderZ(v: number, r0: number, r1: number, zScale: number): number {
	if (zScale === 0) return 0;
	const u = (v - r0) / Math.max(1e-6, r1 - r0);
	return ((u < 0 ? 0 : u > 1 ? 1 : u) - 0.5) * zScale;
}
