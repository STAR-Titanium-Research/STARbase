// The height colour ramp (perceptual, viridis-like) as data, so the shader's ramp texture and the legend's
// gradient are built from the same stops. Pure.

export type Rgb = [number, number, number]; // 0..255, sRGB

export const RAMP_STOPS: ReadonlyArray<{ t: number; hex: string }> = [
	{ t: 0, hex: '#440154' },
	{ t: 0.125, hex: '#482878' },
	{ t: 0.25, hex: '#3e4a89' },
	{ t: 0.375, hex: '#31688e' },
	{ t: 0.5, hex: '#26828e' },
	{ t: 0.625, hex: '#1f9e89' },
	{ t: 0.75, hex: '#35b779' },
	{ t: 0.875, hex: '#6dcd59' },
	{ t: 1, hex: '#fde725' },
];

const rgbOf = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const STOPS = RAMP_STOPS.map((s) => ({ t: s.t, rgb: rgbOf(s.hex) }));

/** The ramp colour at t in 0..1 (clamped; NaN reads as 0). */
export function rampColour(t: number): Rgb {
	const x = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
	let i = 1;
	while (i < STOPS.length - 1 && STOPS[i].t < x) i++;
	const a = STOPS[i - 1];
	const b = STOPS[i];
	const f = (x - a.t) / (b.t - a.t);
	return [0, 1, 2].map((c) => Math.round(a.rgb[c] + (b.rgb[c] - a.rgb[c]) * f)) as Rgb;
}

/** An n x 1 RGBA8 strip of the ramp, for a texture the shader looks the colour up in. */
export function rampBytes(n = 256): Uint8Array {
	const out = new Uint8Array(n * 4);
	for (let i = 0; i < n; i++) {
		const [r, g, b] = rampColour(n === 1 ? 0 : i / (n - 1));
		out.set([r, g, b, 255], i * 4);
	}
	return out;
}

/** A CSS gradient of the ramp; `to top` puts the highest value at the top, as the legend reads. */
export function rampCss(direction: 'to top' | 'to right' = 'to top'): string {
	return `linear-gradient(${direction}, ${RAMP_STOPS.map((s) => `${s.hex} ${s.t * 100}%`).join(', ')})`;
}
