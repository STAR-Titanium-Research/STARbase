// This package has no DOM environment and no @vue/test-utils (and vitest here has no .vue
// transform), so ForceChart.vue / ChartHoverLayer.vue cannot be mounted. What is tested instead:
//   1. the pure crosshair maths ChartHoverLayer renders (chartHover.ts), and
//   2. the Vue mechanism the split relies on, with hand-written components in a node-only renderer
//      (createRenderer with no-op node ops): a chart that is handed the hover index as a changing
//      prop re-renders on every move even if its render never reads it, while one handed a stable
//      HoverSource does not -- only the layer that reads `.index` does (#100).
import { createRenderer, defineComponent, h, nextTick, ref, type Ref } from 'vue';
import { describe, expect, it } from 'vitest';
import { hoverPoint, niceNum, type HoverGeom, type HoverSource } from './chartHover';

const geom: HoverGeom = {
	xs: [0, 1, 2, 3, 4, 5],
	iA: 1,
	iB: 4,
	sx: (v) => 10 + v * 20,
	sy: (v) => 100 - v * 10,
};

describe('hoverPoint', () => {
	const env = { min: [0, -2, -4, -6, -8, -10], max: [0, 2, 4, 6, 8, 10] };
	it('is null with no hover, no geometry, or a hover outside the visible window', () => {
		expect(hoverPoint(geom, null, 'env', env, 'N', 's')).toBeNull();
		expect(hoverPoint(geom, undefined, 'env', env, 'N', 's')).toBeNull();
		expect(hoverPoint(null, 2, 'env', env, 'N', 's')).toBeNull();
		expect(hoverPoint(geom, 0, 'env', env, 'N', 's')).toBeNull();
		expect(hoverPoint(geom, 5, 'env', env, 'N', 's')).toBeNull();
	});
	it('puts an envelope chart on the mid-line and labels it with the y unit and the x position', () => {
		const e = { min: [0, 1, 2, 3, 4, 5], max: [0, 3, 4, 5, 6, 7] };   // mids 2, 3, 4, 5, 6 from i=1
		expect(hoverPoint(geom, 2, 'env', e, 'N', 's')).toEqual({ px: 50, py: 70, label: '3.00 N', sub: '2.00 s' });
		expect(hoverPoint(geom, 1, 'env', e, '', undefined)).toEqual({ px: 30, py: 80, label: '2.00', sub: '1.00' });
	});
	it('reads a spectrum from amp, defaulting the x unit to Hz', () => {
		const line = { amp: [0, 1.2345, 2, 3, 4, 5] };
		expect(hoverPoint(geom, 1, 'line', line, 'N', undefined)).toEqual({ px: 30, py: 87.655, label: '1.23 N', sub: '1.00 Hz' });
		expect(hoverPoint(geom, 1, 'line', line, 'N', 'Hz')?.sub).toBe('1.00 Hz');
	});
});

describe('niceNum', () => {
	it('keeps three significant-ish figures at every magnitude', () => {
		expect([0, 1500, 150, 15, 1.5, 0.15, 0.0015].map(niceNum)).toEqual(['0', '1.5k', '150', '15.0', '1.50', '0.150', '2e-3']);
	});
});

// ---------------------------------------------------------------------------------- render counts
// A renderer with no DOM: every node op is a stub, enough for components that render elements.
const { render } = createRenderer<any, any>({
	patchProp: () => {},
	insert: () => {},
	remove: () => {},
	createElement: () => ({}),
	createText: () => ({}),
	createComment: () => ({}),
	setText: () => {},
	setElementText: () => {},
	parentNode: () => null,
	nextSibling: () => null,
});

function mountCounting(hover: Ref<number | null>, mode: 'prop' | 'source') {
	const renders = { chart: 0, layer: 0 };
	const source: HoverSource = { index: hover };

	// The layer reads the hover index in its own render, like ChartHoverLayer.vue.
	const Layer = defineComponent({
		props: { hover: { type: Object, default: null } },
		setup(p) {
			return () => { renders.layer++; return h('g', String((p.hover as HoverSource | null)?.index.value)); };
		},
	});
	// The chart never reads the hover index itself (it only forwards the source to the layer) --
	// the contract ForceChart now keeps.
	const Chart = defineComponent({
		props: { hoverIndex: { type: Number, default: null }, hover: { type: Object, default: null } },
		setup(p) {
			return () => { renders.chart++; return h('svg', [h(Layer, { hover: p.hover })]); };
		},
	});
	// The host (the Plot page) re-renders on every hover move and hands each chart its inputs.
	const Host = defineComponent({
		setup() {
			return () => {
				const i = hover.value;   // the page reads it too (hoverTime), so it re-renders either way
				return h(Chart, (mode === 'prop' ? { hoverIndex: i } : { hover: source }) as Record<string, unknown>);
			};
		},
	});
	render(h(Host), {});
	return renders;
}

describe('hover moves and the chart (#100)', () => {
	it('re-renders the whole chart per move when the index is passed as a changing prop', async () => {
		const hover = ref<number | null>(null);
		const r = mountCounting(hover, 'prop');
		const before = r.chart;
		hover.value = 1; await nextTick();
		hover.value = 2; await nextTick();
		expect(r.chart - before).toBe(2);
	});
	it('re-renders only the hover layer per move when the chart is handed a stable HoverSource', async () => {
		const hover = ref<number | null>(null);
		const r = mountCounting(hover, 'source');
		const chart0 = r.chart, layer0 = r.layer;
		for (const i of [1, 2, 3, null]) { hover.value = i; await nextTick(); }
		expect(r.chart - chart0).toBe(0);
		expect(r.layer - layer0).toBe(4);
	});
});
