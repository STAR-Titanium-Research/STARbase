import { describe, expect, it } from 'vitest';
import type { DraftBody, DraftOperation, DraftSample, DraftTest } from '@d1/ui';
import {
	apply, canWire, continuesAs, emptyBody, inputSampleOf, isInPlace, itemOf, newFromValues, newKeys, nextKey, orderedRows, outputSampleOf, subjectsOf, wireInto, wireProblem,
	type DraftAction,
} from './draft';

/** Applies actions one after another. */
const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);
const op = (b: DraftBody, key: string) => itemOf(b, key) as DraftOperation;
const kinds = (b: DraftBody) => b.items.map((i) => `${i.key}:${i.kind}`);

/** s: a sample n1, with a blank operation n2 (row n3) wired from it. */
const sampleAndOp = (): DraftBody =>
	run([
		{ type: 'addSample', values: { sample_code: '{seq}-Ti64-MF-2026-10-14' } },
		{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'turn' }, from: { key: 'n1' } },
	]);

describe('keys', () => {
	it('count up from the highest key in the body, rows included', () => {
		expect(nextKey(emptyBody())).toBe('n1');
		const b = run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank' }, rows: 3 }]);
		expect(b.items.map((i) => i.key)).toEqual(['n1']);
		expect(op(b, 'n1').rows.map((r) => r.key)).toEqual(['n2', 'n3', 'n4']);
		expect(nextKey(b)).toBe('n5');
	});

	it('are never handed out again: a removed key stays used (body.seq)', () => {
		const b = run([{ type: 'addSample' }, { type: 'addSample' }, { type: 'remove', key: 'n2' }, { type: 'addSample' }]);
		expect(kinds(b)).toEqual(['n1:sample', 'n3:sample']);
		expect(b.seq).toBe(3);
		expect(nextKey(b)).toBe('n4');
	});

	it('count on from a body with no seq (an older draft) and from rows', () => {
		const old: DraftBody = { ...emptyBody(), items: [{ key: 'n7', kind: 'sample', values: {} }] };
		expect(old.seq).toBeUndefined();
		expect(nextKey(old)).toBe('n8');
		expect(apply(old, { type: 'addSample' }).seq).toBe(8);
	});

	it('newKeys lists what an action added', () => {
		const before = run([{ type: 'addSample' }]);
		const after = apply(before, { type: 'addSample' });
		expect(newKeys(before, after)).toEqual(['n2']);
	});
});

describe('purity', () => {
	it('never changes the body it is given', () => {
		const before = sampleAndOp();
		const frozen = JSON.stringify(before);
		for (const a of [
			{ type: 'addSample' },
			{ type: 'duplicate', key: 'n2', n: 2 },
			{ type: 'setValues', key: 'n2', values: { machine_id: 'm' } },
			{ type: 'remove', key: 'n2' },
			{ type: 'addOutputRow', key: 'n2' },
			{ type: 'move', key: 'n1', x: 1, y: 2 },
			{ type: 'setProject', projectId: 'p' },
		] as DraftAction[]) {
			const after = apply(before, a);
			expect(after).not.toBe(before);
			expect(JSON.stringify(before)).toBe(frozen);
		}
	});

	it('returns the same body when nothing can change', () => {
		const b = sampleAndOp();
		expect(apply(b, { type: 'remove', key: 'nope' })).toBe(b);
		expect(apply(b, { type: 'setValues', key: 'n2', values: { method_id: 'turn' } })).toBe(b);
		expect(apply(b, { type: 'unwire', from: { key: 'n1' }, to: { key: 'n2', row: 5 } })).toBe(b);
		expect(apply(b, { type: 'setProject', projectId: null })).toBe(b);
	});
});

describe('addSample / addExistingSamples', () => {
	it('adds a sample with its values and position', () => {
		const b = run([{ type: 'addSample', values: { form: 'disc' }, at: { x: 10, y: 20 } }]);
		expect(b.items[0]).toEqual({ key: 'n1', kind: 'sample', values: { form: 'disc' } });
		expect(b.positions.n1).toEqual({ x: 10, y: 20 });
	});

	it('wires a new sample from an operation row (a new output)', () => {
		const b = apply(sampleAndOp(), { type: 'addSample', from: { key: 'n2', row: 0 } });
		expect(b.wires).toContainEqual({ from: { key: 'n2', row: 0 }, to: { key: 'n4' } });
		expect(outputSampleOf(b, 'n2')).toBe('n4');
	});

	it('picked samples land as a column, once each', () => {
		const pick: DraftAction = { type: 'addExistingSamples', samples: [{ id: 's1', version: 3 }, { id: 's2', version: 1 }], at: { x: 0, y: 100 } };
		const b = apply(emptyBody(), pick);
		expect(b.items.map((i) => i.existing)).toEqual([{ id: 's1', version: 3 }, { id: 's2', version: 1 }]);
		expect(b.items.every((i) => Object.keys(i.values).length === 0)).toBe(true);
		expect(b.positions.n1.y).toBeLessThan(b.positions.n2.y);
		// Picking s1 again adds nothing and returns the body.
		expect(apply(b, { type: 'addExistingSamples', samples: [{ id: 's1', version: 3 }] })).toBe(b);
	});
});

