import { describe, expect, it } from 'vitest';
import type { DraftBody } from '@d1/ui';
import { apply, emptyBody, type DraftAction } from './draft';
import { autoWireSource, isRepeatAdd, REPEAT_ADD_MS } from './addFollowUp';
import type { MenuChoice } from './menuModel';

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

	it('leaves a selected sample that already has a wire out for the last new one that has none, or nothing', () => {
		const wired = run([{ type: 'addSample' }, { type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } }]);
		expect(autoWireSource(wired, 'n1', turning)).toBe('n2');
		const only = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } }]);
		expect(autoWireSource(only, 'n1', turning)).toBeNull();
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
});
