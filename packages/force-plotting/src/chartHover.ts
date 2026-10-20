// The crosshair / tooltip's data for ForceChart's shared hover (#100). Pure, so it is testable and
// so ChartHoverLayer can compute it from the hover index inside its OWN render: ForceChart itself
// never reads the index (see ChartHoverLayer.vue).
import type { Ref } from 'vue';

/**
 * The shared hover index, wrapped in an object on purpose. Handed to a child as a plain ref, a
 * template would unwrap it into a number prop that changes on every mouse move, and Vue then
 * re-renders that child (here a whole chart's grid, ticks and paths) whether or not its render
 * reads the prop. A stable wrapper never changes identity; only the layer that reads `.index`
 * subscribes to it.
 */
export interface HoverSource { index: Ref<number | null> }

/** Just what the crosshair needs of ForceChart's geometry. */
export interface HoverGeom {
	xs: ArrayLike<number>;
	iA: number;
	iB: number;
	sx: (v: number) => number;
	sy: (v: number) => number;
}

export interface HoverPoint { px: number; py: number; label: string; sub: string }

export function niceNum(v: number): string {
	const a = Math.abs(v);
	if (a === 0) return '0';
	if (a >= 1000) return `${(v / 1000).toFixed(1)}k`;
	if (a >= 100) return v.toFixed(0);
	if (a >= 10) return v.toFixed(1);
	if (a >= 1) return v.toFixed(2);
	if (a >= 0.01) return v.toFixed(3);
	return v.toExponential(0);
}

/**
 * Where the crosshair dot goes and what the tooltip says for sample `i`; null when there is no
 * hover or it lies outside the visible window [iA, iB]. `env` charts read the envelope's mid-line
 * (`min`/`max`); `line` charts (spectra) read `amp` (dB on the dashboard's spectra).
 */
export function hoverPoint(
	g: HoverGeom | null,
	i: number | null | undefined,
	kind: 'env' | 'line',
	data: any,
	yLabelUnit: string,
	xUnit: string | undefined,
): HoverPoint | null {
	if (!g || i == null || i < g.iA || i > g.iB) return null;
	if (kind === 'env') {
		const mid = (data.min[i] + data.max[i]) / 2;
		return { px: g.sx(g.xs[i]), py: g.sy(mid),
			label: `${mid.toFixed(2)} ${yLabelUnit}`.trim(), sub: `${niceNum(g.xs[i])} ${xUnit || ''}`.trim() };
	}
	return { px: g.sx(g.xs[i]), py: g.sy(data.amp[i]),
		label: `${data.amp[i].toPrecision(3)} ${yLabelUnit}`.trim(), sub: `${niceNum(g.xs[i])} ${xUnit || 'Hz'}`.trim() };
}
