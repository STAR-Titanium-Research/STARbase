import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSSRApp, reactive, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { indexDefBySlug } from '../index/indexConfig';
import BulkDialog from './BulkDialog.vue';
import BulkMenu from './BulkMenu.vue';
import UndoToast from './UndoToast.vue';
import { bulkEntries, startToast, tickToast, undoDone } from './bulkModel';
import type { ToastModel } from './bulkModel';
import type { BulkState } from './useBulkActions';

const samples = indexDefBySlug('samples')!;
const entries = bulkEntries(samples);
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('BulkMenu', () => {
	const render = (count: number) => renderToString(createSSRApp(BulkMenu, { entries, count }));
	it('is "With selected" and aria-disabled with nothing ticked', async () => {
		const html = await render(0);
		expect(text(html)).toContain('With selected');
		expect(html).toContain('aria-disabled="true"');
		expect(html).toContain('aria-haspopup="menu"');
	});
	it('counts the ticked rows and is enabled', async () => {
		const html = await render(4);
		expect(text(html)).toContain('With 4 selected');
		expect(html).toContain('aria-disabled="false"');
		expect(html).not.toContain('role="menuitem"');
	});
});

describe('UndoToast', () => {
	const t0 = 1_000_000;
	const toast = (over: Partial<ToastModel> = {}): ToastModel => ({ ...startToast('a1', 'Set status to Archived on 38 samples', t0 + 60_000, [], t0), ...over });
	const render = (t: ToastModel) => renderToString(createSSRApp(UndoToast, { toast: t }));

	it('pending: the result, a ring, the seconds for reduced motion, an Undo button and a polite status region', async () => {
		const html = await render(toast());
		expect(text(html)).toContain('Set status to Archived on 38 samples');
		expect(html).toContain('role="status"');
		expect(html).toContain('aria-live="polite"');
		expect(html).toContain('<svg');
		expect(html).toMatch(/<span[^>]*class="secs"[^>]*aria-hidden="true"[^>]*>60 s left to undo/);
		expect(html).toMatch(/<button[^>]*class="undo"[^>]*>Undo<\/button>/);
	});
	it('says a busy undo and cannot be pressed twice', async () => {
		const html = await render(toast({ busy: true }));
		expect(html).toMatch(/<button[^>]*class="undo"[^>]*disabled[^>]*>Undoing…<\/button>/);
	});
	it('shows a failed undo as an alert and keeps Undo', async () => {
		const html = await render(toast({ error: 'The undo window has closed.' }));
		expect(html).toMatch(/<p[^>]*class="err"[^>]*role="alert"[^>]*>The undo window has closed\./);
		expect(html).toContain('>Undo<');
	});
	it('ends as Done with no ring and no Undo', async () => {
		const html = await render(tickToast(toast(), t0 + 60_000));
		expect(text(html)).toContain('Done');
		expect(html).not.toContain('<svg');
		expect(html).not.toContain('class="undo"');
	});
	it('ends as Undone and lists what the undo left alone, under its own count', async () => {
		const t = undoDone(toast(), [{ id: 'x', revert_outcome: 'changed_since' }], new Map([['x', 'S-9']]));
		const html = await render(t);
		expect(text(html)).toContain('Undone');
		expect(text(html)).toContain('1 left as it is');
		expect(text(html)).toContain('S-9');
		expect(text(html)).toContain('Changed since, so it was left as it is');
	});
	it('folds the skipped rows under "12 skipped"', async () => {
		const skipped = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, code: `S-${i}`, reason: 'You are not the owner' }));
		const html = await render(toast({ skipped }));
		expect(html).toContain('<details');
		expect(text(html)).toContain('12 skipped');
		expect(text(html)).toContain('You are not the owner (12)');
	});
});

