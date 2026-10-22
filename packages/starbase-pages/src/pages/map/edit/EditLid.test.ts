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
	it('has undo, redo, Add with its key, Pick samples, the name and the Draft menu', async () => {
		const html = await render(base);
		expect(html).toContain('role="toolbar"');
		expect(html).toContain('aria-label="Undo"');
		expect(html).toContain('aria-label="Redo"');
		expect(html).toContain('Shift+A');
		expect(html).toContain('Pick samples');
		expect(html).toContain('value="S-1 · 2026-10-14"');
		expect(html).toContain('aria-haspopup="menu"');
	});

	it('has a slot for the draft\'s project and campaign, in the draft group before the Draft menu', async () => {
		const html = await render(base, { scope: () => h('span', { class: 'the-scope' }, 'Project and campaign') });
		expect(html).toContain('the-scope');
		expect(html.indexOf('the-scope')).toBeLessThan(html.indexOf('aria-haspopup="menu"'));
		expect(await render(base)).not.toContain('the-scope');
	});

	it('has three groups, left to right: edit tools, the draft, Create', async () => {
		const html = await render(base, { scope: () => h('span', { class: 'the-scope' }, 'Project and campaign'), create: () => h('button', 'Create') });
		const parts = html.split('<span class="grp ').slice(1);
		expect(parts.map((p) => p.match(/^(\w+)" role="group"/)?.[1])).toEqual(['tools', 'draft', 'make']);
		const [tools, draft, make] = parts;
		const inOrder = (part: string, marks: string[]) => {
			const at = marks.map((m) => part.indexOf(m));
			return at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1]));
		};
		expect(inOrder(tools, ['aria-label="Undo"', 'aria-label="Redo"', 'Add', 'Pick samples', 'Tidy', 'aria-label="Remove"', 'aria-label="Dissolve"'])).toBe(true);
		expect(inOrder(draft, ['aria-label="Draft name"', 'the-scope', 'aria-haspopup="menu"'])).toBe(true);
		expect(make).toContain('Create');
		// Nothing of one group in another.
		expect(draft).not.toContain('Pick samples');
		expect(make).not.toContain('aria-label="Draft name"');
		expect(tools).not.toContain('aria-label="Draft name"');
	});

	it('has Remove and Dissolve, off until something is selected', async () => {
		const off = await render(base);
		expect(off).toMatch(/<button[^>]*disabled[^>]*aria-label="Remove"|<button[^>]*aria-label="Remove"[^>]*disabled/);
		expect(off).toMatch(/<button[^>]*disabled[^>]*aria-label="Dissolve"|<button[^>]*aria-label="Dissolve"[^>]*disabled/);
		const on = await render({ ...base, canRemove: true, canDissolve: true });
		expect(on).not.toMatch(/<button[^>]*aria-label="Remove"[^>]*disabled/);
		expect(on).not.toMatch(/<button[^>]*aria-label="Dissolve"[^>]*disabled/);
		expect(on).toContain('Delete');
		expect(on).toContain('Ctrl/⌘+Delete');
	});

	it('has Tidy, on only when the draft has cards', async () => {
		const off = await render(base);
		expect(off).toMatch(/<button[^>]*disabled[^>]*>(?:<i[^>]*>[^<]*<\/i>)?Tidy/);
		const on = await render({ ...base, canTidy: true });
		expect(on).toContain('Tidy');
		expect(on).not.toMatch(/disabled[^>]*>(?:<i[^>]*>[^<]*<\/i>)?Tidy/);
	});

	it('disables undo with nothing to undo and redo with nothing to redo', async () => {
		const html = await render(base);
		expect(html).toMatch(/<button[^>]*disabled[^>]*aria-label="Undo"|<button[^>]*aria-label="Undo"[^>]*disabled/);
		expect(html).not.toMatch(/<button[^>]*aria-label="Redo"[^>]*disabled/);
	});

	it('keeps the save status out of the bar: it is in the Draft menu, and a failed save marks the Draft button', async () => {
		const ok = await render(base);
		expect(ok).not.toContain('Draft kept');
		expect(ok).not.toContain('Saving…');
		expect(ok).not.toContain('My drafts');
		expect(ok).toMatch(/<button[^>]*class="ob"[^>]*>Draft/);
		const bad = await render({ ...base, saveError: 'Could not reach the server; your changes are kept here.' });
		expect(bad).toMatch(/<button[^>]*class="bad ob"[^>]*title="Could not reach the server/);
		expect(bad).toContain('role="alert"');
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