describe('addContainer', () => {
	it('blank operation takes the method; blank test the test type', () => {
		const b = run([
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'cut' } },
			{ type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'tensile' } },
		]);
		expect(b.items[0]).toMatchObject({ kind: 'operation', workState: 'planned', values: { method_id: 'cut' } });
		expect(b.items[1]).toMatchObject({ kind: 'test', workState: 'planned', values: { test_type: 'tensile' } });
	});

	it('from a template copies its values as they are', () => {
		const b = run([{ type: 'addContainer', kind: 'operation', source: { from: 'template', values: { method_id: 'm', notes: 'keep', feed_rate: 0.2 } }, workState: 'done' }]);
		expect(b.items[0].values).toEqual({ method_id: 'm', notes: 'keep', feed_rate: 0.2 });
		expect((b.items[0] as DraftOperation).workState).toBe('done');
	});

	it('new from copies an existing record without its date, sample, notes and code', () => {
		const record = {
			operation_id: 'op-1', method_id: 'm', equipment_id: 'e', tool_id: 't', feed_rate: 0.2, operation_date: '2026-01-02', sample_id: 's', output_sample_id: 'o',
			notes: 'n', pass_code: 'P1', work_state: 'done', batch_id: 'b',
		};
		expect(newFromValues(record)).toEqual({ method_id: 'm', equipment_id: 'e', tool_id: 't', feed_rate: 0.2 });
		expect(newFromValues({ ...record, owner_person_id: 'p', owner_team_id: 't1' })).toEqual({ method_id: 'm', equipment_id: 'e', tool_id: 't', feed_rate: 0.2 });
		const b = run([{ type: 'addContainer', kind: 'operation', source: { from: 'newFrom', values: record } }]);
		expect(b.items[0].values).toEqual({ method_id: 'm', equipment_id: 'e', tool_id: 't', feed_rate: 0.2 });
	});

	it('wires the sample it was added from into every row, and several rows are a cut', () => {
		const b = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, rows: 3, from: { key: 'n1' } }]);
		expect(op(b, 'n2').rows).toHaveLength(3);
		expect(b.wires).toHaveLength(3);
		expect(b.wires.map((w) => w.to.row)).toEqual([0, 1, 2]);
	});

	it('wires a sample to a test as one of its subjects', () => {
		const b = run([
			{ type: 'addSample' },
			{ type: 'addSample' },
			{ type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'hardness' }, from: { key: 'n1' } },
			{ type: 'wire', from: { key: 'n2' }, to: { key: 'n3' } },
		]);
		expect(subjectsOf(b, 'n3')).toEqual(['n1', 'n2']);
	});
});

describe('attach', () => {
	it('adds an existing operation to give an input, once', () => {
		const b = run([{ type: 'addSample' }, { type: 'attach', operation: { id: 'op-9', version: 4 }, workState: 'planned', from: { key: 'n1' } }]);
		expect(b.items[1]).toMatchObject({ kind: 'operation', existing: { id: 'op-9', version: 4 }, attach: true, workState: 'planned' });
		expect(inputSampleOf(b, { key: 'n2', row: 0 })).toBe('n1');
		expect(apply(b, { type: 'attach', operation: { id: 'op-9', version: 4 }, workState: 'planned' })).toBe(b);
	});

	it('an existing operation that is not being attached takes no wires', () => {
		const b = run([{ type: 'addSample' }]);
		const withExisting: DraftBody = {
			...b,
			items: [...b.items, { key: 'n2', kind: 'operation', workState: 'done', existing: { id: 'o', version: 1 }, values: {}, rows: [{ key: 'n3' }] }],
		};
		expect(wireProblem(withExisting, { key: 'n1' }, { key: 'n2', row: 0 })).toMatch(/attached/);
	});
});

