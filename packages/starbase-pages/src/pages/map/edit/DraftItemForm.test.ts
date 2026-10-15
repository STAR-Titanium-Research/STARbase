import { afterEach, describe, expect, it } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { setExplorerHostFactory } from '@d1/ui';
import type { ExplorerHost } from '@d1/ui';
import type { DraftItem } from '@d1/ui';
import DraftItemForm from './DraftItemForm.vue';
import { keySettingsFor } from './draftForm';

const VIcon = defineComponent({ props: { name: String }, setup: (p) => () => h('i', { class: 'v-icon' }, p.name) });
const calls: string[] = [];
setExplorerHostFactory(() => ({ api: { get: async (path: string) => { calls.push(path); return { data: { data: [] } }; } } }) as unknown as ExplorerHost);
afterEach(() => { calls.length = 0; });

async function render(props: Record<string, unknown>): Promise<string> {
	const app = createSSRApp(DraftItemForm, props);
	app.component('v-icon', VIcon);
	return renderToString(app);
}
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const row = (html: string, field: string): string => {
	const start = html.indexOf(`data-field="${field}"`);
	if (start < 0) return '';
	const next = html.indexOf('data-field="', start + 10);
	return html.slice(start, next < 0 ? undefined : next);
};

const def = (field: string, meta: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
	field, type: 'string', schema: { data_type: 'text', is_nullable: true }, meta: { interface: 'input', sort: null, width: 'half', ...meta }, ...extra,
});
const showWhenMachining = [{ name: 'machining', rule: { _and: [{ process_category: { _eq: 'machining' } }] }, hidden: false }];
const OPERATION_DEFS = [
	def('operation_id', {}, { schema: { is_primary_key: true } }),
	def('process_category', { interface: 'd1-process-category', translations: [{ language: 'en-US', translation: 'Process Category' }], sort: 1 }),
	def('pass_code', { interface: 'd1-operation-code', sort: 2 }),
	def('sample_id', { interface: 'select-dropdown-m2o', special: ['m2o'], sort: 3 }, { schema: { foreign_key_table: 'physical_samples', foreign_key_column: 'sample_id' } }),
	def('work_state', { interface: 'select-dropdown', options: { choices: [{ text: 'Planned', value: 'planned' }] }, sort: 4 }),
	def('planned_date', { interface: 'datetime', sort: 5 }, { type: 'date', schema: { data_type: 'date' } }),
	def('machining_cutting_speed_m_per_min', { hidden: true, conditions: showWhenMachining, sort: 6, options: { suffix: 'm/min' } }, { type: 'decimal', schema: { data_type: 'numeric' } }),
	def('machining_feed_mm_per_rev', { hidden: true, conditions: showWhenMachining, sort: 7 }, { type: 'decimal', schema: { data_type: 'numeric' } }),
	def('notes', { interface: 'input-multiline', sort: 8 }, { type: 'text' }),
	def('operation_date', { interface: 'datetime', sort: 9 }, { type: 'date', schema: { data_type: 'date' } }),
	def('machine_note', { required: true, sort: 10, translations: [{ language: 'en-US', translation: 'Machine note' }] }),
];
const SAMPLE_DEFS = [
	def('sample_code', { interface: 'd1-sample-code', sort: 1 }),
	def('nickname', { sort: 2 }),
	def('form', { interface: 'select-dropdown', options: { choices: [{ text: 'Disc', value: 'disc' }, { text: 'Bar', value: 'bar' }] }, sort: 3 }),
	def('current_status', { interface: 'select-dropdown', options: { choices: [{ text: 'Planned', value: 'planned' }] }, sort: 4 }),
];

const operation = (values: Record<string, unknown> = {}, over: Partial<DraftItem> = {}): DraftItem =>
	({ key: 'n2', kind: 'operation', workState: 'planned', values, rows: [{ key: 'n3' }], ...over }) as DraftItem;
const sample = (values: Record<string, unknown> = {}, over: Partial<DraftItem> = {}): DraftItem => ({ key: 'n1', kind: 'sample', values, ...over }) as DraftItem;

