import { afterEach, describe, expect, it } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { configureLinks, resetLinks, starbaseLinks } from '@d1/ui';
import CreateToast from './CreateToast.vue';

const RouterLink = defineComponent({ props: { to: String }, setup: (p, { slots }) => () => h('a', { class: 'router-link', href: p.to }, slots.default?.()) });
async function render(props: Record<string, unknown>): Promise<string> {
	const app = createSSRApp(CreateToast, props);
	app.component('router-link', RouterLink);
	return renderToString(app);
}
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const A = '0b9c5a3e-1f2d-4c6b-8a7e-123456789abc';
const B = '1c0d6b4f-2a3e-4d7c-9b8f-23456789abcd';

afterEach(() => resetLinks());

describe('CreateToast', () => {
	it('says how many records were created, politely, as a status', async () => {
		const html = await render({ sampleIds: [A, B], count: 6 });
		expect(html).toContain('role="status"');
		expect(html).toContain('aria-live="polite"');
		expect(text(html)).toContain('Created 6 records');
	});

	it('offers to print labels for the new samples, linking to the labels page through AppLink', async () => {
		configureLinks(starbaseLinks(''));
		const html = await render({ sampleIds: [A, B], count: 6 });
		expect(text(html)).toContain('Print labels for 2 new samples');
		expect(html).toContain(`class="router-link labels" href="/labels?ids=${A},${B}"`);
	});

	it('in Data Studio the same link opens STARbase through the permanent link', async () => {
		const html = await render({ sampleIds: [A], count: 2 });
		expect(text(html)).toContain('Print labels for 1 new sample');
		expect(html).toContain(`href="/d1-links/go/p/labels?ids=${A}"`);
		expect(html).toContain('target="_blank"');
	});

	it('has no labels link when no sample was made', async () => {
		const html = await render({ sampleIds: [], count: 3 });
		expect(text(html)).toContain('Created 3 records');
		expect(html).not.toContain('Print labels');
	});

	it('has a Dismiss button', async () => {
		const html = await render({ sampleIds: [], count: 1 });
		expect(html).toMatch(/<button[^>]*aria-label="Dismiss"/);
	});

	it('never goes through the router by code or window.open', async () => {
		const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('./CreateToast.vue', import.meta.url), 'utf8'));
		expect(src).not.toMatch(/router\.push|window\.open|useRouter/);
	});
});