describe('addExisting', () => {
	it('brings an existing operation or test onto the draft as it is: existing, not attached, no values', () => {
		const b = run([
			{ type: 'addExisting', kind: 'operation', record: { id: 'op-1', version: 4 }, workState: 'planned', at: { x: 1, y: 2 } },
			{ type: 'addExisting', kind: 'test', record: { id: 't-1', version: 2 }, workState: 'done' },
		]);
		expect(b.items[0]).toEqual({ key: 'n1', kind: 'operation', workState: 'planned', existing: { id: 'op-1', version: 4 }, values: {}, rows: [{ key: 'n2' }] });
		expect(b.items[0]).not.toHaveProperty('attach');
		expect(b.items[1]).toEqual({ key: 'n3', kind: 'test', workState: 'done', existing: { id: 't-1', version: 2 }, values: {} });
		expect(b.positions.n1).toEqual({ x: 1, y: 2 });
		// once only
		expect(apply(b, { type: 'addExisting', kind: 'operation', record: { id: 'op-1', version: 4 }, workState: 'planned' })).toBe(b);
	});

	it('lets E14 edits and E18 removes be said, and takes no wires', () => {
		let b = run([{ type: 'addExisting', kind: 'operation', record: { id: 'op-1', version: 4 }, workState: 'planned' }, { type: 'addSample' }]);
		b = apply(b, { type: 'setValues', key: 'n1', values: { machining_feed_mm_per_rev: 0.2 } });
		expect(b.items[0].values).toEqual({ machining_feed_mm_per_rev: 0.2 });
		expect(wireProblem(b, { key: 'n3' }, { key: 'n1', row: 0 })).toMatch(/attached/);
		const gone = apply(b, { type: 'remove', key: 'n1', deleteRecord: true });
		expect(gone.items[0].remove).toBe(true);
	});

	it('is not added again when the same operation is attached', () => {
		const b = run([{ type: 'attach', operation: { id: 'op-1', version: 1 }, workState: 'planned' }]);
		expect(apply(b, { type: 'addExisting', kind: 'operation', record: { id: 'op-1', version: 1 }, workState: 'planned' })).toBe(b);
	});
});

describe('rows', () => {
	it('addOutputRow adds a row that takes the same input sample', () => {
		const b = apply(sampleAndOp(), { type: 'addOutputRow', key: 'n2' });
		expect(op(b, 'n2').rows).toHaveLength(2);
		expect(inputSampleOf(b, { key: 'n2', row: 1 })).toBe('n1');
		expect(wireInto(b, 'n2', 0)?.from).toEqual({ key: 'n1' });
	});

	it('addOutputRow is refused on tests, samples and records that already exist', () => {
		const b = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'test', source: { from: 'blank' } }]);
		expect(apply(b, { type: 'addOutputRow', key: 'n1' })).toBe(b);
		expect(apply(b, { type: 'addOutputRow', key: 'n2' })).toBe(b);
		const attached = run([{ type: 'attach', operation: { id: 'o', version: 1 }, workState: 'done' }]);
		expect(apply(attached, { type: 'addOutputRow', key: 'n1' })).toBe(attached);
	});

	it('a cut: one operation, four rows, four new samples', () => {
		let b = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'cut' }, from: { key: 'n1' } }]);
		for (let i = 0; i < 3; i += 1) b = apply(b, { type: 'addOutputRow', key: 'n2' });
		for (let row = 0; row < 4; row += 1) b = apply(b, { type: 'addSample', from: { key: 'n2', row } });
		expect(op(b, 'n2').rows).toHaveLength(4);
		expect(b.items.filter((i) => i.kind === 'sample')).toHaveLength(5);
		expect(isInPlace(b, op(b, 'n2'))).toBe(false);
	});
});

