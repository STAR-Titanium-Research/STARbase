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

	it('keeps its status region mounted when the card is hidden, with no text; only the card comes and goes', async () => {
		const hidden = await render({ sampleIds: [A], count: 2, show: false });
		expect(hidden).toMatch(/<p class="vh" role="status" aria-live="polite" aria-atomic="true"[^>]*><\/p>/);
		expect(hidden).not.toContain('Dismiss');
		expect(hidden).not.toContain('Print labels');
		const shown = await render({ sampleIds: [A], count: 2, show: true });
		expect(shown).toMatch(/role="status"[^>]*>Created 2 records\. Print labels for 1 new sample is available\.<\/p>/);
		expect(shown).toContain('Dismiss');
	});

	it('caps the link at 200 samples and says how many more there were', async () => {
		configureLinks(starbaseLinks(''));
		const ids = Array.from({ length: 205 }, (_, i) => `id${i}`);
		const html = await render({ sampleIds: ids, count: 210 });
		expect(text(html)).toContain('Print labels for 200 new samples');
		expect(text(html)).toContain('and 5 more are not in this link');
		const href = html.match(/href="([^"]*labels[^"]*)"/)![1];
		expect(href.split('=')[1].split(',')).toHaveLength(200);
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
