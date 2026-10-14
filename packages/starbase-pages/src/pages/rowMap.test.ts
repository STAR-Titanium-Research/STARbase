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
		expect(html).toContain('href="/map?focus=tools:t1"');
		expect(html).toContain('aria-label="Process map of T-07"');
		expect(html).toContain('Process map');
	});

	it('renders nothing for any other collection', async () => {
		for (const c of ['physical_samples', 'manufacturing_operations', 'tool_boxes', 'etchants']) {
			expect(await render({ collection: c, id: 'x' })).not.toContain('Process map');
		}
	});
});
