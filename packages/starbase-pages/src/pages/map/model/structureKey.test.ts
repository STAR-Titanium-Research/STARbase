import { describe, expect, it } from 'vitest';
import { structureKey } from './structureKey';
import type { ContainerNode, RecordNode, Wire } from './types';

const rec = (over: Partial<RecordNode> = {}): RecordNode => ({ id: 's:a', type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id: 'a', code: 'A' }, ins: ['s:a:in'], outs: ['s:a:out'], ...over });
const con = (over: Partial<ContainerNode> = {}): ContainerNode => ({
	id: 'op:o1',
	type: 'container',
	kind: 'operation',
	group: { id: 'op:o1', kind: 'operation', rowIds: ['o1'], batch: null },
	title: 'Cut',
	code: 'OP-1',
	category: 'machining',
	rows: [{ recordId: 'o1', in: 'op:o1:in:0', out: 'op:o1:out:0' }],
	slots: [],
	settings: [],
	bundled: false,
	probable: false,
	...over,
} as ContainerNode);
const wire = (over: Partial<Wire> = {}): Wire => ({ id: 'w1', from: 's:a:out', to: 'op:o1:in:0', carries: null, flow: 'sample', bundled: false, origin: 'x', ...over });

describe('structureKey', () => {
	it('does not change with what a card says', () => {
		const a = structureKey([rec(), con()], [wire()]);
		const b = structureKey([rec({ meta: 'typed', status: 'planned' }), con({ title: 'Other', code: 'OP-2', settings: [{ label: 'x', value: 'y' }] })], [wire()]);
		expect(b).toBe(a);
	});

	it('changes with a card, a socket or a wire', () => {
		const base = structureKey([rec(), con()], [wire()]);
		expect(structureKey([rec()], [wire()])).not.toBe(base);
		expect(structureKey([rec({ outs: [] }), con()], [wire()])).not.toBe(base);
		expect(structureKey([rec(), con({ rows: [{ recordId: 'o1', in: 'op:o1:in:0' }] })], [wire()])).not.toBe(base);
		expect(structureKey([rec(), con()], [])).not.toBe(base);
		expect(structureKey([rec(), con()], [wire({ to: 'op:o1:in:1' })])).not.toBe(base);
	});
});
