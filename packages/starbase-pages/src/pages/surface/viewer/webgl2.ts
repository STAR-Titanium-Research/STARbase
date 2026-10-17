// Can this browser draw the surface? three.js 0.186 runs on WebGL2 only, and the shaders use texelFetch and an RG32F
// texture, so a browser with WebGL1 alone cannot draw it and a "Try again" would never work. (The tooling stage has its
// own probe, which accepts either version; it is not touched.)

/** One probe: a throw-away canvas asked for a webgl2 context, which is released straight away. */
export function probeWebGL2(create: () => HTMLCanvasElement = () => document.createElement('canvas')): boolean {
	try {
		const gl = create().getContext('webgl2') as WebGL2RenderingContext | null;
		if (!gl) return false;
		gl.getExtension('WEBGL_lose_context')?.loseContext();
		return true;
	} catch {
		return false;
	}
}

let cached: boolean | null = null;

/** Probed once per page. */
export function hasWebGL2(): boolean {
	if (cached === null) cached = probeWebGL2();
	return cached;
}
