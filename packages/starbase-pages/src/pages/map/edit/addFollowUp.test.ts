import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DraftBody } from '@d1/ui';
import { apply, emptyBody, type DraftAction } from './draft';
import { autoWireSource, isRepeatAdd, REPEAT_ADD_MS } from './addFollowUp';
import type { MenuChoice } from './menuModel';

// A free new sample's output takes any operation or test the draft offers, so the draft's refusal is made to happen here by the mock.
const refusing = vi.hoisted(() => ({ on: false }));
vi.mock('./addDrop', async (importActual) => {
	const actual = await importActual<typeof import('./addDrop')>();
	return { ...actual, socketVerdict: (...args: Parameters<typeof actual.socketVerdict>) => (refusing.on ? { ok: false, reason: 'refused' } : actual.socketVerdict(...args)) };
});
afterEach(() => void (refusing.on = false));

const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);
const turning: MenuChoice = { kind: 'operation', methodId: 'mt', category: 'machining' };
const tensile: MenuChoice = { kind: 'test', testType: 'tensile' };

describe('isRepeatAdd', () => {
	it('is true for the same entry within the window, false after it, for another entry, or with no earlier add', () => {
		expect(REPEAT_ADD_MS).toBe(500);
		expect(isRepeatAdd(null, 'op:x', 0)).toBe(false);
		expect(isRepeatAdd({ id: 'op:x', at: 1000 }, 'op:x', 1400)).toBe(true);
		expect(isRepeatAdd({ id: 'op:x', at: 1000 }, 'op:x', 1600)).toBe(false);
		expect(isRepeatAdd({ id: 'op:x', at: 1000 }, 'op:y', 1100)).toBe(false);
	});
});

describe('autoWireSource', () => {
	it('is the selected new sample when its output is free', () => {
		const body = run([{ type: 'addSample' }, { type: 'addSample' }]);
		expect(autoWireSource(body, 'n1', turning)).toBe('n1');
		expect(autoWireSource(body, 'n1', tensile)).toBe('n1');
	});

	it('is the last new sample with a free output when nothing is selected', () => {
		const body = run([{ type: 'addSample' }, { type: 'addSample' }]);
		expect(autoWireSource(body, null, turning)).toBe('n2');
	});

	it('is nothing when the only sample is one of the history', () => {
		const body = run([{ type: 'addExistingSamples', samples: [{ id: 's1', version: 4 }] }]);
		expect(autoWireSource(body, 's1', turning)).toBeNull();
		expect(autoWireSource(body, null, turning)).toBeNull();
	});

	it('is nothing when the selected sample already has a wire out, even if another new sample is free', () => {
		const wired = run([{ type: 'addSample' }, { type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } }]);
		expect(autoWireSource(wired, 'n1', turning)).toBeNull();
		// With nothing selected the last new sample with a free output is taken: n2.
		expect(autoWireSource(wired, null, turning)).toBe('n2');
	});

	it('is nothing when the selected card is a recorded sample or an operation: the person is elsewhere, so the new card floats', () => {
		const fresh = run([{ type: 'addSample' }]);
		const recorded = run([{ type: 'addExistingSamples', samples: [{ id: 's1', version: 4 }] }], fresh);
		const sRecorded = recorded.items.find((i) => i.existing)!.key;
		expect(autoWireSource(recorded, sRecorded, turning), 'a recorded sample is selected, a free new one is in the draft').toBeNull();
		const withOp = run([{ type: 'addSample' }, { type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } }]);
		const op = withOp.items.find((i) => i.kind === 'operation')!.key;
		expect(autoWireSource(withOp, op, turning), 'an operation is selected, n2 is free').toBeNull();
		expect(autoWireSource(withOp, null, turning)).toBe('n2');
	});

	it('wires a palette Operation or Test (a blank card) to the sample just added, as it does a method or a test type', () => {
		const body = run([{ type: 'addSample' }]);
		expect(autoWireSource(body, 'n1', { kind: 'newOperation' })).toBe('n1');
		expect(autoWireSource(body, null, { kind: 'newTest' })).toBe('n1');
		// After the first one the sample is taken: the next blank operation has nothing to wire to.
		const taken = run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } }], body);
		expect(autoWireSource(taken, 'n1', { kind: 'newOperation' })).toBeNull();
	});

	it('is nothing for a choice that is not an operation or a test', () => {
		const body = run([{ type: 'addSample' }]);
		expect(autoWireSource(body, 'n1', { kind: 'newSample' })).toBeNull();
		expect(autoWireSource(body, 'n1', { kind: 'pickSamples' })).toBeNull();
	});

	it('is nothing when the draft would refuse the wire', () => {
		const body = run([{ type: 'addSample' }]);
		expect(autoWireSource(body, 'n1', turning)).toBe('n1');
		refusing.on = true;
		expect(autoWireSource(body, 'n1', turning)).toBeNull();
		expect(autoWireSource(body, null, tensile)).toBeNull();
	});
});