describe('wire / unwire', () => {
	it('wires a sample to an operation row, an operation row to a new sample, and takes them off again', () => {
		let b = run([{ type: 'addSample' }, { type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' } }]);
		b = apply(b, { type: 'wire', from: { key: 'n1' }, to: { key: 'n3' } });
		b = apply(b, { type: 'wire', from: { key: 'n3', row: 0 }, to: { key: 'n2' } });
		expect(b.wires).toEqual([
			{ from: { key: 'n1' }, to: { key: 'n3', row: 0 } },
			{ from: { key: 'n3', row: 0 }, to: { key: 'n2' } },
		]);
		const off = apply(b, { type: 'unwire', from: { key: 'n1' }, to: { key: 'n3' } });
		expect(off.wires).toHaveLength(1);
	});

	it('refuses what does not fit, with a reason', () => {
		const b = sampleAndOp();
		const two = apply(b, { type: 'addSample' }); // n4
		expect(wireProblem(two, { key: 'n1' }, { key: 'n4' })).toMatch(/through an operation/);
		expect(wireProblem(two, { key: 'n4' }, { key: 'n2', row: 0 })).toMatch(/already has a sample/);
		expect(wireProblem(two, { key: 'n1' }, { key: 'n1' })).toMatch(/itself/);
		expect(wireProblem(two, { key: 'n1' }, { key: 'zz' })).toMatch(/not in the draft/);
		const test = apply(two, { type: 'addContainer', kind: 'test', source: { from: 'blank' } }); // n5
		expect(canWire(test, { key: 'n5' }, { key: 'n4' })).toBe(false);
		expect(apply(test, { type: 'wire', from: { key: 'n5' }, to: { key: 'n4' } })).toBe(test);
	});

	it('one operation row makes one sample, and a sample has one maker', () => {
		let b = run([{ type: 'addSample' }, { type: 'addSample' }, { type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' } }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' } }]);
		b = apply(b, { type: 'wire', from: { key: 'n4', row: 0 }, to: { key: 'n2' } });
		expect(wireProblem(b, { key: 'n4', row: 0 }, { key: 'n3' })).toMatch(/already goes to a sample/);
		expect(wireProblem(b, { key: 'n6', row: 0 }, { key: 'n2' })).toMatch(/already made by another operation/);
	});

	it('a pass back onto its own sample does not count as making it', () => {
		// n1 → pass n2 (row n3) → back to n1; another operation n4 (row n5) may still make n1.
		const b = run([{ type: 'addSample' }, { type: 'addPass', sample: { key: 'n1' }, values: {} }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' } }]);
		expect(wireProblem(b, { key: 'n4', row: 0 }, { key: 'n1' })).toBeNull();
		// ...but a real maker still blocks a second one.
		const made = apply(b, { type: 'wire', from: { key: 'n4', row: 0 }, to: { key: 'n1' } });
		const second = apply(made, { type: 'addContainer', kind: 'operation', source: { from: 'blank' } });
		expect(wireProblem(second, { key: 'n6', row: 0 }, { key: 'n1' })).toMatch(/already made by another operation/);
	});

	it('an existing sample cannot be made by an operation, but an operation can leave it in place', () => {
		let b = run([{ type: 'addExistingSamples', samples: [{ id: 's', version: 1 }] }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } }]);
		b = apply(b, { type: 'addExistingSamples', samples: [{ id: 't', version: 1 }] }); // n4
		expect(wireProblem(b, { key: 'n2', row: 0 }, { key: 'n4' })).toMatch(/already exists/);
		expect(wireProblem(b, { key: 'n2', row: 0 }, { key: 'n1' })).toBeNull();
	});

	it('refuses a circle but allows the wire back to the sample an operation took in', () => {
		const b = sampleAndOp();
		expect(canWire(b, { key: 'n2', row: 0 }, { key: 'n1' })).toBe(true);
		let c = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } }, { type: 'addSample', from: { key: 'n2', row: 0 } }]); // n4 made by n2
		c = apply(c, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n4' } }); // n5
		expect(wireProblem(c, { key: 'n5', row: 0 }, { key: 'n1' })).toMatch(/circle/);
	});

	it('a wire to a whole operation feeds each row that has no input', () => {
		let b = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, rows: 2 }]);
		b = apply(b, { type: 'wire', from: { key: 'n1' }, to: { key: 'n2' } });
		expect(b.wires).toHaveLength(2);
	});

	it('operation to operation wires an in-place continuation of the same sample', () => {
		let b = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' } }]);
		b = apply(b, { type: 'wire', from: { key: 'n2', row: 0 }, to: { key: 'n4' } });
		expect(inputSampleOf(b, { key: 'n4', row: 0 })).toBe('n1');
		const t = apply(b, { type: 'addContainer', kind: 'test', source: { from: 'blank' }, from: { key: 'n4', row: 0 } });
		expect(subjectsOf(t, t.items[t.items.length - 1].key)).toEqual(['n1']);
	});

	it('a row that makes a new sample and is wired on carries the new sample, not its input (as d1-build does)', () => {
		// n1 → cut n2 (row n3) → new sample n4; the cut is also wired on to an operation n5 (row n6) and a test n7.
		let b = run([
			{ type: 'addSample' },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mc' }, from: { key: 'n1' } },
			{ type: 'addSample', from: { key: 'n2', row: 0 } },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank' } },
			{ type: 'addContainer', kind: 'test', source: { from: 'blank' } },
		]);
		b = apply(b, { type: 'wire', from: { key: 'n2', row: 0 }, to: { key: 'n5' } });
		b = apply(b, { type: 'wire', from: { key: 'n2', row: 0 }, to: { key: 'n7' } });
		expect(outputSampleOf(b, 'n2')).toBe('n4');
		expect(continuesAs(b, { key: 'n2', row: 0 })).toBe('n4');
		expect(inputSampleOf(b, { key: 'n5', row: 0 })).toBe('n4');
		expect(subjectsOf(b, 'n7')).toEqual(['n4']);
		// An in-place row carries its input on.
		const inPlace = run([{ type: 'addSample' }, { type: 'addPass', sample: { key: 'n1' }, values: {} }, { type: 'addContainer', kind: 'test', source: { from: 'blank' }, from: { key: 'n2', row: 0 } }]);
		expect(continuesAs(inPlace, { key: 'n2', row: 0 })).toBe('n1');
		expect(subjectsOf(inPlace, 'n4')).toEqual(['n1']);
	});

	it('a loop in the wires does not hang the readers', () => {
		const looped: DraftBody = {
			...emptyBody(),
			items: [
				{ key: 'n1', kind: 'operation', workState: 'planned', values: {}, rows: [{ key: 'n2' }] },
				{ key: 'n3', kind: 'operation', workState: 'planned', values: {}, rows: [{ key: 'n4' }] },
			],
			wires: [
				{ from: { key: 'n1', row: 0 }, to: { key: 'n3', row: 0 } },
				{ from: { key: 'n3', row: 0 }, to: { key: 'n1', row: 0 } },
			],
		};
		expect(inputSampleOf(looped, { key: 'n1', row: 0 })).toBeNull();
		expect(continuesAs(looped, { key: 'n3', row: 0 })).toBeNull();
	});
});

