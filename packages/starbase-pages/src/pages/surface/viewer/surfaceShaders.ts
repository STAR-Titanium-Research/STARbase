// The surface scan's shaders. The CPU builds one flat plane with a vertex per grid cell and hands over the height
// grid as a float texture; everything after that is the GPU's: the vertex shader reads each cell's height and
// its four neighbours (displacement and normal), the fragment shader looks the colour up in the ramp texture,
// lights it and discards cells that hold no data. Exaggeration and colour-by-height are uniforms, so moving the
// slider costs one uniform write and a redraw.
//
// Units: the scene's longer lateral side is 1 (ScanLayout.umToScene converts micrometres). Heights stay in
// micrometres until the last multiply, so the ramp and the range read in the file's units.
//
// uGrid is RG32F: R = height in micrometres (a missing cell holds a value filled in from its neighbours, see
// buildTextureData), G = 1 where the cell has data, 0 where it has none. No NaN ever reaches the GPU: the
// language leaves the result of arithmetic on one undefined.

export const UNIFORMS = [
	'uGrid', 'uRamp', 'uCells', 'uScene', 'uPitch', 'uExag', 'uZMid', 'uZMin', 'uZRange', 'uColour',
] as const;

const COMMON = /* glsl */ `
uniform sampler2D uGrid;
uniform vec2 uCells;     // grid width and height in cells

// The grid cell a plane vertex or fragment sits on. uv.y is 1 at the top row of the file (the first row of
// grid.bin), and texelFetch row 0 is the first row uploaded, so the row counts down from the top.
ivec2 cellOf(vec2 uv) {
	return ivec2(
		clamp(floor(uv.x * (uCells.x - 1.0) + 0.5), 0.0, uCells.x - 1.0),
		clamp(floor((1.0 - uv.y) * (uCells.y - 1.0) + 0.5), 0.0, uCells.y - 1.0)
	);
}
`;

export const VERTEX_SHADER = /* glsl */ `
${COMMON}
uniform vec3 uScene;     // plane size x and z in scene units, scene units per micrometre
uniform vec2 uPitch;     // micrometres between cells, x and z
uniform float uExag;     // vertical exaggeration
uniform float uZMid;     // micrometres; the surface is centred on this height

varying vec2 vUv;
varying float vHeight;   // micrometres
varying vec3 vNormalView;
varying vec3 vViewPos;

float heightAt(ivec2 c) {
	ivec2 last = ivec2(uCells) - 1;
	return texelFetch(uGrid, clamp(c, ivec2(0), last), 0).r;
}

void main() {
	vUv = uv;
	ivec2 c = cellOf(uv);
	float h = heightAt(c);
	vHeight = h;

	// Slopes from the neighbours; scene x grows with the column and z with the row (the top row is farthest).
	float dhdx = (heightAt(c + ivec2(1, 0)) - heightAt(c - ivec2(1, 0))) / (2.0 * uPitch.x);
	float dhdz = (heightAt(c + ivec2(0, 1)) - heightAt(c - ivec2(0, 1))) / (2.0 * uPitch.y);
	vec3 n = normalize(vec3(-dhdx * uExag, 1.0, -dhdz * uExag));

	vec3 p = vec3((uv.x - 0.5) * uScene.x, (h - uZMid) * uExag * uScene.z, (0.5 - uv.y) * uScene.y);
	vec4 view = modelViewMatrix * vec4(p, 1.0);
	vViewPos = view.xyz;
	vNormalView = normalMatrix * n;
	gl_Position = projectionMatrix * view;
}
`;

export const FRAGMENT_SHADER = /* glsl */ `
${COMMON}
uniform sampler2D uRamp; // n x 1 colour strip, lowest height at the left
uniform float uZMin;     // micrometres at the bottom of the ramp
uniform float uZRange;   // micrometres from the bottom to the top of the ramp
uniform float uColour;   // 1 = colour by height, 0 = a plain metal grey

varying vec2 vUv;
varying float vHeight;
varying vec3 vNormalView;
varying vec3 vViewPos;

void main() {
	// A cell with no data leaves a hole.
	if (texelFetch(uGrid, cellOf(vUv), 0).g < 0.5) discard;

	vec3 n = normalize(vNormalView);
	vec3 l = normalize(vec3(-0.45, 0.6, 0.65)); // view space: from the upper left, towards the viewer
	vec3 v = normalize(-vViewPos);
	float diffuse = max(dot(n, l), 0.0);
	float spec = pow(max(dot(n, normalize(l + v)), 0.0), 48.0);

	float t = clamp((vHeight - uZMin) / uZRange, 0.0, 1.0);
	vec3 ramp = texture2D(uRamp, vec2(0.002 + 0.996 * t, 0.5)).rgb;
	vec3 base = mix(vec3(0.66, 0.68, 0.72), ramp, uColour);
	vec3 colour = base * (0.3 + 0.8 * diffuse) + vec3(0.2) * spec * (1.0 - 0.6 * uColour);
	gl_FragColor = vec4(colour, 1.0);
}
`;