describe('DraftItemForm', () => {
	it('draws the form of the item\'s collection', async () => {
		const html = await render({ item: operation({ process_category: 'machining' }), fieldDefs: OPERATION_DEFS });
		expect(html).toContain('d1-field-form');
		expect(html).toContain('data-field="planned_date"');
		expect(row(html, 'notes')).toContain('<textarea');
	});

	it('hides what the draft sets itself, and the codes of a new record', async () => {
		const html = await render({ item: operation({ process_category: 'machining' }), fieldDefs: OPERATION_DEFS });
		for (const f of ['operation_id', 'sample_id', 'work_state', 'pass_code']) expect(html).not.toContain(`data-field="${f}"`);
		const s = await render({ item: sample(), fieldDefs: SAMPLE_DEFS });
		expect(s).not.toContain('data-field="sample_code"');
		expect(s).not.toContain('data-field="current_status"');
		expect(s).toContain('data-field="nickname"');
	});

	it('shows the process category as read-only text, not as "Open in Data Studio"', async () => {
		const html = await render({ item: operation(), fieldDefs: OPERATION_DEFS, inherited: { process_category: 'machining' } });
		const r = row(html, 'process_category');
		expect(r).toContain('value="machining"');
		expect(r).toContain('disabled');
		expect(text(r)).not.toContain('Open in Data Studio');
	});

	it('shows the code of an existing record as read-only text', async () => {
		const html = await render({ item: operation({}, { existing: { id: 'o1', version: 3 } }), fieldDefs: OPERATION_DEFS, inherited: { pass_code: 'MC-12' } });
		const r = row(html, 'pass_code');
		expect(r).toContain('value="MC-12"');
		expect(r).toContain('disabled');
		expect(text(r)).not.toContain('Open in Data Studio');
	});

	it('shows inherited values greyed with a tag; an own value replaces them (E15)', async () => {
		const inherited = await render({ item: sample(), fieldDefs: SAMPLE_DEFS, inherited: { form: 'disc', nickname: 'from the cut' } });
		expect(row(inherited, 'form')).toContain('inherited');
		expect(row(inherited, 'nickname')).toContain('value="from the cut"');
		const own = await render({ item: sample({ nickname: 'mine' }), fieldDefs: SAMPLE_DEFS, inherited: { nickname: 'from the cut' } });
		expect(row(own, 'nickname')).toContain('value="mine"');
		expect(row(own, 'nickname')).not.toContain('inherited');
	});

	it('conditions read the item\'s values: machining settings show for machining only', async () => {
		const machining = await render({ item: operation({ process_category: 'machining' }), fieldDefs: OPERATION_DEFS });
		expect(machining).toContain('data-field="machining_cutting_speed_m_per_min"');
		const none = await render({ item: operation(), fieldDefs: OPERATION_DEFS });
		expect(none).not.toContain('data-field="machining_cutting_speed_m_per_min"');
	});

	it('compact draws only the key fields', async () => {
		const html = await render({
			item: operation({ process_category: 'machining' }),
			fieldDefs: OPERATION_DEFS,
			compact: true,
			keyFields: keySettingsFor('operation', 'machining'),
		});
		expect(html).toContain('data-field="machining_cutting_speed_m_per_min"');
		expect(html).toContain('data-field="machining_feed_mm_per_rev"');
		expect(html).not.toContain('data-field="notes"');
		expect(html).not.toContain('data-field="planned_date"');
		expect(html).toContain('compact');
	});

	it('compact with no key fields draws no rows', async () => {
		const html = await render({ item: operation(), fieldDefs: OPERATION_DEFS, compact: true, keyFields: [] });
		expect(html).not.toContain('data-field=');
	});

	it('readonly disables the inputs', async () => {
		const html = await render({ item: operation({ process_category: 'machining' }), fieldDefs: OPERATION_DEFS, readonly: true });
		expect(row(html, 'notes')).toContain('disabled');
		expect(row(html, 'planned_date')).toContain('disabled');
	});

	it('shows the date it was done only once the operation is done', async () => {
		expect(await render({ item: operation(), fieldDefs: OPERATION_DEFS })).not.toContain('data-field="operation_date"');
		expect(await render({ item: operation({}, { workState: 'done' }), fieldDefs: OPERATION_DEFS })).toContain('data-field="operation_date"');
	});

	it('marks every empty required field when showMissing is set', async () => {
		const quiet = await render({ item: operation(), fieldDefs: OPERATION_DEFS });
		expect(text(row(quiet, 'machine_note'))).not.toContain('Required.');
		const loud = await render({ item: operation(), fieldDefs: OPERATION_DEFS, showMissing: true });
		expect(text(row(loud, 'machine_note'))).toContain('Required.');
	});

	it('gives each card its own input ids, so two forms on one canvas do not clash', async () => {
		const a = await render({ item: sample({}, { key: 'n1' }), fieldDefs: SAMPLE_DEFS });
		const b = await render({ item: sample({}, { key: 'n7' }), fieldDefs: SAMPLE_DEFS });
		expect(a).toContain('id="d1-form-physical_samples-n1-nickname"');
		expect(b).toContain('id="d1-form-physical_samples-n7-nickname"');
	});
});
