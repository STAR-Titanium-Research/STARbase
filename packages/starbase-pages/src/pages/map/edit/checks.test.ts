import { describe, expect, it } from 'vitest';
import type { Check, DraftBody } from '@d1/ui';
import { apply, emptyBody, type DraftAction } from './draft';
import { blocking, checks, checksFor, doneRequiredFields, mergeChecks, recordKey, SERVER_ONLY_CODES, warnings, type CheckCtx, type FieldDef } from './checks';

const run = (actions: DraftAction[], from: DraftBody = emptyBody()) => actions.reduce((b, a) => apply(b, a), from);
const texts = (list: Check[], key?: string) => list.filter((c) => !key || c.key === key).map((c) => `${c.level}:${c.field ?? '-'}:${c.text}`);

const defs: CheckCtx['fields'] = {
	manufacturing_operations: [
		{ field: 'method_id', required: true, label: 'Method' },
		{ field: 'operation_date', required: true, label: 'Date' },
		{ field: 'feed_rate', required: true, label: 'Feed rate' },
		{ field: 'sample_id', required: true, label: 'Sample' },
		{ field: 'notes', required: false },
		{ field: 'secret', required: true, hidden: true },
		{ field: 'stamp', required: true, readonly: true },
	],
	test_sessions: [
		{ field: 'test_type', required: true, label: 'Test type' },
		{ field: 'session_date', required: true, label: 'Date' },
	],
	physical_samples: [{ field: 'location', required: false, label: 'Location' }],
};

const ctx: CheckCtx = {
	fields: defs,
	alloyCode: (m) => ({ ti: 'Ti64' })[m],
	methodCode: (m) => ({ mc: 'MC' })[m],
	today: new Date(2026, 9, 14, 12),
};

/** A planned cut: sample (material, form) → cut (method, machine, planned date) → new sample. All its structure is there. */
const planned = (): DraftBody =>
	run([
		{ type: 'addSample', values: { material_id: 'ti', form: 'disc', primary_method_id: 'mc' } },
		{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mc' }, from: { key: 'n1' } },
		{ type: 'setValues', key: 'n2', values: { equipment_id: 'e', planned_date: '2026-11-01' } },
		{ type: 'addSample', from: { key: 'n2', row: 0 } },
	]);

describe('structure (planned records)', () => {
	it('a planned cut that has its method and its wires has nothing to say', () => {
		expect(checks(planned(), ctx)).toEqual([]);
	});

	it('a planned record does not need the required fields of a done one', () => {
		const list = checks(planned(), ctx);
		expect(texts(list)).not.toContainEqual(expect.stringContaining('Feed rate'));
		expect(texts(list)).not.toContainEqual(expect.stringContaining('Date'));
	});

	it('an operation without a method blocks', () => {
		const b = run([{ type: 'addSample', values: { material_id: 'ti', primary_method_id: 'mc' } }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } }]);
		expect(blocking(checks(b, ctx)).map((c) => [c.key, c.field])).toEqual([['n2', 'method_id']]);
		expect(blocking(checks(b, ctx)).map((c) => c.text)).toEqual(['Choose what kind of operation this is.']);
	});

	it('an operation with neither a sample in nor out blocks, once per piece', () => {
		const b = run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mc' }, rows: 2 }]);
		const list = blocking(checks(b, ctx));
		expect(texts(list)).toEqual([
			'block:-:Piece 1 of this operation needs a sample going in or coming out: wire a sample to its socket.',
			'block:-:Piece 2 of this operation needs a sample going in or coming out: wire a sample to its socket.',
		]);
	});

	it('an operation with only an output is fine (a build from powder)', () => {
		const b = run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mc' } }, { type: 'addSample', values: { material_id: 'ti' }, from: { key: 'n1', row: 0 } }]);
		expect(blocking(checks(b, ctx)).filter((c) => c.key === 'n1')).toEqual([]);
	});

	it('a piece of a cut that makes no sample yet is a warning, not a block', () => {
		let b = planned();
		b = apply(b, { type: 'addOutputRow', key: 'n2' });
		const list = checks(b, ctx);
		expect(blocking(list)).toEqual([]);
		expect(texts(list, 'n2')).toEqual(['warn:-:Piece 2 of this operation makes no new sample yet: add a sample to its output socket.']);
	});

	it('a test needs its type and a sample', () => {
		const b = run([{ type: 'addContainer', kind: 'test', source: { from: 'blank' } }]);
		expect(texts(blocking(checks(b, ctx)))).toEqual([
			'block:test_type:Choose the type of this test.',
			'block:-:This test needs the sample it is done on: wire a sample to its socket.',
		]);
	});

	it('a test on a sample through an in-place operation has its subject', () => {
		let b = run([{ type: 'addSample', values: { material_id: 'ti', primary_method_id: 'mc' } }, { type: 'addPass', sample: { key: 'n1' }, values: { method_id: 'mc' } }]);
		b = apply(b, { type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'hardness' }, from: { key: 'n2', row: 0 } });
		expect(blocking(checks(b, ctx))).toEqual([]);
	});

	it('a free new sample needs a material and a method for its code; an output sample inherits them', () => {
		const free = run([{ type: 'addSample' }]);
		expect(texts(blocking(checks(free, ctx)))).toEqual([
			"block:material_id:Choose the material: it is part of the sample's code.",
			"block:primary_method_id:Choose the method: it is part of the sample's code.",
		]);
		const b = run([
			{ type: 'addSample', values: { material_id: 'ti' } },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mc' }, from: { key: 'n1' } },
			{ type: 'addSample', from: { key: 'n2', row: 0 } },
		]);
		expect(checksFor(blocking(checks(b, ctx)), 'n4')).toEqual([]);
	});

	it('says when the code cannot be made because the material or method has no code', () => {
		const b = run([{ type: 'addSample', values: { material_id: 'unknown', primary_method_id: 'mc' } }]);
		expect(blocking(checks(b, ctx)).map((c) => c.field)).toEqual(['sample_code']);
	});

	it('warns about the missing machine and planned date, never blocks on them', () => {
		const b = run([{ type: 'addSample', values: { material_id: 'ti', primary_method_id: 'mc' } }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mc' }, from: { key: 'n1' } }]);
		const list = checks(b, ctx);
		expect(blocking(list)).toEqual([]);
		expect(texts(warnings(list))).toEqual(['warn:planned_date:No planned date yet.', 'warn:equipment_id:No machine yet.']);
	});
});

