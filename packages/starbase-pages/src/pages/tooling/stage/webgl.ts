// Is WebGL available? Probed once; a probe context is released straight away.

let cached: boolean | null = null;

export function hasWebGL(): boolean {
	if (cached !== null) return cached;
	try {
		const canvas = document.createElement('canvas');
		const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | WebGL2RenderingContext | null;
		cached = gl !== null;
		gl?.getExtension('WEBGL_lose_context')?.loseContext();
	} catch {
		cached = false;
	}
	return cached;
}
