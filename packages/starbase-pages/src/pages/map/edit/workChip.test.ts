import { describe, expect, it } from 'vitest';
import type { DraftBody, DraftKey } from '@d1/ui';
import { apply, emptyBody, type DraftAction, type WorkState } from './draft';
import { toGraph } from './toGraph';
import { buildGraph } from '../model/buildGraph';
import { groupBatches } from '../model/groupBatches';
import type { MapNode } from '../model/types';
import { workChipOf } from './workChip';

const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);
const nodesOf = (body: DraftBody): MapNode[] => {
	const data = toGraph(null, body);
	return buildGraph(data, groupBatches(data.operations, data.tests, { probable: false, stack: true }), { slots: () => [] }).nodes;
};
const fakeEdit = (body: DraftBody, editing = true) => {
	const calls: [DraftKey[], WorkState][] = [];
	return { calls, editing: { value: editing }, body: { value: body }, setWorkState: (k: DraftKey[], s: WorkState) => void calls.push([k, s]) };
};

describe('workChipOf (R9)', () => {
	const body = run([
		{ type: 'addSample' },
		{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } },
		{ type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'tensile' }, workState: 'done', from: { key: 'n1' } },
	]);
	const [sample, op, test] = [nodesOf(body).find((n) => n.type === 'record')!, nodesOf(body).find((n) => n.type === 'container' && n.kind !== 'test')!, nodesOf(body).find((n) => n.type === 'container' && n.kind === 'test')!];

	it('a new planned operation offers to become done, a done test to become planned', () => {
		const e = fakeEdit(body);
		const a = workChipOf(e, op)!;
		expect(a.state).toBe('planned');
		expect(a.label).toMatch(/^Planned/);
		a.toggle();
		const b = workChipOf(e, test)!;
		expect(b.state).toBe('done');
		b.toggle();
		expect(e.calls).toEqual([[['n2'], 'done'], [['n4'], 'planned']]);
	});

	it('a sample, a card outside the draft and view mode have none', () => {
		expect(workChipOf(fakeEdit(body), sample)).toBeNull();
		expect(workChipOf(fakeEdit(body, false), op)).toBeNull();
		expect(workChipOf(fakeEdit(emptyBody()), op)).toBeNull();
	});

	it('an operation that exists in the draft (a record) has none: Mark done is its way', () => {
		const existing = run([{ type: 'addExisting', kind: 'operation', record: { id: 'o1', version: 1 }, workState: 'planned' }]);
		const key = existing.items[0].key;
		const e = fakeEdit(existing);
		expect(workChipOf(e, { type: 'container', group: { rowIds: ['o1'] } } as never)).toBeNull();
		expect(key).toBeTruthy();
	});
});