describe('setValues / setWorkState', () => {
	it('merges values and drops those set to undefined', () => {
		let b = sampleAndOp();
		b = apply(b, { type: 'setValues', key: 'n2', values: { equipment_id: 'e', notes: 'x' } });
		b = apply(b, { type: 'setValues', key: 'n2', values: { notes: undefined } });
		expect(b.items[1].values).toEqual({ method_id: 'turn', equipment_id: 'e' });
	});

	it('flips an operation or a test between planned and done, never a sample', () => {
		let b = sampleAndOp();
		b = apply(b, { type: 'setWorkState', key: 'n2', workState: 'done' });
		expect(op(b, 'n2').workState).toBe('done');
		expect(apply(b, { type: 'setWorkState', key: 'n1', workState: 'done' })).toBe(b);
	});
});

describe('duplicate', () => {
	it('a sample is a new sample with the same details and no wires', () => {
		const b = run([{ type: 'addSample', values: { form: 'disc', diameter_mm: 20 }, at: { x: 0, y: 0 } }, { type: 'duplicate', key: 'n1', n: 2 }]);
		expect(b.items).toHaveLength(3);
		expect(b.items[1].values).toEqual({ form: 'disc', diameter_mm: 20 });
		expect(b.items[2].values).toEqual({ form: 'disc', diameter_mm: 20 });
		expect(b.items.every((i) => !i.existing)).toBe(true);
		expect(b.wires).toHaveLength(0);
		// The copies have no place of their own: the layout finds them a free one beside the original, so they never lie on it.
		expect(Object.keys(b.positions)).toEqual(['n1']);
	});

	it('copies of an in-place operation chain after the original as further passes', () => {
		// sample n1 → turning n2 (in place, back to n1)
		const base = run([
			{ type: 'addSample' },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'turn' }, from: { key: 'n1' } },
			{ type: 'wire', from: { key: 'n2', row: 0 }, to: { key: 'n1' } },
			{ type: 'setValues', key: 'n2', values: { depth_of_cut_mm: 0.5 } },
			{ type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'hardness' }, from: { key: 'n1' } },
		]);
		const b = apply(base, { type: 'duplicate', key: 'n2', n: 3 });
		const ops = b.items.filter((i) => i.kind === 'operation') as DraftOperation[];
		expect(ops).toHaveLength(4);
		// The copies sit right after the original, before the test, in order.
		expect(b.items.map((i) => i.kind)).toEqual(['sample', 'operation', 'operation', 'operation', 'operation', 'test']);
		for (const copy of ops.slice(1)) {
			expect(copy.values).toEqual({ method_id: 'turn', depth_of_cut_mm: 0.5 });
			expect(inputSampleOf(b, { key: copy.key, row: 0 })).toBe('n1');
			expect(b.wires).toContainEqual({ from: { key: copy.key, row: 0 }, to: { key: 'n1' } });
			expect(isInPlace(b, copy)).toBe(true);
			expect(copy.rows).toHaveLength(1);
		}
		// Keys are all different.
		const keys = [...b.items.map((i) => i.key), ...ops.flatMap((o) => o.rows.map((r) => r.key))];
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('a cut copies with the same input wires and open outputs', () => {
		let b = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'cut' }, rows: 2, from: { key: 'n1' } }]);
		b = apply(b, { type: 'addSample', from: { key: 'n2', row: 0 } });
		b = apply(b, { type: 'addSample', from: { key: 'n2', row: 1 } });
		const before = b.wires.length;
		b = apply(b, { type: 'duplicate', key: 'n2' });
		const copy = b.items.find((i) => i.key !== 'n2' && i.kind === 'operation') as DraftOperation;
		expect(copy.rows).toHaveLength(2);
		expect(b.wires.length).toBe(before + 2);
		expect(inputSampleOf(b, { key: copy.key, row: 1 })).toBe('n1');
		expect(outputSampleOf(b, copy.key, 0)).toBeNull();
		expect(outputSampleOf(b, copy.key, 1)).toBeNull();
	});

	it('a test copies with the same subjects', () => {
		let b = run([{ type: 'addSample' }, { type: 'addSample' }, { type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 't' }, from: { key: 'n1' } }, { type: 'wire', from: { key: 'n2' }, to: { key: 'n3' } }]);
		b = apply(b, { type: 'duplicate', key: 'n3', n: 2 });
		const tests = b.items.filter((i): i is DraftTest => i.kind === 'test');
		expect(tests).toHaveLength(3);
		for (const t of tests) expect(subjectsOf(b, t.key)).toEqual(['n1', 'n2']);
	});

	it('duplicating an existing record is new from: its record without date, sample, notes and code', () => {
		const record = { method_id: 'm', feed_rate: 0.3, operation_date: '2026-01-01', notes: 'old' };
		let b = run([{ type: 'attach', operation: { id: 'o', version: 2 }, workState: 'done', values: { feed_rate: 0.4 } }]);
		b = apply(b, { type: 'duplicate', key: 'n1', record });
		const copy = b.items[1] as DraftOperation;
		expect(copy.existing).toBeUndefined();
		expect(copy.attach).toBeUndefined();
		expect(copy.values).toEqual({ method_id: 'm', feed_rate: 0.4 });
	});

	it('duplicating an existing item without its full record does nothing', () => {
		const b = run([{ type: 'addExisting', kind: 'operation', record: { id: 'o', version: 1 }, workState: 'done' }, { type: 'setValues', key: 'n1', values: { feed_rate: 0.4 } }]);
		expect(apply(b, { type: 'duplicate', key: 'n1' })).toBe(b);
		expect(apply(b, { type: 'duplicate', key: 'n1', n: 3 })).toBe(b);
		const s = run([{ type: 'addExistingSamples', samples: [{ id: 's', version: 1 }] }]);
		expect(apply(s, { type: 'duplicate', key: 'n1' })).toBe(s);
		// with the record it is new from
		const c = apply(b, { type: 'duplicate', key: 'n1', record: { method_id: 'm', feed_rate: 0.3, notes: 'n' } });
		expect(c.items[1].values).toEqual({ method_id: 'm', feed_rate: 0.4 });
	});

	it('N is at least 1 and at most 99', () => {
		const b = run([{ type: 'addSample' }]);
		expect(apply(b, { type: 'duplicate', key: 'n1', n: 0 }).items).toHaveLength(2);
		expect(apply(b, { type: 'duplicate', key: 'n1', n: 500 }).items).toHaveLength(100);
	});
});

