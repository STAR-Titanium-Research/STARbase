import { describe, expect, it } from 'vitest';
import type { DraftBody, DraftItem } from '@d1/ui';
import { apply, emptyBody, type DraftAction } from './draft';
import { canChooseWork, DONE_DATE_FIELD, groupWorkState, workStateActions } from './workState';

const NOW = new Date('2026-10-19T09:30:00.000Z');
const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);
const item = (body: DraftBody, key: string): DraftItem => body.items.find((i) => i.key === key)!;
const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } }, { type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'tensile' }, from: { key: 'n1' } }]);
const [op, test] = [body.items.find((i) => i.kind === 'operation')!, body.items.find((i) => i.kind === 'test')!];

describe('canChooseWork', () => {
	it('is a new operation or test, not a sample, a record that exists or one being removed', () => {
		expect(canChooseWork(op)).toBe(true);
		expect(canChooseWork(test)).toBe(true);
		expect(canChooseWork(item(body, 'n1'))).toBe(false);
		expect(canChooseWork({ ...op, existing: { id: 'x', version: 1 } })).toBe(false);
		expect(canChooseWork({ ...op, remove: true })).toBe(false);
		expect(canChooseWork(null)).toBe(false);
	});
});

describe('workStateActions', () => {
	it('Done sets the state and the date it happened, today by default: operation_date for an operation, session_date for a test', () => {
		expect(workStateActions(op, 'done', NOW)).toEqual([
			{ type: 'setWorkState', key: op.key, workState: 'done' },
			{ type: 'setValues', key: op.key, values: { operation_date: NOW.toISOString() } },
		]);
		expect(workStateActions(test, 'done', NOW)[1]).toEqual({ type: 'setValues', key: test.key, values: { session_date: NOW.toISOString() } });
		expect(DONE_DATE_FIELD).toEqual({ operation: 'operation_date', test: 'session_date' });
	});

	it('keeps a date the person already chose, and says nothing of the date for Planned', () => {
		const dated = { ...op, values: { operation_date: '2026-10-01T08:00:00.000Z' } };
		expect(workStateActions(dated, 'done', NOW)).toEqual([{ type: 'setWorkState', key: op.key, workState: 'done' }]);
		expect(workStateActions({ ...op, workState: 'done' }, 'planned', NOW)).toEqual([{ type: 'setWorkState', key: op.key, workState: 'planned' }]);
		// a cleared date is blank too
		expect(workStateActions({ ...op, values: { operation_date: '' } }, 'done', NOW)).toHaveLength(2);
	});

	it('does nothing for the state it already has, a sample or a record that exists', () => {
		expect(workStateActions(op, 'planned', NOW)).toEqual([]);
		expect(workStateActions(item(body, 'n1'), 'done', NOW)).toEqual([]);
		expect(workStateActions({ ...op, existing: { id: 'x', version: 1 } }, 'done', NOW)).toEqual([]);
	});

	it('applied together they are one change of the body: done, with its date', () => {
		const next = run(workStateActions(op, 'done', NOW), body);
		expect(item(next, op.key)).toMatchObject({ workState: 'done', values: { method_id: 'm', operation_date: NOW.toISOString() } });
		// back to planned keeps the date, so Done again does not ask for it twice
		const back = run(workStateActions(item(next, op.key), 'planned', NOW), next);
		expect(item(back, op.key)).toMatchObject({ workState: 'planned', values: { operation_date: NOW.toISOString() } });
	});
});

describe('groupWorkState: the state a card stands for (a stack of passes is several items)', () => {
	it('is the state they all have, and planned when they differ (Done then takes them all)', () => {
		const a = { ...op, workState: 'done' as const };
		const b = { ...op, key: 'n9', workState: 'planned' as const };
		expect(groupWorkState([a])).toBe('done');
		expect(groupWorkState([a, a])).toBe('done');
		expect(groupWorkState([b, b])).toBe('planned');
		expect(groupWorkState([a, b])).toBe('planned');
		expect(groupWorkState([])).toBeNull();
		expect(groupWorkState([item(body, 'n1')])).toBeNull();
		expect(groupWorkState([a, { ...op, existing: { id: 'x', version: 1 } }])).toBeNull();
	});
});
