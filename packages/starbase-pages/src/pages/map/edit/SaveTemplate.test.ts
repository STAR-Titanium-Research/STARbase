import { describe, expect, it } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import SaveTemplate from './SaveTemplate.vue';
import TemplateManage from './TemplateManage.vue';
import type { TemplateInfo } from './templates';

const VIcon = defineComponent({ props: { name: String }, setup: (p) => () => h('i', { class: 'v-icon' }, p.name) });
const VButton = defineComponent({ props: { disabled: Boolean }, setup: (p, { slots }) => () => h('button', { class: 'v-button', disabled: p.disabled }, slots.default?.()) });
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

async function render(component: unknown, props: Record<string, unknown>): Promise<string> {
	const app = createSSRApp({ render: () => h(component as never, props) });
	app.component('v-icon', VIcon);
	app.component('v-button', VButton);
	return renderToString(app);
}

const save = (over: Record<string, unknown> = {}) =>
	render(SaveTemplate, { what: 'operation', name: 'CNC Turning', labels: ['Method', 'Machine', 'Tool'], hasNotes: false, problem: null, error: '', busy: false, ...over });

describe('SaveTemplate', () => {
	it('asks for a name (started with the method) and who can use it, private first', async () => {
		const html = await save();
		expect(html).toContain('role="dialog"');
		expect(html).toContain('aria-label="Save this operation as a template"');
		expect(html).toMatch(/<input[^>]*value="CNC Turning"/);
		const t = text(html);
		for (const word of ['Only me', 'My account role', 'Everyone']) expect(t).toContain(word);
		expect(html).toMatch(/<input checked[^>]*name="pm-tpl-scope"[^>]*value="private"/);
		expect(html).not.toMatch(/<input checked[^>]*value="role"/);
	});

	it('lists what it keeps and says it never keeps the sample or the dates', async () => {
		const t = text(await save());
		expect(t).toContain('Keeps: Method, Machine, Tool.');
		expect(t).toContain('Only the setup: the method or type, machine, tool, edge, operator and process settings. Never the sample, the dates, whether it is done, results, files or codes.');
		expect(text(await save({ labels: Array.from({ length: 11 }, (_, i) => `F${i}`) }))).toContain('F7, 3 more.');
	});

	it('for a restricted record offers only Only me and says why', async () => {
		const html = await save({ restricted: true });
		expect(text(html)).toContain('This record is restricted, so a template made from it can only be for Only me.');
		expect(html).toMatch(/name="pm-tpl-scope" value="role" disabled/);
		expect(html).toMatch(/name="pm-tpl-scope" value="global" disabled/);
		expect(html).not.toMatch(/name="pm-tpl-scope" value="private" disabled/);
		expect(await save()).not.toContain('data-restricted');
	});

	it('offers the notes only when there are some, unticked', async () => {
		expect(text(await save())).not.toContain('Keep the notes too');
		const html = await save({ hasNotes: true });
		expect(text(html)).toContain('Keep the notes too');
		expect(html).toMatch(/type="checkbox"(?![^>]*checked)/);
	});

	it('says why it cannot be saved instead of asking for a name', async () => {
		const html = await save({ problem: 'Choose the method of this operation first.' });
		expect(text(html)).toContain('Choose the method of this operation first.');
		expect(html).not.toContain('id="pm-tpl-name"');
		expect(html).toMatch(/<button class="v-button" disabled/);
	});

	it('says what the server said and keeps the dialog', async () => {
		expect(text(await save({ error: 'Your account may not build processes.' }))).toContain('Your account may not build processes.');
		expect(text(await save({ busy: true }))).toContain('Saving…');
	});
});

const info = (over: Partial<TemplateInfo> = {}): TemplateInfo => ({ id: 't1', name: 'Roughing', scope: 'private', collection: 'manufacturing_operations', mine: true, version: 1, ...over });
const manage = (over: Record<string, unknown> = {}) => render(TemplateManage, { info: info(), selectedKind: null, selectedTitle: '', busy: false, ...over });

describe('TemplateManage', () => {
	it('renames, shows the scope it has, replaces and deletes', async () => {
		const html = await manage({ info: info({ scope: 'role' }), selectedKind: 'operation', selectedTitle: 'CNC Turning' });
		expect(html).toContain('aria-label="Manage the template Roughing"');
		expect(html).toMatch(/<input[^>]*aria-label="Template name"/);
		expect(html).toMatch(/value="role" checked/);
		expect(html).not.toMatch(/value="private" checked/);
		const t = text(html);
		for (const word of ['Rename', "Replace with the selected card's settings", 'Delete']) expect(t).toContain(word);
	});

	it('cannot replace without a card of the same kind selected, and says what to select', async () => {
		expect(text(await manage())).toContain('Select the operation to take the settings from.');
		expect(text(await manage({ selectedKind: 'test' }))).toContain('Select an operation: this template is for operations.');
		const html = await manage({ selectedKind: 'test' });
		expect(html).toMatch(/<button[^>]*class="btn"[^>]*disabled[^>]*>Replace with/);
		expect(text(await manage({ info: info({ collection: 'test_sessions' }) }))).toContain('Select the test to take the settings from.');
	});
});
