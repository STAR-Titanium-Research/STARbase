import { describe, expect, it } from 'vitest';
import type { DraftAction } from './draft';
import { apply, emptyBody } from './draft';
import { countDraft, defaultName, makesNothing, NOTHING_TO_MAKE, summaryList, summaryText } from './summary';

const run = (actions: DraftAction[]) => actions.reduce((b, a) => apply(b, a), emptyBody());

describe('summaryText', () => {
	it('says what Create will make', () => {
		let b = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } }]);
		b = apply(b, { type: 'addOutputRow', key: 'n2' });
		for (const row of [0, 1]) b = apply(b, { type: 'addSample', from: { key: 'n2', row } });
		expect(summaryText(b)).toBe('Create 2 operations, 3 samples');
		expect(summaryList(b)).toBe('2 operations, 3 samples');
	});

	it('uses the singular and lists tests between operations and samples', () => {
		const b = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'test', source: { from: 'blank' }, from: { key: 'n1' } }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' } }]);
		expect(summaryText(b)).toBe('Create 1 operation, 1 test, 1 sample');
	});

	it('does not count a picked existing sample, but counts attached, changed and removed records', () => {
		let b = run([
			{ type: 'addExistingSamples', samples: [{ id: 's', version: 1 }, { id: 't', version: 1 }] },
			{ type: 'attach', operation: { id: 'o1', version: 2 }, workState: 'planned', from: { key: 'n1' } },
			{ type: 'setValues', key: 'n2', values: { feed_rate: 1 } },
			{ type: 'attach', operation: { id: 'o2', version: 2 }, workState: 'planned' },
			{ type: 'remove', key: 'n5', deleteRecord: true },
		]);
		expect(countDraft(b)).toEqual({ operations: 0, tests: 0, samples: 0, attached: 1, changed: 1, removed: 1 });
		expect(summaryText(b)).toBe('Attach 1 operation; change 1 record; delete 1 planned record');
		b = apply(b, { type: 'addSample' });
		expect(summaryText(b)).toBe('Create 1 sample; attach 1 operation; change 1 record; delete 1 planned record');
	});

	it('an empty draft has nothing to create, and says what to do', () => {
		expect(summaryText(emptyBody())).toBe(NOTHING_TO_MAKE);
		expect(summaryText(emptyBody())).toBe('Add an operation, test or new sample to create');
		expect(summaryList(emptyBody())).toBe('Empty');
	});

	it('makes nothing when only existing samples were picked, whatever the number of cards', () => {
		const picked = run([{ type: 'addExistingSamples', samples: [{ id: 's', version: 1 }, { id: 't', version: 1 }] }]);
		expect(picked.items).toHaveLength(2);
		expect(makesNothing(emptyBody())).toBe(true);
		expect(makesNothing(picked)).toBe(true);
		expect(summaryText(picked)).toBe(NOTHING_TO_MAKE);
	});

	it('makes something once a new record, an attach, an edit or a delete is in the draft', () => {
		const picked = run([{ type: 'addExistingSamples', samples: [{ id: 's', version: 1 }] }]);
		expect(makesNothing(apply(picked, { type: 'addSample' }))).toBe(false);
		expect(makesNothing(apply(picked, { type: 'addContainer', kind: 'operation', source: { from: 'blank' } }))).toBe(false);
		expect(makesNothing(apply(picked, { type: 'attach', operation: { id: 'o', version: 1 }, workState: 'planned' }))).toBe(false);
		expect(makesNothing(apply(picked, { type: 'setValues', key: 'n1', values: { notes: 'x' } }))).toBe(false);
		const withOp = run([{ type: 'addExisting', kind: 'operation', record: { id: 'o', version: 1 }, workState: 'planned' }]);
		expect(makesNothing(withOp)).toBe(true);
		expect(makesNothing(apply(withOp, { type: 'remove', key: 'n1', deleteRecord: true }))).toBe(false);
	});
});

describe('defaultName', () => {
	const today = new Date(2026, 9, 4, 12);

	it('is the first sample code and the date', () => {
		const b = run([{ type: 'addExistingSamples', samples: [{ id: 's', version: 1 }] }, { type: 'addSample' }]);
		expect(defaultName(b, { today, codeOf: (i) => (i.existing?.id === 's' ? '57-Ti64-MF-2026-10-1' : null) })).toBe('57-Ti64-MF-2026-10-1 · 2026-10-04');
	});

	it('falls back to the tail of a new sample template, then to a plain name', () => {
		expect(defaultName(run([{ type: 'addSample', values: { sample_code: '{seq}-Ti64-MF-2026-10-4' } }]), { today })).toBe('Ti64-MF-2026-10-4 · 2026-10-04');
		expect(defaultName(run([{ type: 'addSample' }]), { today })).toBe('New process · 2026-10-04');
		expect(defaultName(emptyBody(), { today })).toBe('New process · 2026-10-04');
	});
});
