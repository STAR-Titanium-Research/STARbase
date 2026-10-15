import { describe, expect, it } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { Check } from '@d1/ui';
import ChecksSection from './ChecksSection.vue';

const VIcon = defineComponent({ props: { name: String }, setup: (p) => () => h('i', { class: 'v-icon' }, p.name) });
async function render(props: Record<string, unknown>): Promise<string> {
	const app = createSSRApp(ChecksSection, props);
	app.component('v-icon', VIcon);
	return renderToString(app);
}
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const labelFor = (key: string) => ({ n1: 'Cut', n2: 'S-1', n3: 'Tensile test' })[key] ?? key;

const checks: Check[] = [
	{ key: 'n1', level: 'warn', text: 'No machine' },
	{ key: 'n3', level: 'block', text: 'No test type' },
	{ key: 'n1', level: 'block', text: 'No method' },
];

describe('ChecksSection', () => {
	it('is a Checks section whose empty state says Nothing missing', async () => {
		const html = await render({ checks: [], labelFor });
		expect(text(html)).toContain('Checks');
		expect(text(html)).toContain('Nothing missing');
		expect(html).not.toContain('<button');
	});

	it('lists each check as a button, grouped under the card it belongs to', async () => {
		const html = await render({ checks, labelFor });
		const buttons = [...html.matchAll(/<button[^>]*>/g)];
		expect(buttons).toHaveLength(3);
		expect(text(html)).toContain('Cut');
		expect(text(html)).toContain('Tensile test');
		expect(html.match(/data-card="n1"/g)).toHaveLength(1);
		expect(html.match(/data-card="n3"/g)).toHaveLength(1);
	});

	it('puts blocking first: cards with blocking checks, then the warning-only ones; blocking before warnings in a card', async () => {
		const html = await render({ checks: [...checks, { key: 'n2', level: 'warn', text: 'No date' }], labelFor });
		const order = [...html.matchAll(/data-card="(n\d)"/g)].map((m) => m[1]);
		expect(order).toEqual(['n1', 'n3', 'n2']);
		const n1 = html.slice(html.indexOf('data-card="n1"'), html.indexOf('data-card="n3"'));
		expect(n1.indexOf('No method')).toBeLessThan(n1.indexOf('No machine'));
	});

	it('marks blocking checks red and warnings apart, and says it in words for a screen reader', async () => {
		const html = await render({ checks, labelFor });
		expect(html).toContain('data-level="block"');
		expect(html).toContain('data-level="warn"');
		expect(text(html)).toContain('Missing: No method');
		expect(text(html)).toContain('Warning: No machine');
	});

	it('keeps one always-mounted live region, empty or not, whose text is swapped', async () => {
		const statusOf = (html: string) => html.match(/<p class="vh" role="status" aria-live="polite" aria-atomic="true"[^>]*>(.*?)<\/p>/)?.[1];
		expect(statusOf(await render({ checks: [], labelFor }))).toBe('Nothing missing');
		expect(statusOf(await render({ checks, labelFor }))).toBe('2 things missing, 1 warning');
		expect((await render({ checks, labelFor })).match(/role="status"/g)).toHaveLength(1);
		expect((await render({ checks: [], labelFor })).match(/role="status"/g)).toHaveLength(1);
	});

	it('summarises the counts', async () => {
		const html = await render({ checks, labelFor });
		expect(text(html)).toContain('2 things missing, 1 warning');
		const one = await render({ checks: [{ key: 'n1', level: 'warn', text: 'No machine' }], labelFor });
		expect(text(one)).toContain('1 warning');
		expect(text(one)).not.toContain('missing,');
	});
});
