import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import FastChart from './FastChart.vue';
import type { RunWindowBand } from './profile';

const time = Float64Array.from({ length: 101 }, (_, i) => i * 10);   // 0 .. 1000 s
const series = [{ key: 'a', label: 'Wheel speed', unit: 'rpm', group: 'speed', values: Float64Array.from(time, (t) => t / 100) }];
const render = (props: Record<string, unknown>) => renderToString(createSSRApp({ render: () => h(FastChart, { time, series, ...props }) }));

const band = (operationId: string, startS: number, endS: number, current = false): RunWindowBand => ({ operationId, label: `Run ${operationId}`, startS, endS, current });

describe('FastChart run-window bands', () => {
	it('renders no band elements without bands (FAST is unchanged)', async () => {
		for (const html of [await render({}), await render({ bands: [] })]) {
			expect(html).toContain('<svg');
			expect(html).not.toContain('run-band');
			expect(html).not.toContain('wb-label');
		}
	});
	it('draws a labelled band for each window in view, the current one marked', async () => {
		const html = await render({ bands: [band('a', 100, 300), band('b', 500, 800, true)] });
		expect(html.match(/<g class="(?:current )?run-band"/g)).toHaveLength(2);
		expect(html.match(/class="current run-band"/g)).toHaveLength(1);
		expect(html).toContain('Run a');
		expect(html).toContain('Run b');
	});
	it('draws only the bands inside the zoomed view', async () => {
		const html = await render({ bands: [band('a', 100, 300), band('b', 500, 800)], viewStart: 450, viewEnd: 900 });
		expect(html.match(/<g class="(?:current )?run-band"/g)).toHaveLength(1);
		expect(html).toContain('Run b');
		expect(html).not.toContain('Run a');
	});
	it('draws the bands under the lines', async () => {
		const html = await render({ bands: [band('a', 100, 300)] });
		expect(html.indexOf('run-bands')).toBeLessThan(html.indexOf('class="line"'));
	});
	it('draws the current run as two edge lines and no wash when the view is on its window', async () => {
		const html = await render({ bands: [band('b', 500, 800, true)], viewStart: 490, viewEnd: 810 });
		expect(html.match(/class="wb-edge"/g)).toHaveLength(2);
		expect(html).not.toMatch(/class="wb"/);
	});
	it('washes the current run, and another run, when the view is further out', async () => {
		const html = await render({ bands: [band('a', 100, 300), band('b', 500, 800, true)] });
		expect(html.match(/class="wb"/g)).toHaveLength(2);
		expect(html).not.toContain('wb-edge');
	});
	it('prints the labels in the top margin only when asked (the top row of tiles)', async () => {
		const withLabels = await render({ bands: [band('a', 100, 300)], bandLabels: true });
		const without = await render({ bands: [band('a', 100, 300)], bandLabels: false });
		expect(withLabels).toContain('wb-label');
		expect(without).not.toContain('wb-label');
		expect(without).toContain('run-band');   // the band itself is still drawn
		// the label's baseline is above the plot area (the top margin), on the unit's line
		expect(withLabels).toMatch(/class="wb-label" x="[\d.]+" y="14"/);
	});
});

describe('FastChart time axis and hover time', () => {
	it('titles the axis "Time (min)" by default (FAST), or as the profile words it', async () => {
		expect(await render({})).toContain('>Time (min)</text>');
		expect(await render({ xTitle: 'Time since log start (min)' })).toContain('>Time since log start (min)</text>');
	});
});
