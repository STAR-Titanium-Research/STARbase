import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { RowMapButton, configureLinks, resetLinks, starbaseLinks } from '@d1/ui';

// The index row action lives in @d1/ui (whose vitest cannot compile .vue), so its render test is here.
const VIcon = defineComponent({ props: { name: String }, setup: (p) => () => h('i', { class: 'v-icon' }, p.name) });
const RouterLink = defineComponent({ props: { to: [String, Object] }, setup: (p, { slots }) => () => h('a', { href: String(p.to) }, slots.default?.()) });

async function render(props: Record<string, unknown>): Promise<string> {
	const app = createSSRApp({ render: () => h(RowMapButton, props as never) });
	app.component('v-icon', VIcon);
	app.component('router-link', RouterLink);
	return renderToString(app);
}

describe('RowMapButton', () => {
	beforeEach(() => configureLinks(starbaseLinks('')));
	afterEach(() => resetLinks());

	it('renders a Process map link for the seven kinds, named for the row', async () => {
		const html = await render({ collection: 'tools', id: 't1', label: 'T-07' });
		expect(html).toMatch(/<a [^>]*href="\/map\?focus=tools:t1"/);
		expect(html).toContain('aria-label="Process map of T-07"');
		expect(html).toMatch(/<\/i>Process map\s*(<!--\]-->)?\s*<\/a>/); // the visible label, apart from the accessible name
		expect(html).toContain('title="Open the Process map"');
	});

	it('renders nothing for any other collection', async () => {
		for (const c of ['physical_samples', 'manufacturing_operations', 'tool_boxes', 'etchants']) {
			expect(await render({ collection: c, id: 'x' })).not.toContain('Process map');
		}
	});
});

// The rail button of each record page opens the map on that page's own record: the right collection, the page's id.
describe('record page Process map buttons', () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const pages: [string, string][] = [
		['SamplePage.vue', 'physical_samples'],
		['OperationPage.vue', 'manufacturing_operations'],
		['TestPage.vue', 'test_sessions'],
		['ProjectPage.vue', 'projects'],
		['CampaignPage.vue', 'campaigns'],
	];
	it.each(pages)('%s builds mapPath(%s, id) and puts it on a Process map button', (file, collection) => {
		const src = readFileSync(join(here, file), 'utf8');
		expect(src).toContain(`const mapTo = computed(() => mapPath('${collection}', props.id));`);
		expect(src).toMatch(/<v-button [^>]*:to="mapTo" title="Process map" aria-label="Process map">/);
	});
});
