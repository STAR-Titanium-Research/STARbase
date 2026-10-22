import { describe, expect, it } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import Palette from './Palette.vue';
import { catalogEntries, kindEntries } from './menuModel';
import type { TemplateItem } from './templates';

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

	it('lists the kinds with the map\'s icon and colour: Sample, Operation, Test; From database… keeps its plain look', async () => {
		const html = await render({ entries: kindEntries() });
		const tag = (id: string) => html.match(new RegExp(`<button[^>]*data-entry="${id}"[^>]*>.*?</button>`))?.[0] ?? '';
		expect(html.match(/class="[^"]*\bpe\b/g)).toHaveLength(4);
		expect(text(html)).toContain('Add');
		for (const [id, icon, color] of [['kind:sample', 'science', '--k-sample'], ['kind:operation', 'settings', '--k-op'], ['kind:test', 'fact_check', '--k-test']]) {
			expect(tag(id), id).toMatch(new RegExp(`<i class="v-icon ki"[^>]*>${icon}</i>`));
			expect(tag(id), id).toContain(`--k:var(${color})`);
		}
		expect(tag('kind:operation')).toContain('choose the kind on the card');
		expect(tag('db:attach')).not.toContain('v-icon');
		expect(tag('db:attach')).not.toContain('--k:');
		// Every one can be added by a click or a drag.
		for (const id of ['kind:sample', 'kind:operation', 'kind:test', 'db:attach']) expect(tag(id)).toMatch(/class="[^"]*\bdrag\b/);
	});

	it('says how to add: click, Enter or drag', async () => {
		expect(text(await render({}))).toContain('Click, Enter or drag to add.');
	});

	it('every entry that can be added is a drag source, and says how; Existing sample… is not one', async () => {
		const html = await render({});
		const tag = (id: string) => html.match(new RegExp(`<button[^>]*data-entry="${id}"[^>]*>`))?.[0] ?? '';
		expect(tag('op:mt')).toMatch(/class="[^"]*\bdrag\b/);
		expect(tag('op:mt')).toContain('title="Click, Enter or drag to add."');
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

describe('Palette templates (R7)', () => {
	const tpl = (id: string, name: string, extra: Partial<TemplateItem> = {}): TemplateItem => ({
		rec: { id, name, scope: 'private', role_id: null, collection: 'manufacturing_operations', values: { method_id: 'mt' }, user_id: 'u1', updated_at: 'now', version: 1 },
		mine: true,
		...extra,
	});
	const withTemplates = (items: TemplateItem[]) =>
		catalogEntries({ methods: [{ id: 'mt', name: 'CNC Turning', code: 'MC', category: 'machining' }], testTypes: [], templates: items });
	const html = (items: TemplateItem[], props: Record<string, unknown> = {}) => render({ entries: withTemplates(items), ...props });

	it('lists the Templates group first, each a drag source', async () => {
		const out = await html([tpl('t1', 'Roughing pass')]);
		expect(out.indexOf('Templates')).toBeLessThan(out.indexOf('Samples'));
		const tag = out.match(/<button[^>]*data-entry="tpl:t1"[^>]*>/)?.[0] ?? '';
		expect(tag).toMatch(/class="[^"]*\bdrag\b/);
		expect(text(out)).toContain('Roughing pass');
		expect(text(out)).toContain('CNC Turning');
	});

	it('has no Templates group while there are none', async () => {
		const out = await html([]);
		expect(text(out)).not.toContain('Templates');
	});

	it('gives a manage button only for a template the person made', async () => {
		const out = await html([tpl('t1', 'Mine'), tpl('t2', 'Theirs', { mine: false })]);
		expect(out).toContain('aria-label="Manage the template Mine"');
		expect(out).not.toContain('Manage the template Theirs');
	});

	it('greys a template that names retired gear and says why, still a button to use', async () => {
		const out = await html([tpl('t1', 'Old tool', { warn: 'The tool Holder 3 is retired.' })]);
		const tag = out.match(/<button[^>]*data-entry="tpl:t1"[^>]*>/)?.[0] ?? '';
		expect(tag).toMatch(/\bgrey\b/);
		expect(tag).not.toContain('disabled');
		expect(out).toContain('data-warning');
		expect(text(out)).toContain('The tool Holder 3 is retired.');
	});

	it('a template whose method is gone cannot be dragged or added, and says why', async () => {
		const out = await render({ entries: catalogEntries({ methods: [{ id: 'mt', name: 'CNC Turning', code: 'MC', category: 'machining' }], testTypes: [], templates: [tpl('t1', 'Orphan', { rec: { ...tpl('t1', 'Orphan').rec, values: { method_id: 'gone' } } })] }) });
		const tag = out.match(/<button[^>]*data-entry="tpl:t1"[^>]*>/)?.[0] ?? '';
		expect(tag).not.toMatch(/\bdrag\b/);
		expect(tag).toContain('aria-disabled="true"');
		expect(text(out)).toContain('no longer in the list of methods');
	});

	it('says what was done to a template, or what failed, above the list', async () => {
		const ok = await html([], { templateNotice: 'Saved the template Roughing.' });
		expect(ok).toContain('data-template-notice');
		expect(text(ok)).toContain('Saved the template Roughing.');
		expect(ok).not.toMatch(/class="bad note"/);
		const bad = await html([], { templateNotice: 'Only the person who made a template can change it.', templateFailed: true });
		expect(bad).toMatch(/class="bad note"/);
		expect(text(await html([]))).not.toContain('Saved the template');
	});
});