describe('done work on a planned sample', () => {
	const STILL = 'block:-:Its sample is still planned; mark the operation that makes it done first.';
	/** n1 → planned cut n2 → new planned piece n4 → polish n5 / test n7 on the piece. */
	const onPiece = (state: 'planned' | 'done', kind: 'operation' | 'test'): DraftBody => {
		const b = run([
			{ type: 'addSample', values: { material_id: 'ti', primary_method_id: 'mc' } },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mc' }, from: { key: 'n1' } },
			{ type: 'addSample', from: { key: 'n2', row: 0 } },
			kind === 'operation'
				? { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mc' }, workState: state, from: { key: 'n4' } }
				: { type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'tensile' }, workState: state, from: { key: 'n4' } },
		]);
		return b;
	};
	const stillPlanned = (b: DraftBody, c: CheckCtx = ctx) => texts(blocking(checks(b, c))).filter((t) => t === STILL);

	it('a done operation or test on a sample a planned operation makes is blocked', () => {
		expect(stillPlanned(onPiece('done', 'operation'))).toEqual([STILL]);
		expect(stillPlanned(onPiece('done', 'test'))).toEqual([STILL]);
	});

	it('planned work on it is fine, and so is done work once the maker is done', () => {
		expect(stillPlanned(onPiece('planned', 'operation'))).toEqual([]);
		expect(stillPlanned(onPiece('planned', 'test'))).toEqual([]);
		const made = apply(onPiece('done', 'operation'), { type: 'setWorkState', key: 'n2', workState: 'done' });
		expect(stillPlanned(made)).toEqual([]);
	});

	it('an existing planned sample (from its record) blocks done work on it too', () => {
		const b = run([{ type: 'addExistingSamples', samples: [{ id: 's', version: 1 }] }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mc' }, workState: 'done', from: { key: 'n1' } }]);
		expect(stillPlanned(b)).toEqual([]); // the record is not read yet
		expect(stillPlanned(b, { ...ctx, records: { [recordKey('physical_samples', 's')]: { version: 1, values: { current_status: 'planned' } } } })).toEqual([STILL]);
		expect(stillPlanned(b, { ...ctx, records: { [recordKey('physical_samples', 's')]: { version: 1, values: { current_status: 'active' } } } })).toEqual([]);
	});
});

describe('doneRequiredFields: the one list the rail shows and the checks ask for', () => {
	const op = () => run([{ type: 'addExistingSamples', samples: [{ id: 's', version: 1 }] }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mc' }, workState: 'done', from: { key: 'n1' } }]);
	it('is the fields marked required, less the wires, hidden and read-only fields, and what the draft supplies', () => {
		const body = op();
		const item = body.items[1];
		expect(doneRequiredFields(item, body, defs!.manufacturing_operations).map((d) => d.field)).toEqual(['method_id', 'operation_date', 'feed_rate']);
		expect(doneRequiredFields(item, body, undefined)).toEqual([]);
		const withProject = [...(defs!.manufacturing_operations as FieldDef[]), { field: 'project_id', required: true, label: 'Project' }, { field: 'campaign_id', required: true, label: 'Campaign' }];
		expect(doneRequiredFields(item, body, withProject).map((d) => d.field)).toEqual(['method_id', 'operation_date', 'feed_rate', 'project_id', 'campaign_id']);
		const scoped = apply(apply(body, { type: 'setProject', projectId: 'p' }), { type: 'setCampaign', campaignId: 'c' });
		expect(doneRequiredFields(scoped.items[1], scoped, withProject).map((d) => d.field)).toEqual(['method_id', 'operation_date', 'feed_rate']);
	});
	it('asks a record that exists only for what the draft changes', () => {
		const body = op();
		const item = { ...body.items[1], existing: { id: 'o', version: 1 }, values: { feed_rate: 1 } };
		expect(doneRequiredFields(item, body, defs!.manufacturing_operations).map((d) => d.field)).toEqual(['feed_rate']);
	});
});

describe('done records', () => {
	const done = () => apply(planned(), { type: 'setWorkState', key: 'n2', workState: 'done' });

	it('block on the fields the form marks required, by their labels', () => {
		const list = blocking(checks(done(), ctx));
		expect(texts(list, 'n2')).toEqual([
			'block:operation_date:Fill in Date: a done operation needs it.',
			'block:feed_rate:Fill in Feed rate: a done operation needs it.',
		]);
	});

	it('are satisfied once the fields have values', () => {
		const b = apply(done(), { type: 'setValues', key: 'n2', values: { operation_date: '2026-10-14', feed_rate: 0.2 } });
		expect(blocking(checks(b, ctx))).toEqual([]);
	});

	it('never ask for what the wires, the draft or the server fill in, nor hidden or read-only fields', () => {
		const fields = texts(blocking(checks(done(), ctx))).join(' ');
		expect(fields).not.toMatch(/Sample|secret|stamp|method/);
	});

	it('the draft project satisfies a required project', () => {
		const withProject: CheckCtx = { ...ctx, fields: { ...defs, manufacturing_operations: [...(defs!.manufacturing_operations as FieldDef[]), { field: 'project_id', required: true, label: 'Project' }] } };
		expect(texts(blocking(checks(done(), withProject)))).toContainEqual(expect.stringContaining('Project'));
		const b = apply(done(), { type: 'setProject', projectId: 'p' });
		expect(texts(blocking(checks(b, withProject)))).not.toContainEqual(expect.stringContaining('Project'));
	});

	it('a done test needs its required fields too', () => {
		const b = run([{ type: 'addSample', values: { material_id: 'ti', primary_method_id: 'mc' } }, { type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'tensile' }, workState: 'done', from: { key: 'n1' } }]);
		expect(texts(blocking(checks(b, ctx)))).toEqual(['block:session_date:Fill in Date: a done test needs it.']);
	});

	it('never asks for a reserved field or current_status: the server fills them and refuses a draft that sets one', () => {
		const live: CheckCtx = {
			...ctx,
			fields: {
				...defs,
				physical_samples: [
					{ field: 'current_status', required: true, label: 'Status' },
					{ field: 'short_id', required: true },
					{ field: 'code_sort', required: true },
					{ field: 'restricted', required: true },
					{ field: 'created_by', required: true },
					{ field: 'version', required: true },
					{ field: 'location', required: false },
				],
				manufacturing_operations: [{ field: 'work_state', required: true }, { field: 'batch_id', required: true }, { field: 'done_at', required: true }, { field: 'method_id', required: true }],
				test_sessions: [{ field: 'insert_edge_id', required: true }, { field: 'subject', required: true }, { field: 'test_type', required: true }],
			},
		};
		// A free sample (nothing makes it) can be created.
		const free = run([{ type: 'addSample', values: { material_id: 'ti', primary_method_id: 'mc' } }]);
		expect(blocking(checks(free, live))).toEqual([]);
		const done = apply(planned(), { type: 'setWorkState', key: 'n2', workState: 'done' });
		expect(blocking(checks(done, live)).filter((c) => c.key === 'n4')).toEqual([]);
		const op = run([{ type: 'addExistingSamples', samples: [{ id: 's', version: 1 }] }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mc' }, workState: 'done', from: { key: 'n1' } }]);
		expect(blocking(checks(op, live)).map((c) => c.field)).not.toEqual(expect.arrayContaining(['work_state']));
		const test = run([{ type: 'addExistingSamples', samples: [{ id: 's', version: 1 }] }, { type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'tensile' }, workState: 'done', from: { key: 'n1' } }]);
		expect(blocking(checks(test, live)).map((c) => c.field)).not.toContain('insert_edge_id');
		expect(blocking(checks(test, live)).map((c) => c.field)).not.toContain('subject');
	});

	it('a free sample, and one made by a done operation, is an active record with its own required fields', () => {
		const withForm: CheckCtx = { ...ctx, fields: { ...defs, physical_samples: [{ field: 'location', required: true, label: 'Location' }] } };
		const b = apply(planned(), { type: 'setWorkState', key: 'n2', workState: 'done' });
		expect(texts(checks(b, withForm).filter((c) => c.key === 'n4'))).toEqual(['block:location:Fill in Location: a new sample needs it.']);
		// While the operation is planned the sample is a planned one: structure only.
		expect(checks(planned(), withForm).filter((c) => c.key === 'n4')).toEqual([]);
		// A free sample is active from the start.
		const free = run([{ type: 'addSample', values: { material_id: 'ti', primary_method_id: 'mc' } }]);
		expect(texts(checks(free, withForm))).toEqual(['block:location:Fill in Location: a new sample needs it.']);
	});
});

describe('existing records (E13)', () => {
	const attached = (): DraftBody => run([{ type: 'addSample', values: { material_id: 'ti', primary_method_id: 'mc' } }, { type: 'attach', operation: { id: 'op-9', version: 3 }, workState: 'planned', from: { key: 'n1' } }]);
	const key = recordKey('manufacturing_operations', 'op-9');

	it('an attached operation wired to the sample it made blocks, by the record\'s own output; any other sample is fine', () => {
		const onto = (id: string) => run([{ type: 'addExistingSamples', samples: [{ id, version: 1 }] }, { type: 'attach', operation: { id: 'op-9', version: 3 }, workState: 'planned', from: { key: 'n1' } }]);
		const records = (output: string): CheckCtx['records'] => ({ [key]: { version: 3, values: { method_id: 'mc', equipment_id: 'e', output_sample_id: output } } });
		expect(texts(blocking(checks(onto('S-OUT'), { ...ctx, records: records('s-out') })), 'n2')).toEqual(['block:-:The sample this operation made cannot be an input of it. Take the wire off.']);
		// It is d1-build's refusal (NOT_ATTACHABLE): the card shows it red, as "refused", and it is nothing to fill in.
		const wire = blocking(checks(onto('S-OUT'), { ...ctx, records: records('s-out') })).find((c) => c.key === 'n2')!;
		expect(wire.code).toBe('NOT_ATTACHABLE');
		expect(SERVER_ONLY_CODES.has(wire.code!)).toBe(true);
		expect(blocking(checks(onto('other'), { ...ctx, records: records('s-out') }))).toEqual([]);
		expect(blocking(checks(onto('s-out'), { ...ctx, records: {} }))).toEqual([]);
	});

	it('records that were not read yet say nothing', () => {
		expect(blocking(checks(attached(), { ...ctx, records: {} }))).toEqual([]);
	});

	it('changed since added is a warning for a card that only sits there, a block when it is attached or carries edits', () => {
		const records = { [key]: { version: 4, values: { method_id: 'mc', equipment_id: 'e' } } };
		// attached: the draft gives it an input, against version 3
		const attachedList = checks(attached(), { ...ctx, records });
		expect(texts(attachedList, 'n2')).toEqual(['block:-:Changed since you added it. Your edits were made against an older version, so review it first.']);
		// edited
		const edited = run([{ type: 'addExistingSamples', samples: [{ id: 's', version: 1 }] }, { type: 'setValues', key: 'n1', values: { notes: 'x' } }]);
		const sampleRecords = { [recordKey('physical_samples', 's')]: { version: 2, values: {} } };
		expect(texts(checks(edited, { ...ctx, records: sampleRecords }))).toEqual(['block:-:Changed since you added it. Your edits were made against an older version, so review it first.']);
		// only there
		const plain = run([{ type: 'addExistingSamples', samples: [{ id: 's', version: 1 }] }]);
		const list = checks(plain, { ...ctx, records: sampleRecords });
		expect(texts(list)).toEqual(['warn:-:Changed since you added it. Review it before you create.']);
		expect(blocking(list)).toEqual([]);
	});

	it('the same version says nothing', () => {
		const list = checks(attached(), { ...ctx, records: { [key]: { version: 3, values: { method_id: 'mc', equipment_id: 'e' } } } });
		expect(list).toEqual([]);
	});

	it('gone blocks and hides the rest of that card', () => {
		const list = checks(attached(), { ...ctx, records: { [key]: null } });
		expect(texts(list, 'n2')).toEqual(['block:-:This operation is gone, or you can no longer see it. Take it off the canvas.']);
	});

	it('an attached operation that got an input meanwhile blocks', () => {
		const list = checks(attached(), { ...ctx, records: { [key]: { version: 3, values: { method_id: 'mc', sample_id: 'other' } } } });
		expect(texts(blocking(list), 'n2')).toEqual(['block:-:This operation has a sample going in now, so it can no longer be attached.']);
		const flagged = checks(attached(), { ...ctx, records: { [key]: { version: 3, hasInput: true, values: { method_id: 'mc' } } } });
		expect(blocking(flagged)).toHaveLength(1);
	});

	it('an existing sample that is gone blocks', () => {
		const b = run([{ type: 'addExistingSamples', samples: [{ id: 's', version: 1 }] }]);
		const list = checks(b, { ...ctx, records: { [recordKey('physical_samples', 's')]: null } });
		expect(texts(list)).toEqual(['block:-:This sample is gone, or you can no longer see it. Take it off the canvas.']);
	});

	it('an edit to an existing record is only checked for the fields it changes', () => {
		let b = run([{ type: 'addSample', values: { material_id: 'ti', primary_method_id: 'mc' } }, { type: 'attach', operation: { id: 'op-9', version: 3 }, workState: 'done', from: { key: 'n1' } }]);
		const records: CheckCtx['records'] = { [key]: { version: 3, values: { method_id: 'mc', equipment_id: 'e' } } };
		expect(blocking(checks(b, { ...ctx, records }))).toEqual([]);
		b = apply(b, { type: 'setValues', key: 'n2', values: { feed_rate: null } });
		expect(texts(blocking(checks(b, { ...ctx, records })))).toEqual(['block:feed_rate:Fill in Feed rate: a done operation needs it.']);
	});

	it('deleting a done record is refused', () => {
		const b = apply(attached(), { type: 'remove', key: 'n2', deleteRecord: true });
		const list = checks(b, { ...ctx, records: { [key]: { version: 3, values: { work_state: 'done' } } } });
		expect(texts(blocking(list))).toEqual(['block:-:A done operation is never deleted from the map.']);
		expect(blocking(checks(b, { ...ctx, records: { [key]: { version: 3, values: { work_state: 'planned' } } } }))).toEqual([]);
	});

	it('deleting a sample that is not planned is refused, a planned one is not', () => {
		const b = run([{ type: 'addExistingSamples', samples: [{ id: 's', version: 1 }] }]);
		const gone = apply(b, { type: 'remove', key: 'n1', deleteRecord: true });
		const at = (status: string) => ({ ...ctx, records: { [recordKey('physical_samples', 's')]: { version: 1, values: { current_status: status } } } });
		expect(texts(blocking(checks(gone, at('active'))))).toEqual(['block:-:Only a planned sample can be deleted from the map.']);
		expect(blocking(checks(gone, at('planned')))).toEqual([]);
		expect(blocking(checks(gone, ctx))).toEqual([]); // not read yet
	});

	it('a wire that touches a card being removed blocks the card on its other end', () => {
		// A body from elsewhere can hold the wire (the reducer takes them off): the check says so, as d1-build does.
		const base = run([{ type: 'addSample', values: { material_id: 'ti', primary_method_id: 'mc' } }, { type: 'attach', operation: { id: 'op-9', version: 3 }, workState: 'planned', from: { key: 'n1' } }]);
		const b: DraftBody = { ...base, items: base.items.map((i) => (i.key === 'n2' ? { ...i, remove: true as const } : i)) };
		expect(texts(blocking(checks(b, ctx)))).toEqual(['block:-:This card is wired to something that is being removed. Take the wire off first.']);
		expect(blocking(checks(b, ctx))[0].key).toBe('n1');
	});
});

describe('helpers', () => {
	it('blocking checks come first', () => {
		const b = run([{ type: 'addSample', values: { material_id: 'ti', primary_method_id: 'mc' } }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } }]);
		const levels = checks(b, ctx).map((c) => c.level);
		expect(levels).toEqual([...levels].sort((a, c) => (a === c ? 0 : a === 'block' ? -1 : 1)));
		expect(levels[0]).toBe('block');
	});

	it('mergeChecks drops the same message twice', () => {
		const a: Check = { key: 'n1', level: 'warn', text: 'No machine yet.', field: 'equipment_id' };
		const b: Check = { key: 'n1', level: 'block', text: 'Choose the method of this operation.', field: 'method_id' };
		expect(mergeChecks([a], [b, a])).toEqual([b, a]);
	});
});

describe('gear a new card names (R7)', () => {
	const gear: CheckCtx['gear'] = (field, id) => (field === 'tool_id' && id === 'old' ? 'The tool Holder 3 is retired.' : field === 'insert_edge_id' && id === 'spent' ? 'The cutting edge H13A is used up.' : undefined);
	const withGear: CheckCtx = { ...ctx, gear };

	it('warns, never blocks, when a new operation names a retired tool or a used-up edge', () => {
		const b = run([{ type: 'setValues', key: 'n2', values: { tool_id: 'old', insert_edge_id: 'spent' } }], planned());
		expect(texts(checks(b, withGear), 'n2')).toEqual(['warn:tool_id:The tool Holder 3 is retired.', 'warn:insert_edge_id:The cutting edge H13A is used up.']);
		expect(blocking(checks(b, withGear))).toEqual([]);
	});

	it('says nothing for gear that is fine or not known, or without the question being asked', () => {
		const fine = run([{ type: 'setValues', key: 'n2', values: { tool_id: 'good' } }], planned());
		expect(checks(fine, withGear)).toEqual([]);
		const old = run([{ type: 'setValues', key: 'n2', values: { tool_id: 'old' } }], planned());
		expect(checks(old, ctx)).toEqual([]);
	});

	describe('an attached operation', () => {
		const gearOf: CheckCtx['gear'] = (field, id) => (field === 'equipment_id' && id === 'e-old' ? 'The machine Lathe is retired.' : field === 'tool_id' && id === 'old' ? 'The tool Holder 3 is retired.' : undefined);
		const key = recordKey('manufacturing_operations', 'op-9');
		const attached = (values?: Record<string, unknown>): DraftBody =>
			run([
				{ type: 'addSample', values: { material_id: 'ti', primary_method_id: 'mc' } },
				{ type: 'attach', operation: { id: 'op-9', version: 3 }, workState: 'planned', from: { key: 'n1' } },
				...(values ? [{ type: 'setValues', key: 'n2', values } as DraftAction] : []),
			]);
		const at = { ...ctx, gear: gearOf, records: { [key]: { version: 3, values: { method_id: 'mc', equipment_id: 'e-old', tool_id: 'old' } } } };

		it('says nothing of the retired machine and tool its record already names, while the person has not touched them', () => {
			expect(checks(attached(), at)).toEqual([]);
		});

		it('warns when the person picks a retired tool for it in the rail', () => {
			expect(texts(checks(attached({ tool_id: 'old' }), at), 'n2')).toEqual(['warn:tool_id:The tool Holder 3 is retired.']);
			expect(blocking(checks(attached({ tool_id: 'old' }), at))).toEqual([]);
		});

		it('does not warn for a pick that is fine, nor for the record\'s own old machine beside it', () => {
			expect(checks(attached({ tool_id: 'good' }), at)).toEqual([]);
		});
	});

	it('a new card is warned as before, from its values', () => {
		const old = run([{ type: 'setValues', key: 'n2', values: { tool_id: 'old' } }], planned());
		expect(texts(checks(old, withGear), 'n2')).toEqual(['warn:tool_id:The tool Holder 3 is retired.']);
	});

	it('warns for a new test too', () => {
		const b = run([{ type: 'addExistingSamples', samples: [{ id: 's1', version: 1 }] }, { type: 'addContainer', kind: 'test', source: { from: 'template', values: { test_type: 'tensile', equipment_id: 'm', tool_id: 'old' } }, from: { key: 'n1' } }, { type: 'setValues', key: 'n2', values: { planned_date: '2026-11-01' } }]);
		expect(texts(checks(b, withGear), 'n2')).toEqual(['warn:tool_id:The tool Holder 3 is retired.']);
	});
});
