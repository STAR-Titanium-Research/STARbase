// @vitest-environment happy-dom
// The plot buttons of a list row: a Conform run with a log linked gets a Conform button that opens the Conform plotter.
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import type { App } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { configureLinks, resetLinks, starbaseLinks } from '../links';
import RowPlotButtons from './RowPlotButtons.vue';
import type { RowPlots } from './plotData';

let app: App | null = null;
afterEach(() => {
	app?.unmount();
	app = null;
	resetLinks();
	document.body.innerHTML = '';
});

async function render(plots: RowPlots | null, collection = 'manufacturing_operations'): Promise<HTMLElement> {
	app?.unmount();
	configureLinks(starbaseLinks(''));
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
	const el = document.createElement('div');
	document.body.appendChild(el);
	app = createApp({ render: () => h(RowPlotButtons, { collection, id: 'op-1', label: 'CF-12', plots }) });
	app.use(router);
	app.mount(el);
	await nextTick();
	return el;
}

describe('RowPlotButtons', () => {
	it('shows a Conform button to the plotter for a run with a log', async () => {
		const el = await render({ force: false, fast: false, conform: true, frmFz: null });
		const a = el.querySelector('a');
		expect(a?.textContent).toBe('Conform');
		expect(a?.getAttribute('href')).toBe('/plot/conform?operation=op-1');
		expect(a?.getAttribute('aria-label')).toBe('Conform plotter for CF-12');
	});

	it('shows nothing for a run without one, and no Conform button on a sample row', async () => {
		expect((await render({ force: false, fast: false, frmFz: null })).querySelector('a')).toBeNull();
		expect((await render({ force: false, fast: false, conform: true, frmFz: null, forceCount: 0 }, 'physical_samples')).querySelector('a')).toBeNull();
	});
});
