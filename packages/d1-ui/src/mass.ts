// Mass estimate of a sample from its dimensions and the material density, for a sample that has no
// measured mass. Same rule as the GeometryPreview form interface (d1-geometry-preview), and the
// same reading of `form` as geometry.ts (a round bar or cylinder is a cylinder; the legacy
// free-text forms 'cylindrical' and 'rod' match loosely).

export interface MassDims {
	form: string | null;
	diameter_mm?: number | null;
	length_mm?: number | null;
	width_mm?: number | null;
	thickness_mm?: number | null;
}

const pos = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

export function volumeMm3(d: MassDims): number | null {
	const g = (d.form || '').toLowerCase();
	if (g.includes('powder')) return null; // no defined shape
	const { diameter_mm: dia, length_mm: len, width_mm: w, thickness_mm: t } = d;
	if (g.includes('disc')) {
		const h = pos(t) ? t : len;
		return pos(dia) && pos(h) ? Math.PI * (dia / 2) ** 2 * h : null;
	}
	if (g === 'round_bar' || /cylind|rod/.test(g)) return pos(dia) && pos(len) ? Math.PI * (dia / 2) ** 2 * len : null;
	if (pos(w) && pos(len) && pos(t)) return w * len * t; // box-like
	return null;
}

// Grams, or null when the shape or the density is unknown.
export function estimateMassGrams(d: MassDims, densityGPerCm3: number | null | undefined): number | null {
	const v = volumeMm3(d);
	if (v === null || !pos(densityGPerCm3)) return null;
	return (v / 1000) * densityGPerCm3;
}
