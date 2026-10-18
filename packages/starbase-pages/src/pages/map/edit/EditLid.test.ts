import { describe, expect, it } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import EditLid from './EditLid.vue';

const VIcon = defineComponent({ props: { name: String }, setup: (p) => () => h('i', { class: 'v-icon' }, p.name) });
const VButton = defineComponent({ setup: (_p, { slots }) => () => h('button', { class: 'v-button' }, slots.default?.()) });

async function render(props: Record<string, unknown>, slots: Record<string, () => unknown> = {}): Promise<string> {
	const app = createSSRApp({ render: () => h(EditLid as never, props, slots) });
	app.component('v-icon', VIcon);
	app.component('v-button', VButton);
	return renderToString(app);
}
const base = { name: 'S-1 · 2026-10-14', canUndo: false, canRedo: true, drafts: [] };

describe('EditLid', () => {
	it('has undo, redo, Add with its key, Pick samples, the name and My drafts', async () => {
		const html = await render(base);
		expect(html).toContain('role="toolbar"');
		expect(html).toContain('aria-label="Undo"');
		expect(html).toContain('aria-label="Redo"');
		expect(html).toContain('Shift+A');
		expect(html).toContain('Pick samples');
		expect(html).toContain('value="S-1 · 2026-10-14"');
		expect(html).toContain('My drafts');
	});

	it('disables undo with nothing to undo and redo with nothing to redo', async () => {
		const html = await render(base);
		expect(html).toMatch(/<button[^>]*disabled[^>]*aria-label="Undo"|<button[^>]*aria-label="Undo"[^>]*disabled/);
		expect(html).not.toMatch(/<button[^>]*aria-label="Redo"[^>]*disabled/);
	});

	it('says whether the draft is kept: saving, kept, or the error', async () => {
		expect(await render(base)).toContain('Draft kept');
		expect(await render({ ...base, saving: true })).toContain('Saving…');
		const bad = await render({ ...base, saveError: 'Could not reach the server; your changes are kept here.' });
		expect(bad).toContain('Could not reach the server');
		expect(bad).not.toContain('Draft kept');
	});

	it('shows the notice of a draft that changed in another tab', async () => {
		expect(await render({ ...base, notice: 'This draft changed in another tab; reloaded.' })).toContain('changed in another tab');
		expect(await render(base)).not.toContain('class="note"');
	});

	it('has the slot the Create button goes in', async () => {
		const html = await render(base, { create: () => h('button', { id: 'create' }, 'Create 1 sample') });
		expect(html).toContain('Create 1 sample');
	});
});
