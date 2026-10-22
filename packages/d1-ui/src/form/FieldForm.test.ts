import { afterEach, describe, expect, it } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { ExplorerHost } from '../host';
import { setExplorerHostFactory } from '../host';
import FieldForm from './FieldForm.vue';
import { OPERATION_DEFS, SAMPLE_DEFS, TEST_DEFS } from './fieldDefs.fixtures';
import { toFormFields } from './fieldModel';

const VIcon = defineComponent({ props: { name: String }, setup: (p) => () => h('i', { class: 'v-icon' }, p.name) });

const calls: string[] = [];
setExplorerHostFactory(() => ({ api: { get: async (path: string) => { calls.push(path); return { data: { data: [] } }; } } }) as unknown as ExplorerHost);
afterEach(() => { calls.length = 0; });

async function render(props: Record<string, unknown>): Promise<string> {
	const app = createSSRApp(FieldForm, props);
	app.component('v-icon', VIcon);
	return renderToString(app);
}
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
/** The row of one field: its markup up to the next row. */
const row = (html: string, field: string): string => {
	const start = html.indexOf(`data-field="${field}"`);
	if (start < 0) return '';
	const next = html.indexOf('data-field="', start + 10);
	return html.slice(start, next < 0 ? undefined : next);
};

describe('FieldForm', () => {
	it('draws the field groups as headed sections, in form order, with their fields', async () => {
		const html = await render({ collection: 'physical_samples', fields: SAMPLE_DEFS, modelValue: { item_type: 'sample', form: 'disc', short_id: 'ab12cd' } });
		const headings = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1]);
		expect(headings).toEqual(['What', 'Material &amp; origin', 'Geometry', 'Surface &amp; mounting', 'Who &amp; where', 'Notes', 'Related records', 'Legacy / system']);
		expect(text(html)).toContain('Nickname');
		expect(html).toContain('data-field="nickname"');
	});

	it('leaves out what the model leaves out (the key, stamps, the report button)', async () => {
		const html = await render({ collection: 'physical_samples', fields: SAMPLE_DEFS, modelValue: {} });
		expect(html).not.toContain('data-field="sample_id"');
		expect(html).not.toContain('data-field="created_at"');
		expect(html).not.toContain('data-field="report_button"');
		expect(html).not.toContain('data-field="item_type"'); // hidden in the form
	});

	it('shows the label, a required mark, the note and the unit', async () => {
		const html = await render({ collection: 'physical_samples', fields: SAMPLE_DEFS, modelValue: { item_type: 'sample', form: 'disc' } });
		const material = row(html, 'material_id');
		expect(text(material)).toContain('Material');
		expect(material).toContain('class="req"');
		const d = row(html, 'diameter_mm');
		expect(text(d)).toContain('Diameter Ø');
		expect(text(d)).toContain('Outer diameter, across the x and y axes.');
		expect(d).toContain('class="unit"');
		expect(text(d)).toContain('mm');
		expect(d).toContain('type="number"');
		expect(row(html, 'nickname')).not.toContain('class="req"');
	});

	it('draws each kind with its own input', async () => {
		const html = await render({ collection: 'physical_samples', fields: SAMPLE_DEFS, modelValue: { item_type: 'sample', form: 'disc', mounted: true, notes: 'two\nlines', manufactured_date: '2026-10-14T00:00:00', short_id: 'ab12cd' } });
		expect(row(html, 'nickname')).toContain('type="text"');
		expect(row(html, 'notes')).toContain('<textarea');
		expect(row(html, 'mounted')).toContain('role="switch"');
		expect(row(html, 'mounted')).toContain('checked');
		expect(text(row(html, 'mounted'))).toContain('Yes');
		expect(row(html, 'manufactured_date')).toContain('type="date"');
		expect(row(html, 'manufactured_date')).toContain('value="2026-10-14"');
		expect(row(html, 'material_id')).toContain('role="combobox"');
		expect(row(html, 'owner_person_id')).toContain('role="combobox"');
		const form = row(html, 'form');
		expect(form).toContain('<select');
		expect(form).toMatch(/<option value="tensile_coupon"[^>]*>Tensile coupon \(ISO 6892\)<\/option>/);
		expect(form).toContain('Other…');
	});

	it('a field it cannot draw shows its value and Open in Data Studio', async () => {
		const html = await render({ collection: 'physical_samples', fields: SAMPLE_DEFS, modelValue: { sample_code: 'PS-007' } });
		const code = row(html, 'sample_code');
		expect(text(code)).toContain('PS-007');
		expect(text(code)).toContain('Open in Data Studio');
		expect(text(row(html, 'co_owners'))).toContain('Not set');
	});

	it('a field it cannot draw says when it opens, instead of offering Open in Data Studio, when the form is given an externalHint (a new item of a draft)', async () => {
		const html = await render({ collection: 'physical_samples', fields: SAMPLE_DEFS, modelValue: { sample_code: 'PS-007' }, externalHint: 'Opens in Data Studio after Create' });
		const code = row(html, 'sample_code');
		expect(text(code)).toContain('PS-007');
		expect(text(code)).toContain('Opens in Data Studio after Create');
		expect(code).not.toContain('<button');
		expect(text(code)).not.toContain('Open in Data Studio');
	});

	it('applies conditions live: a machining operation shows Tooling and Cutting, not Sintering', async () => {
		const machining = await render({ collection: 'manufacturing_operations', fields: OPERATION_DEFS, modelValue: { process_category: 'machining', nc_program_text: '' } });
		const headings = [...machining.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1]);
		expect(headings).toEqual(['What', 'Tooling', 'Cutting parameters', 'Notes &amp; files']);
		expect(machining).toContain('data-field="machining_spindle_speed_rpm"');
		expect(text(row(machining, 'machining_spindle_speed_rpm'))).toContain('rpm');
		expect(machining).not.toContain('data-field="sintering_max_temp_celsius"');
		expect(machining).not.toContain('data-field="nc_program_text"'); // a legacy field holding '' stays out

		const sintering = await render({ collection: 'manufacturing_operations', fields: OPERATION_DEFS, modelValue: { process_category: 'sintering', nc_program_text: '' } });
		expect([...sintering.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1])).toEqual(['What', 'Sintering', 'Notes &amp; files']);
		// the nested group is a quiet sub-heading, not a second section
		expect([...sintering.matchAll(/<h3[^>]*>(.*?)<\/h3>/g)].map((m) => m[1])).toEqual(['Machine data']);
		expect(sintering).toContain('data-field="sintering_max_temp_celsius"');
	});

	it('a blank form shows only the unconditional groups', async () => {
		const html = await render({ collection: 'manufacturing_operations', fields: OPERATION_DEFS, modelValue: { nc_program_text: '' } });
		expect([...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1])).toEqual(['What', 'Notes &amp; files']);
	});

	it('a condition can make a field required: the input sample, for machining only', async () => {
		const machining = await render({ collection: 'manufacturing_operations', fields: OPERATION_DEFS, modelValue: { process_category: 'machining' } });
		expect(row(machining, 'sample_id')).toContain('class="req"');
		const sintering = await render({ collection: 'manufacturing_operations', fields: OPERATION_DEFS, modelValue: { process_category: 'sintering' } });
		expect(row(sintering, 'sample_id')).not.toContain('class="req"');
	});

	it('a test shows the parameters and results of its type only', async () => {
		const tensile = await render({ collection: 'test_sessions', fields: TEST_DEFS, modelValue: { test_type: 'tensile' } });
		expect([...tensile.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1])).toEqual(['What', 'Tensile parameters', 'Tensile results']);
		const hardness = await render({ collection: 'test_sessions', fields: TEST_DEFS, modelValue: { test_type: 'hardness' } });
		expect([...hardness.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1])).toEqual(['What']);
	});

	it('flagged puts class flag, a missing mark and a "Missing." note on those rows only', async () => {
		const html = await render({ collection: 'physical_samples', fields: SAMPLE_DEFS, modelValue: {}, flagged: ['nickname'] });
		const flagRow = (field: string) => new RegExp('class="[^"]*\\bflag\\b[^"]*" data-field="' + field + '"');
		expect(html).toMatch(flagRow('nickname'));
		expect(row(html, 'nickname')).toContain('aria-label="missing"');
		expect(text(row(html, 'nickname'))).toContain('Missing.');
		expect(html).not.toMatch(flagRow('form'));
		expect(row(html, 'form')).not.toContain('aria-label="missing"');
		expect(html.match(/class="[^"]*\bflag\b[^"]*" data-field=/g)).toHaveLength(1);
		expect(await render({ collection: 'physical_samples', fields: SAMPLE_DEFS, modelValue: {} })).not.toMatch(/class="[^"]*\bflag\b[^"]*" data-field=/);
	});

	it('inherited values show greyed with a tag, and an own value replaces them', async () => {
		const inherited = await render({ collection: 'physical_samples', fields: SAMPLE_DEFS, modelValue: {}, inherited: { nickname: 'from the campaign' } });
		const r = row(inherited, 'nickname');
		expect(r).toContain('inherited');
		expect(r).toContain('value="from the campaign"');
		const own = await render({ collection: 'physical_samples', fields: SAMPLE_DEFS, modelValue: { nickname: 'mine' }, inherited: { nickname: 'from the campaign' } });
		expect(row(own, 'nickname')).not.toContain('inherited');
		expect(row(own, 'nickname')).toContain('value="mine"');
	});

	it('conditions read inherited values too (an inherited category shows its groups)', async () => {
		const html = await render({ collection: 'manufacturing_operations', fields: OPERATION_DEFS, modelValue: {}, inherited: { process_category: 'machining' } });
		expect(html).toContain('Cutting parameters');
	});

	it('read-only disables every input', async () => {
		const html = await render({ collection: 'physical_samples', fields: SAMPLE_DEFS, modelValue: { item_type: 'sample', form: 'disc' }, readonly: true });
		for (const f of ['nickname', 'notes', 'diameter_mm', 'form', 'mounted', 'material_id']) expect(row(html, f)).toContain('disabled');
	});

	it('a field a condition makes read-only is disabled', async () => {
		const fields = toFormFields([{ field: 'a', type: 'string', meta: { conditions: [{ rule: { b: { _eq: 1 } }, readonly: true }] } }, { field: 'b', type: 'integer' }]);
		expect(row(await render({ collection: 'c', fields, modelValue: { b: 1 } }), 'a')).toContain('disabled');
		expect(row(await render({ collection: 'c', fields, modelValue: { b: 2 } }), 'a')).not.toContain('disabled');
	});

	it('marks a required field that is empty once the person has been into it, or on showMissing', async () => {
		const quiet = await render({ collection: 'physical_samples', fields: SAMPLE_DEFS, modelValue: { item_type: 'sample' } });
		expect(quiet).not.toContain('Required.');
		expect(quiet).not.toContain('aria-invalid');
		const flagged = await render({ collection: 'physical_samples', fields: SAMPLE_DEFS, modelValue: { item_type: 'sample' }, showMissing: true });
		expect(row(flagged, 'material_id')).toContain('Required.');
		expect(row(flagged, 'form')).toContain('Required.');
		expect(row(flagged, 'form')).toContain('aria-invalid="true"');
		expect(row(flagged, 'material_id')).toContain('aria-invalid="true"');
		expect(row(flagged, 'nickname')).not.toContain('Required.');
		expect(row(flagged, 'nickname')).not.toContain('aria-invalid');
	});

	it('every field has its message element in the page from the start, empty until there is something to say', async () => {
		const html = await render({ collection: 'physical_samples', fields: SAMPLE_DEFS, modelValue: { item_type: 'sample' } });
		const nick = row(html, 'nickname');
		expect(nick).toMatch(/<p id="d1-form-physical_samples-nickname-msg" class="miss" role="status" aria-live="polite"[^>]*><\/p>/);
		expect(nick).toContain('aria-describedby="d1-form-physical_samples-nickname-msg"');
		const flagged = await render({ collection: 'physical_samples', fields: SAMPLE_DEFS, modelValue: { item_type: 'sample' }, showMissing: true });
		expect(row(flagged, 'material_id')).toMatch(/<p id="d1-form-physical_samples-material_id-msg" class="miss" role="status"[^>]*>Required\.<\/p>/);
	});

	it('the input is described by its note as well as the message', async () => {
		const html = await render({ collection: 'physical_samples', fields: SAMPLE_DEFS, modelValue: { item_type: 'sample', form: 'disc' } });
		const d = row(html, 'diameter_mm');
		expect(d).toContain('aria-describedby="d1-form-physical_samples-diameter_mm-note d1-form-physical_samples-diameter_mm-msg"');
		expect(d).toContain('id="d1-form-physical_samples-diameter_mm-note"');
	});

	it('aria-required follows the live state: a condition that makes a field required sets it, one that does not leaves it off', async () => {
		const machining = await render({ collection: 'manufacturing_operations', fields: OPERATION_DEFS, modelValue: { process_category: 'machining', nc_program_text: '' } });
		expect(row(machining, 'sample_id')).toContain('aria-required="true"');
		const sintering = await render({ collection: 'manufacturing_operations', fields: OPERATION_DEFS, modelValue: { process_category: 'sintering', nc_program_text: '' } });
		expect(row(sintering, 'sample_id')).not.toContain('aria-required');
		expect(row(machining, 'method_id')).toContain('aria-required="true"');
		expect(row(machining, 'operation_date')).toContain('aria-required="true"');
	});

	it('a condition that makes a select required changes its blank option', async () => {
		const fields = toFormFields([
			{ field: 'kind', type: 'string' },
			{ field: 'pick', type: 'string', meta: { interface: 'select-dropdown', options: { choices: [{ text: 'A', value: 'a' }] }, conditions: [{ rule: { kind: { _eq: 'x' } }, required: true }] } },
		]);
		expect(await render({ collection: 'c', fields, modelValue: { kind: 'x' } })).toContain('Choose…');
		expect(await render({ collection: 'c', fields, modelValue: { kind: 'y' } })).toContain('Not set');
	});

	it('flags a number the column cannot hold: decimals in a whole-number field, outside min / max', async () => {
		const fields = toFormFields([
			{ field: 'n', type: 'integer', meta: { options: { min: 1, max: 10 } } },
			{ field: 'm', type: 'decimal', meta: { options: { max: 5 } } },
		]);
		const html = await render({ collection: 'c', fields, modelValue: { n: 2.5, m: 6 } });
		expect(row(html, 'n')).toContain('Whole numbers only.');
		expect(row(html, 'n')).toContain('aria-invalid="true"');
		expect(row(html, 'm')).toContain('At most 5.');
		const low = await render({ collection: 'c', fields, modelValue: { n: 0, m: 1 } });
		expect(row(low, 'n')).toContain('At least 1.');
		expect(row(low, 'm')).not.toContain('aria-invalid');
		expect(row(await render({ collection: 'c', fields, modelValue: { n: 3, m: 5 } }), 'n')).not.toContain('aria-invalid');
	});

	it('accepts fields already made by toFormFields', async () => {
		const html = await render({ collection: 'test_sessions', fields: toFormFields(TEST_DEFS), modelValue: { test_type: 'tensile' } });
		expect(html).toContain('data-field="tensile_gauge_length_mm"');
	});

	it('reads nothing on the server render (labels of chosen records come after mount)', async () => {
		await render({ collection: 'physical_samples', fields: SAMPLE_DEFS, modelValue: { material_id: 'm1', owner_person_id: 'p1' } });
		expect(calls).toEqual([]);
	});

	it('shows a chosen record by its key until the label is read', async () => {
		const html = await render({ collection: 'physical_samples', fields: SAMPLE_DEFS, modelValue: { material_id: 'm1' } });
		expect(row(html, 'material_id')).toContain('value="m1"');
	});

	it('renders an empty field list as an empty form', async () => {
		const html = await render({ collection: 'x', fields: [], modelValue: {} });
		expect(text(html).trim()).toBe('');
	});
});
