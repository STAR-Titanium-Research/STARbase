import { describe, expect, it } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import Palette from './Palette.vue';
import { catalogEntries } from './menuModel';

const VIcon = defineComponent({ props: { name: String }, setup: (p) => () => h('i', { class: 'v-icon' }, p.name) });
const entries = catalogEntries({
	methods: [
		{ id: 'mt', name: 'CNC Turning', code: 'MC', category: 'machining' },
		{ id: 'mf', name: 'FAST/SPS Sintering', code: 'MF', category: 'sintering' },
	],
	testTypes: [{ value: 'tensile', name: 'Tensile' }],
});
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

async function render(props: Record<string, unknown>): Promise<string> {
	const app = createSSRApp({ render: () => h(Palette as never, { entries, grouped: true, folded: false, drag: null, consumeClick: () => false, ...props }) });
	app.component('v-icon', VIcon);
	return renderToString(app);
}

describe('Palette', () => {
	it('is an aside named Palette with a search box, section headers and every entry a button', async () => {
		const html = await render({});
		expect(html).toContain('<aside');
		expect(html).toContain('aria-label="Palette"');
		expect(html).toContain('type="search"');
		expect(html).toContain('aria-label="Search the palette"');
		const t = text(html);
		for (const word of ['Samples', 'New sample', 'Existing sample…', 'Machining', 'CNC Turning', 'MC', 'FAST/SPS Sintering', 'Tests', 'Tensile']) expect(t).toContain(word);
		expect(html.match(/class="[^"]*\bpe\b/g)).toHaveLength(entries.length);
	});

	it('every entry that can be added is a drag source, and says how; Existing sample… is not one', async () => {
		const html = await render({});
		const tag = (id: string) => html.match(new RegExp(`<button[^>]*data-entry="${id}"[^>]*>`))?.[0] ?? '';
		expect(tag('op:mt')).toMatch(/class="[^"]*\bdrag\b/);
		expect(tag('op:mt')).toContain('title="Drag onto the canvas, a socket or a wire. Enter adds it."');
		expect(tag('sample:pick')).not.toMatch(/\bdrag\b/);
	});

	it('folds to a rail: no search, no entries, a button that opens it', async () => {
		const html = await render({ folded: true });
		expect(html).toContain('aria-label="Open the palette"');
		expect(html).toContain('aria-expanded="false"');
		expect(html).not.toContain('type="search"');
		expect(html).not.toContain('data-entry=');
	});

	it('unfolded, its fold button says so', async () => {
		const html = await render({});
		expect(html).toContain('aria-label="Fold the palette"');
		expect(html).toContain('aria-expanded="true"');
	});

	it('a ranked answer (something typed) has no headers, and says each entry\'s category; nothing found says so', async () => {
		const html = await render({ grouped: false, entries: entries.filter((e) => e.label === 'CNC Turning') });
		expect(html).not.toContain('class="sec"');
		expect(text(html)).toContain('Machining');
		expect(text(await render({ entries: [] }))).toContain('Nothing fits what you typed.');
	});
});