describe('addPass', () => {
	it('puts a pass on a sample that is already in the draft, wired in and back', () => {
		const b = run([{ type: 'addSample' }, { type: 'addPass', sample: { key: 'n1' }, values: { method_id: 'turn', operation_date: '2026-01-01', notes: 'x' } }]);
		expect(b.items[1]).toMatchObject({ kind: 'operation', values: { method_id: 'turn' } });
		expect(inputSampleOf(b, { key: 'n2', row: 0 })).toBe('n1');
		expect(isInPlace(b, op(b, 'n2'))).toBe(true);
	});

	it('adds an existing sample to the draft first (a pass on a stack that is on the map)', () => {
		const b = run([{ type: 'addPass', sample: { id: 's-1', version: 5 }, values: { method_id: 'turn' }, workState: 'done' }]);
		expect(b.items[0]).toMatchObject({ kind: 'sample', existing: { id: 's-1', version: 5 } });
		expect(b.items[1]).toMatchObject({ kind: 'operation', workState: 'done' });
		// A second pass reuses the sample's card.
		const c = apply(b, { type: 'addPass', sample: { id: 's-1', version: 5 }, values: { method_id: 'turn' } });
		expect(c.items.filter((i) => i.kind === 'sample')).toHaveLength(1);
		expect(c.items.filter((i) => i.kind === 'operation')).toHaveLength(2);
	});

	it('after a draft pass takes its settings and goes right after it', () => {
		let b = run([{ type: 'addPass', sample: { id: 's', version: 1 }, values: { method_id: 'turn', feed_rate: 1 } }, { type: 'addContainer', kind: 'test', source: { from: 'blank' } }]);
		b = apply(b, { type: 'addPass', sample: { key: 'n1' }, after: 'n2' });
		expect(b.items.map((i) => i.kind)).toEqual(['sample', 'operation', 'operation', 'test']);
		expect(b.items[2].values).toEqual({ method_id: 'turn', feed_rate: 1 });
	});
});