describe('BulkDialog', () => {
	function state(over: Record<string, unknown> = {}) {
		const dialog = ref({ entry: entries.find((e) => e.id === 'field:current_status')!, ids: ['a', 'b'], choice: { value: 'archived' } as { value: string | boolean | null } | null });
		return reactive({
			dialog, preview: { loading: false, rows: [{ id: 'a', code: 'S-1', status: 'ok' }, { id: 'b', code: 'S-2', status: 'skip', reason: 'You are not the owner' }], error: '' },
			applying: false, applyError: '', fieldOptions: [], optionsState: { loading: false, error: '' }, toasts: [],
			counts: { ok: 1, noop: 0, skip: 1 }, summary: '1 can be changed. 1 will be skipped', skipGroups: [], warnings: ['They may lose access.'], ready: true,
			open() {}, close() {}, choose() {}, apply() {}, undo() {}, dismiss() {}, ...over,
		}) as unknown as BulkState;
	}
	async function render(bulk: BulkState): Promise<string> {
		const app = createSSRApp(BulkDialog, { bulk, def: samples, restoreFocus: () => {} });
		const ctx: { teleports?: Record<string, string> } = {};
		await renderToString(app, ctx);
		return ctx.teleports?.body ?? '';
	}

	it('is a labelled modal dialog with the title, the target, the preview, the skips and Apply to N', async () => {
		const html = await render(state());
		expect(html).toContain('role="dialog"');
		expect(html).toContain('aria-modal="true"');
		expect(html).toMatch(/aria-labelledby="(d1-bulk-[a-z0-9]+)-title"/);
		expect(text(html)).toContain('Edit status for 2 samples');
		expect(text(html)).toContain('New status');
		expect(text(html)).toContain('Archived');
		expect(text(html)).toContain('1 can be changed. 1 will be skipped');
		expect(text(html)).toContain('They may lose access.');
		expect(text(html)).toContain('Why is 1 skipped?');
		expect(html).toMatch(/<button[^>]*class="btn primary"[^>]*>Apply to 1<\/button>/);
		expect(html).not.toMatch(/<button[^>]*class="btn primary"[^>]*disabled/);
	});
	it('disables Apply when nothing can change', async () => {
		const html = await render(state({ ready: false, counts: { ok: 0, noop: 0, skip: 2 } }));
		expect(html).toMatch(/<button[^>]*class="btn primary"[^>]*disabled[^>]*>Apply to 0<\/button>/);
	});
	it('shows errors as alerts that say what to do next', async () => {
		const html = await render(state({ applyError: 'Something broke.', preview: { loading: false, rows: null, error: 'Server down.' } }));
		expect(html).toMatch(/<p[^>]*class="err"[^>]*role="alert"[^>]*>The change failed: Something broke\./);
		expect(html).toMatch(/<p[^>]*class="err"[^>]*role="alert"[^>]*>The check failed: Server down\. Nothing has been changed\. Close this and try again\./);
	});
	it('asks to choose a value before it can preview, and offers Clear only on a link field', async () => {
		const open = state({ preview: { loading: false, rows: null, error: '' } });
		(open.dialog as any).choice = null;
		const html = await render(open);
		expect(text(html)).toContain('Choose a value to see what would change.');
		expect(text(html)).not.toContain('instead');
		const project = state();
		(project.dialog as any).entry = entries.find((e) => e.id === 'field:project_id');
		expect(text(await render(project))).toContain('Clear project instead');
	});
	it('needs no target for Restrict and says what it does', async () => {
		const b = state();
		(b.dialog as any).entry = entries.find((e) => e.id === 'restrict');
		const html = await render(b);
		expect(text(html)).toContain('Restrict 2 samples');
		expect(text(html)).not.toContain('New ');
		expect(text(html)).toContain('seen only by the people listed');
	});
	it('draws nothing while closed', async () => {
		const b = state();
		(b as any).dialog = null;
		expect(await render(b)).not.toContain('role="dialog"');
	});
});

// The rules every bulk component follows (DESIGN.md): tokens, the 11px floor, the layer bands, reduced motion, no SDK.
describe('bulk component sources', () => {
	const dir = new URL('./', import.meta.url);
	const files = readdirSync(dir).filter((f) => f.endsWith('.vue') || (f.endsWith('.ts') && !f.endsWith('.test.ts')));
	const src = (f: string) => readFileSync(new URL(f, dir), 'utf8');

	it('has files and none over 400 lines', () => {
		expect(files.length).toBeGreaterThanOrEqual(8);
		for (const f of files) expect(src(f).split('\n').length, f).toBeLessThanOrEqual(400);
	});
	it('imports nothing from the Directus extensions SDK', () => {
		for (const f of files) expect(src(f), f).not.toMatch(/@directus\/extensions-sdk/);
	});
	it('uses no raw hex colour and no font-size under 11px', () => {
		for (const f of files.filter((x) => x.endsWith('.vue'))) {
			const css = src(f).split('<style')[1] ?? '';
			expect(css, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
			for (const m of css.matchAll(/font-size:\s*(?:var\(--fs-[a-z0-9]+,\s*)?(\d+)px/g)) expect(Number(m[1]), f).toBeGreaterThanOrEqual(11);
		}
	});
	it('sits in the dialog and toast layer bands', () => {
		expect(src('BulkDialog.vue')).toMatch(/z-index:\s*100;/);
		expect(src('BulkLayer.vue')).toMatch(/z-index:\s*1000;/);
		expect(src('BulkMenu.vue')).toMatch(/z-index:\s*50;/);
	});
	it('drops the ring motion and shows the seconds under prefers-reduced-motion', () => {
		const toast = src('UndoToast.vue');
		const reduced = toast.slice(toast.indexOf('@media (prefers-reduced-motion: reduce)'));
		expect(reduced).toContain('transition: none');
		expect(reduced).toContain('stroke-dashoffset: 0');
		expect(reduced).toMatch(/\.secs\s*\{\s*display:\s*block/);
	});
});
