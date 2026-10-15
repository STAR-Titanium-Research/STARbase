import { describe, expect, it } from 'vitest';
import { createSSRApp, defineComponent, h, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { setExplorerHostFactory } from '@d1/ui';
import type { ExplorerHost } from '@d1/ui';
import MarkDoneDialog from './MarkDoneDialog.vue';

const VIcon = defineComponent({ props: { name: String }, setup: (p) => () => h('i', { class: 'v-icon' }, p.name) });
setExplorerHostFactory(() => ({
	api: { get: async () => ({ data: { data: [] } }) },
	user: ref({ id: 'u1' }),
}) as unknown as ExplorerHost);

/** The dialog teleports to <body>: its markup comes back in `teleports`. */
async function render(props: Record<string, unknown>): Promise<{ page: string; dialog: string }> {
	const app = createSSRApp(MarkDoneDialog, props);
	app.component('v-icon', VIcon);
	const ctx: { teleports?: Record<string, string> } = {};
	const page = await renderToString(app, ctx);
	return { page, dialog: ctx.teleports?.body ?? '' };
}
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const base = { open: true, collection: 'manufacturing_operations', ids: ['o1'], title: 'Mark Cut MF-12 done' };
const today = (() => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();

describe('MarkDoneDialog', () => {
	it('draws nothing while closed', async () => {
		const { dialog } = await render({ ...base, open: false });
		expect(dialog).not.toContain('role="dialog"');
	});

	it('is an accessible modal dialog named by its title', async () => {
		const { dialog } = await render(base);
		expect(dialog).toContain('role="dialog"');
		expect(dialog).toContain('aria-modal="true"');
		const labelled = dialog.match(/aria-labelledby="([^"]+)"/)?.[1];
		expect(labelled).toBeTruthy();
		expect(dialog).toContain(`id="${labelled}"`);
		expect(text(dialog)).toContain('Mark Cut MF-12 done');
		expect(dialog).toContain('aria-label="Close"');
	});

	it('asks the date, defaulting to today, and who did it with a people picker', async () => {
		const { dialog } = await render(base);
		expect(text(dialog)).toContain('Date done');
		expect(dialog).toContain('type="date"');
		expect(dialog).toContain(`value="${today}"`);
		expect(text(dialog)).toContain('Done by');
		expect(dialog).toContain('role="combobox"');
	});

	it('has Cancel and Mark done, the latter enabled with a valid date', async () => {
		const { dialog } = await render(base);
		expect(text(dialog)).toContain('Cancel');
		const mark = [...dialog.matchAll(/<button[^>]*>[^<]*Mark done[^<]*<\/button>/g)].map((m) => m[0]);
		expect(mark).toHaveLength(1);
		expect(mark[0]).not.toContain('disabled');
	});

	it('says how many records go together', async () => {
		const one = await render(base);
		expect(text(one.dialog)).toContain('Say when it was done and who did it.');
		const many = await render({ ...base, ids: ['o1', 'o2', 'o3'] });
		expect(text(many.dialog)).toContain('All 3 operations');
		const tests = await render({ ...base, collection: 'test_sessions', ids: ['t1', 't2'] });
		expect(text(tests.dialog)).toContain('All 2 tests');
	});

	it('shows the refusal checks in place, as an alert', async () => {
		const checks = [
			{ key: 'n1', level: 'block', text: 'Feed is required for a done operation' },
			{ key: 'n1', level: 'warn', text: 'No machine' },
		];
		const { dialog } = await render({ ...base, checks });
		const alert = dialog.slice(dialog.indexOf('role="alert"'));
		expect(alert).toContain('Feed is required for a done operation');
		expect(alert).toContain('data-level="warn"');
		expect(text(alert)).toContain('Not marked done yet');
	});

	it('shows no refusal block when nothing was refused', async () => {
		const { dialog } = await render({ ...base, checks: [] });
		expect(dialog).not.toContain('role="alert"');
	});

	it('while busy: the buttons are aria-disabled (focus stays inside) and Mark done says it is working', async () => {
		const { dialog } = await render({ ...base, busy: true });
		expect(text(dialog)).toContain('Marking done…');
		expect(dialog).toContain('aria-busy="true"');
		for (const b of dialog.matchAll(/<button[^>]*>/g)) {
			expect(b[0]).toContain('aria-disabled="true"');
			expect(b[0]).not.toMatch(/\sdisabled(=|\s|>)/); // a disabled button cannot hold focus, so it would throw it out
		}
	});

	it('is not aria-disabled when idle', async () => {
		const { dialog } = await render(base);
		expect(dialog).not.toContain('aria-disabled');
	});
});
