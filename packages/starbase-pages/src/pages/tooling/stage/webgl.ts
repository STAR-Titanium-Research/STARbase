// Is WebGL available? A success is remembered; a failure is not, because it can be passing (the browser caps the WebGL
// contexts a page may hold, and other pages of the app may still be holding theirs), and a remembered "no" would keep
// the 3D view off until the page is reloaded. A probe context is released straight away.

let works = false;

export function hasWebGL(): boolean {
	if (works) return true;
	try {
		const canvas = document.createElement('canvas');
		const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | WebGL2RenderingContext | null;
		gl?.getExtension('WEBGL_lose_context')?.loseContext();
		works = gl !== null;
	} catch (e) {
		console.warn('[tooling stage] the WebGL probe threw', e);
	}
	if (!works) console.warn('[tooling stage] no WebGL context could be created');
	return works;
}