describe('remove', () => {
	it('drops a new item with its wires and position', () => {
		let b = sampleAndOp();
		b = apply(b, { type: 'move', key: 'n2', x: 5, y: 5 });
		const c = apply(b, { type: 'remove', key: 'n2' });
		expect(c.items.map((i) => i.key)).toEqual(['n1']);
		expect(c.wires).toEqual([]);
		expect(c.positions.n2).toBeUndefined();
	});

	it('marks an existing planned record to be deleted at Create when asked, and only drops it otherwise', () => {
		const b = run([{ type: 'attach', operation: { id: 'o', version: 1 }, workState: 'planned' }]);
		const marked = apply(b, { type: 'remove', key: 'n1', deleteRecord: true });
		expect(marked.items[0].remove).toBe(true);
		expect(apply(marked, { type: 'remove', key: 'n1', deleteRecord: true })).toBe(marked);
		expect(apply(b, { type: 'remove', key: 'n1' }).items).toHaveLength(0);
	});

	it('marking an existing record for deletion takes its wires off (d1-build refuses a wire to a removed card)', () => {
		const b = run([{ type: 'addSample' }, { type: 'attach', operation: { id: 'o', version: 1 }, workState: 'planned', from: { key: 'n1' } }]);
		expect(b.wires).toHaveLength(1);
		const marked = apply(b, { type: 'remove', key: 'n2', deleteRecord: true });
		expect(marked.wires).toEqual([]);
		expect(marked.items.find((i) => i.key === 'n2')?.remove).toBe(true);
	});
});

describe('move / project / campaign', () => {
	it('records positions, the project and the campaign', () => {
		let b = run([{ type: 'addSample' }]);
		b = apply(b, { type: 'move', key: 'n1', x: 3, y: 4 });
		b = apply(b, { type: 'setProject', projectId: 'p1' });
		b = apply(b, { type: 'setCampaign', campaignId: 'c1' });
		expect(b).toMatchObject({ projectId: 'p1', campaignId: 'c1', positions: { n1: { x: 3, y: 4 } } });
		expect(apply(b, { type: 'move', key: 'zz', x: 1, y: 1 })).toBe(b);
	});
});

describe('types', () => {
	it('a built body is a DraftBody version 1', () => {
		const b: DraftBody = sampleAndOp();
		expect(b.v).toBe(1);
		const s = b.items[0] as DraftSample;
		expect(s.kind).toBe('sample');
	});
});

