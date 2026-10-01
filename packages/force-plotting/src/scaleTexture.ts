// The colour-ramp texture every FRM/diag renderer samples in its shader. One place owns its
// lifecycle so a new field baked into buildScaleLUT only needs lutKey to learn about it.
import * as THREE from 'three';
import { buildScaleLUT, lutKey, type ColorScale } from './colorScale';

const WIDTH = 256;

export function createScaleTexture(s: ColorScale): THREE.DataTexture {
	const t = new THREE.DataTexture(buildScaleLUT(s, WIDTH), WIDTH, 1, THREE.RGBAFormat);
	t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
	t.userData.lutKey = lutKey(s);
	t.needsUpdate = true;
	return t;
}

// Rewrites the texture's bytes in place (no GL reallocation) when anything baked into them changed.
export function syncScaleTexture(t: THREE.DataTexture, s: ColorScale): void {
	const key = lutKey(s);
	if (t.userData.lutKey === key) return;
	(t.image.data as Uint8ClampedArray).set(buildScaleLUT(s, WIDTH));
	t.userData.lutKey = key;
	t.needsUpdate = true;
}
