// A host's auto-ranging colour scale: the renderer reports its data range via @climits, and the
// scale's saturation range follows it unless the user has locked it (the editor locks on an
// explicit range edit). Shared by every FRM host so the dedup / seeding / unlock rules live once.
import { ref, watch } from 'vue';
import { defaultScale, withAutoRange, type ColorScale } from './colorScale';

export interface AutoRange { cmin: number; cmax: number }

export function useAutoColorScale(opts: {
	initial?: ColorScale;
	// Range to re-apply on unlock when no renderer has reported one yet (e.g. derived from a cache).
	fallback?: () => [number, number] | null;
} = {}) {
	const colorScale = ref<ColorScale>(opts.initial ?? defaultScale(0, 1));
	const locked = ref(false);
	const autoClimits = ref<AutoRange | null>(null);

	function seed(lo: number, hi: number) { colorScale.value = withAutoRange(colorScale.value, lo, hi); }

	function onClimits(v: AutoRange) {
		// A value-identical re-emission would still be a fresh colorScale object for every pane.
		if (autoClimits.value && autoClimits.value.cmin === v.cmin && autoClimits.value.cmax === v.cmax) return;
		autoClimits.value = v;
		if (!locked.value) seed(v.cmin, v.cmax);
	}

	// Unlocking hands the saturation range straight back to auto.
	watch(locked, (l) => {
		if (l) return;
		const a = autoClimits.value;
		const r = a ? [a.cmin, a.cmax] : opts.fallback?.() ?? null;
		if (r) seed(r[0], r[1]);
	});

	return { colorScale, locked, autoClimits, onClimits, seed };
}