describe('orderedRows (the order Create writes operations)', () => {
	it('keeps the order of the draft, except that a row waits for what it is wired from and for the maker of its sample', () => {
		// n1 sample; B n2(n3) laid out first, A n4(n5) from n1, B wired after A.
		let b = run([
			{ type: 'addSample' },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank' } },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } },
		]);
		expect(orderedRows(b).map((r) => r.rowKey)).toEqual(['n3', 'n5']);
		b = apply(b, { type: 'wire', from: { key: 'n4', row: 0 }, to: { key: 'n2' } });
		expect(orderedRows(b).map((r) => r.rowKey)).toEqual(['n5', 'n3']);
		// A row that works on the sample another row makes waits for it.
		const made = run([
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank' } }, // n1 (row n2): will make n6
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank' } }, // n3 (row n4)
			{ type: 'addSample' }, // n5
		]);
		let m = apply(made, { type: 'wire', from: { key: 'n3', row: 0 }, to: { key: 'n5' } });
		m = apply(m, { type: 'wire', from: { key: 'n5' }, to: { key: 'n1', row: 0 } });
		expect(orderedRows(m).map((r) => r.rowKey)).toEqual(['n4', 'n2']);
	});

	it('appends a loop in draft order instead of dropping it', () => {
		const looped: DraftBody = {
			...emptyBody(),
			items: [
				{ key: 'n1', kind: 'operation', workState: 'planned', values: {}, rows: [{ key: 'n2' }] },
				{ key: 'n3', kind: 'operation', workState: 'planned', values: {}, rows: [{ key: 'n4' }] },
			],
			wires: [
				{ from: { key: 'n1', row: 0 }, to: { key: 'n3', row: 0 } },
				{ from: { key: 'n3', row: 0 }, to: { key: 'n1', row: 0 } },
			],
		};
		expect(orderedRows(looped).map((r) => r.rowKey)).toEqual(['n2', 'n4']);
	});
});

describe('rows of a new operation: a socket nobody uses is not kept (R5)', () => {
	const cut = (rows = 3) => run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, rows, from: { key: 'n1' } }]);

	it('an added row shares the input by default, and not when asked', () => {
		const shared = apply(cut(1), { type: 'addOutputRow', key: 'n2' });
		expect(shared.wires.filter((w) => w.to.key === 'n2').map((w) => w.to.row)).toEqual([0, 1]);
		const own = apply(cut(1), { type: 'addOutputRow', key: 'n2', share: false });
		expect(own.wires.filter((w) => w.to.key === 'n2').map((w) => w.to.row)).toEqual([0]);
		expect((own.items.find((i) => i.key === 'n2') as { rows: unknown[] }).rows).toHaveLength(2);
	});

	it('removing a row takes its wires and moves the rows after it up', () => {
		let b = cut(3);
		b = apply(b, { type: 'addSample', from: { key: 'n2', row: 1 } });
		b = apply(b, { type: 'addSample', from: { key: 'n2', row: 2 } });
		const sample1 = b.items.find((i) => i.key === 'n6')!.key;
		const sample2 = b.items.find((i) => i.key === 'n7')!.key;
		const after = apply(b, { type: 'removeRow', key: 'n2', row: 1 });
		const op = after.items.find((i) => i.key === 'n2') as { rows: { key: string }[] };
		expect(op.rows.map((r) => r.key)).toEqual(['n3', 'n5']);
		expect(after.wires.some((w) => w.to.key === sample1 || w.from.key === sample1)).toBe(false);
		// Row 2 is row 1 now, with its sample and its input.
		expect(after.wires).toContainEqual({ from: { key: 'n2', row: 1 }, to: { key: sample2 } });
		expect(after.wires).toContainEqual({ from: { key: 'n1' }, to: { key: 'n2', row: 1 } });
		expect(after.wires.filter((w) => w.to.key === 'n2')).toHaveLength(2);
		expect(after.wires.every((w) => (w.from.row ?? 0) < 2 && (w.to.row ?? 0) < 2)).toBe(true);
	});

	it('never removes the last row, a row that is not there, a row of a record that exists, or of a card that is not an operation', () => {
		const one = cut(1);
		expect(apply(one, { type: 'removeRow', key: 'n2', row: 0 })).toBe(one);
		const three = cut(3);
		expect(apply(three, { type: 'removeRow', key: 'n2', row: 3 })).toBe(three);
		expect(apply(three, { type: 'removeRow', key: 'n2', row: -1 })).toBe(three);
		expect(apply(three, { type: 'removeRow', key: 'n1', row: 0 })).toBe(three);
		const rec = run([{ type: 'addExisting', kind: 'operation', record: { id: 'op-1', version: 1 }, workState: 'planned' }]);
		expect(apply(rec, { type: 'removeRow', key: 'n1', row: 0 })).toBe(rec);
	});
});
