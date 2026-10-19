import { describe, expect, it } from 'vitest';
import type { DraftBody } from '@d1/ui';
import { ALREADY_ATTACHED, ON_CANVAS, ORPHAN_PAGE, orphanParams, orphanReason, orphanRowOf, type OrphanRow } from './attachModel';
import { SAMPLE_STILL_PLANNED } from './checks';
import { apply, emptyBody, type DraftAction } from './draft';

const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);

describe('the query', () => {
	it('asks for operations with no input sample, newest first, one more than a page', () => {
		const p = orphanParams('');
		expect(JSON.parse(p.filter as string)).toEqual({ _and: [{ sample_id: { _null: true } }] });
		expect(p).toMatchObject({ sort: ['-created_at', '-operation_id'], limit: ORPHAN_PAGE + 1, offset: 0 });
		expect(p.fields).toEqual(expect.arrayContaining(['operation_id', 'version', 'work_state', 'method_id.method_name', 'output_sample_id.sample_code', 'owner_person_id.full_name']));
	});

	it('matches every word in the pass code, the method name or the output sample code, in any case', () => {
		const filter = JSON.parse(orphanParams('  turn  ab-12 ', 40).filter as string);
		expect(filter._and).toHaveLength(3);
		expect(filter._and[1]).toEqual({
			_or: [{ pass_code: { _icontains: 'turn' } }, { method_id: { method_name: { _icontains: 'turn' } } }, { output_sample_id: { sample_code: { _icontains: 'turn' } } }],
		});
		expect(filter._and[2]._or[0]).toEqual({ pass_code: { _icontains: 'ab-12' } });
		expect(orphanParams('x', 40).offset).toBe(40);
	});
});

describe('a row of the answer', () => {
	const raw = {
		operation_id: 'op-1', pass_code: 'LOCAL-ORPHAN-1', operation_sequence: 2, operation_date: '2026-10-01T00:00:00', planned_date: null, work_state: 'done', version: 3,
		method_id: { method_id: 'm1', method_name: 'CNC Turning' }, owner_person_id: { full_name: 'Ada Member' }, output_sample_id: { sample_id: 's9', sample_code: 'AA-0009' },
	};

	it('has the code, method, day, state, owner, the sample it made and the version to attach against', () => {
		expect(orphanRowOf(raw)).toEqual({ id: 'op-1', version: 3, code: 'LOCAL-ORPHAN-1', method: 'CNC Turning', date: '2026-10-01', workState: 'done', owner: 'Ada Member', output: { id: 's9', code: 'AA-0009' }, origins: [] });
	});

	it('a planned operation shows the day it is meant to happen', () => {
		expect(orphanRowOf({ ...raw, work_state: 'planned', operation_date: null, planned_date: '2026-11-02' })).toMatchObject({ workState: 'planned', date: '2026-11-02' });
	});

	it('copes with what the caller may not read: no owner, no output sample, no method, no pass code', () => {
		const r = orphanRowOf({ operation_id: 'op-2', version: 1, owner_person_id: null, output_sample_id: 'bare-id', method_id: null, pass_code: null, operation_sequence: null });
		expect(r).toEqual({ id: 'op-2', version: 1, code: 'Uncoded operation', method: 'No method', date: null, workState: 'done', owner: null, output: null, origins: [] });
	});

	it('names an uncoded operation by the sample it made', () => {
		expect(orphanRowOf({ ...raw, pass_code: null, operation_sequence: null })?.code).toBe('Operation on AA-0009');
	});

	it('drops a row with no id or no version: it could not be attached', () => {
		expect(orphanRowOf({ ...raw, operation_id: null })).toBeNull();
		expect(orphanRowOf({ ...raw, version: undefined })).toBeNull();
	});
});

describe('why a row is greyed', () => {
	const row = (over: Partial<OrphanRow> = {}): OrphanRow => ({ id: 'op-1', version: 1, code: 'X', method: 'M', date: null, workState: 'planned', owner: null, output: { id: 's9', code: 'AA-0009' }, origins: [], ...over });
	const site = (over: Partial<Parameters<typeof orphanReason>[1]> = {}) => ({ body: emptyBody(), onCanvas: new Set<string>(), ...over });

	it('can be attached when nothing is against it', () => {
		expect(orphanReason(row(), site())).toBeNull();
	});

	it('is greyed when the operation is on the canvas, and when this draft has attached it already', () => {
		expect(orphanReason(row(), site({ onCanvas: new Set(['op-1']) }))).toBe(ON_CANVAS);
		const attached = run([{ type: 'attach', operation: { id: 'op-1', version: 1 }, workState: 'planned' }]);
		expect(orphanReason(row(), site({ body: attached }))).toBe(ALREADY_ATTACHED);
		// picked up as it is (not attached) it is on the canvas, not "attached"
		const picked = run([{ type: 'addExisting', kind: 'operation', record: { id: 'op-1', version: 1 }, workState: 'planned' }]);
		expect(orphanReason(row(), site({ body: picked }))).toBe(ON_CANVAS);
	});

	it('is greyed with the server\'s own words for done work on a sample that is still planned; planned work is fine there', () => {
		expect(orphanReason(row({ workState: 'done' }), site({ samplePlanned: true }))).toBe(SAMPLE_STILL_PLANNED);
		expect(orphanReason(row({ workState: 'planned' }), site({ samplePlanned: true }))).toBeNull();
		expect(orphanReason(row({ workState: 'done' }), site({ samplePlanned: false }))).toBeNull();
	});

	it('is greyed when it makes a sample the target comes from (the lineage would run in a circle)', () => {
		expect(orphanReason(row(), site({ ancestors: new Set(['s9', 's1']) }))).toMatch(/makes AA-0009, which this sample comes from/);
		expect(orphanReason(row(), site({ ancestors: new Set(['s1']) }))).toBeNull();
	});

	it('is greyed when the sample it made already comes from another sample (a second origin); the sample it is attached to is no other', () => {
		expect(orphanReason(row({ origins: ['p1'] }), site({ target: 's1' }))).toMatch(/AA-0009, which already comes from another sample: attaching would give it a second origin/);
		expect(orphanReason(row({ origins: ['p1'] }), site())).toMatch(/second origin/);
		expect(orphanReason(row({ origins: ['s1'] }), site({ target: 's1' }))).toBeNull();
	});

	it('is greyed when it made the very sample it would be attached to', () => {
		expect(orphanReason(row(), site({ target: 's9' }))).toMatch(/AA-0009: a sample cannot be an input of the operation that made it/);
		expect(orphanReason(row(), site({ target: 's1' }))).toBeNull();
	});

	it('says on the canvas before anything else', () => {
		expect(orphanReason(row({ workState: 'done' }), site({ onCanvas: new Set(['op-1']), samplePlanned: true }))).toBe(ON_CANVAS);
	});
});
