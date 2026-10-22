import { describe, expect, it } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { DraftBody } from '@d1/ui';
import AddSearch from './AddSearch.vue';
import { apply, emptyBody, type DraftAction } from './draft';

const VIcon = defineComponent({ props: { name: String }, setup: (p) => () => h('i', { class: 'v-icon' }, p.name) });
const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);

const methods = [
	{ id: 'mt', name: 'Turning', code: 'MC', category: 'machining' as const },
	{ id: 'mf', name: 'FAST sintering', code: 'MF', category: 'sintering' as const },
];
const testTypes = [{ value: 'tensile', name: 'Tensile' }];

async function render(props: Record<string, unknown>): Promise<string> {
	const app = createSSRApp({ render: () => h(AddSearch as never, props) });
	app.component('v-icon', VIcon);
	return renderToString(app);
}
const base = { body: run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } }]), methods, testTypes };
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('AddSearch', () => {
	it('opened on a sample\'s output is a dialog with a search box and the methods and tests by section', async () => {
		const html = await render({ ...base, target: { sock: { kind: 'sample', id: 'draft:n1', side: 'out' }, at: { x: 10, y: 20 } } });
		expect(html).toContain('role="dialog"');
		expect(html).toContain('role="combobox"');
		expect(html).toContain('role="listbox"');
		const t = text(html);
		for (const word of ['What happens to this sample?', 'Machining', 'Turning', 'MC', 'FAST sintering', 'Tests', 'Tensile']) expect(t).toContain(word);
		expect(t).not.toContain('Existing sample');
	});

	it('has one status region, always mounted: empty while there are entries', async () => {
		const html = await render({ ...base, target: { sock: null, at: { x: 0, y: 0 } } });
		expect(html).toMatch(/<p class="(?:none empty|empty none)" role="status" aria-live="polite" aria-atomic="true"[^>]*><\/p>/);
		expect(html).not.toContain('role="alert"');
	});

	it('marks the first entry as the one Enter takes', async () => {
		const html = await render({ ...base, target: { sock: null, at: { x: 0, y: 0 } } });
		expect(html).toMatch(/id="[^"]*-opt-0"[^>]*aria-selected="true"/);
		expect(html).toMatch(/aria-activedescendant="[^"]*-opt-0"/);
	});

	it('unconnected is the whole catalog: the samples first, then the operations by category, then the tests', async () => {
		const t = text(await render({ ...base, target: { sock: null, at: { x: 0, y: 0 } } }));
		expect(t).toContain('Existing sample…');
		// A new sample is the "Sample" kind: the catalog's "New sample" is not listed beside it.
		expect(t).not.toContain('New sample');
	});

	it('unconnected lists the kinds first, and every method and test type after them', async () => {
		const t = text(await render({ ...base, target: { sock: null, at: { x: 0, y: 0 } } }));
		for (const word of ['Sample', 'Operation', 'Test', 'From database…', 'Turning', 'FAST sintering', 'Tensile']) expect(t).toContain(word);
		expect(t.indexOf('choose the kind on the card')).toBeLessThan(t.indexOf('Turning'));
		expect(t.indexOf('choose the type on the card')).toBeLessThan(t.indexOf('Tensile'));
		expect(t.match(/From database…/g)).toHaveLength(1);
	});

	it('opened on an operation\'s output offers the sample choices, Same sample greyed with its reason when nothing feeds it', async () => {
		const body = run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank' } }]);
		const html = await render({ ...base, body, target: { sock: { kind: 'row', id: 'draft:n2', side: 'out' }, at: { x: 0, y: 0 } } });
		const t = text(html);
		expect(t).toContain('What does this operation make?');
		expect(t).toContain('Existing sample…');
		expect(html).toMatch(/aria-disabled="true"[^>]*title="Wire a sample into this operation first\."/);
		expect(t).not.toContain('Turning');
	});

	it('is aria-modal, so the shell Ctrl/⌘+K does not open the Finder over it', async () => {
		expect(await render({ ...base, target: { sock: null, at: { x: 0, y: 0 } } })).toContain('aria-modal="true"');
	});

	it('lists what was added lately first, as its own group, each entry once', async () => {
		const html = await render({ ...base, recents: ['test:tensile', 'op:mf'], target: { sock: null, at: { x: 0, y: 0 } } });
		const t = text(html);
		expect(t.indexOf('Recent')).toBeLessThan(t.indexOf('Samples'));
		expect(t.indexOf('Tensile')).toBeLessThan(t.indexOf('FAST sintering'));
		expect(t.indexOf('FAST sintering')).toBeLessThan(t.indexOf('Machining'));
		expect(t.match(/Tensile/g)).toHaveLength(1);
		expect(html).toMatch(/id="[^"]*-opt-0"[^>]*aria-selected="true"[^>]*>\s*<span class="lab"[^>]*>Tensile/);
	});

	it('opened to insert before a card lists the operations only, with its own title', async () => {
		const t = text(await render({ ...base, target: { sock: null, at: { x: 0, y: 0 }, insert: { where: 'before', nodeId: 's:n1', what: 'S-0412-A' } } }));
		expect(t).toContain('Insert before S-0412-A');
		expect(t).toContain('Turning');
		expect(t).not.toContain('Tensile');
		expect(t).not.toContain('New sample');
	});
});
