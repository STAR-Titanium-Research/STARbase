import { describe, expect, it } from 'vitest';
import type { DraftBody } from '@d1/ui';
import { connectTargets, filterConnect, type ConnectNames } from './connectModel';
import { apply, emptyBody, type DraftAction } from './draft';

const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);

const names: ConnectNames = {
	sample: (i) => `S-${i.key}`,
	operation: (i, row) => `Op ${i.key}.${row}`,
	test: (i) => `Test ${i.key}`,
};

/** n1 a sample; n2 an operation (row n3) fed by n1; n4 a free operation (row n5); n6 a test; n7 another sample. */
const body = (): DraftBody =>
	run([
		{ type: 'addSample' },
		{ type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } },
		{ type: 'addContainer', kind: 'operation', source: { from: 'blank' } },
		{ type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'tensile' } },
		{ type: 'addSample' },
	]);

const labels = (es: { label: string }[]) => es.map((e) => e.label);

describe('Connect to…', () => {
	it('from a sample\'s output lists the inputs it can feed: free operations and tests, not the one already fed', () => {
		expect(labels(connectTargets(body(), { kind: 'sample', id: 'draft:n7', side: 'out' }, names))).toEqual(['Op n4.0', 'Test n6']); // n2's input already has a sample
		// n1 feeds n2 already, and could feed the others
		expect(labels(connectTargets(body(), { kind: 'sample', id: 'draft:n1', side: 'out' }, names))).toEqual(['Op n4.0', 'Test n6']);
	});

	it('from an operation\'s output lists the samples it can make, and the operations and tests it can go on to', () => {
		const out = connectTargets(body(), { kind: 'row', id: 'draft:n3', side: 'out' }, names);
		expect(labels(out)).toContain('S-n1'); // in place: back to the sample it took in
		expect(labels(out)).toContain('S-n7');
	});

	it('from a free input lists the outputs that can feed it', () => {
		const out = connectTargets(body(), { kind: 'row', id: 'draft:n5', side: 'in' }, names);
		expect(labels(out)).toContain('S-n7');
		expect(labels(out)).not.toContain('Test n6'); // a test has no output
	});

	it('leaves out the socket itself and a removed card', () => {
		const b = run([{ type: 'addExistingSamples', samples: [{ id: 'real', version: 1 }] }, { type: 'remove', key: 'n1', deleteRecord: true }]);
		expect(connectTargets(b, { kind: 'sample', id: 'real', side: 'out' }, names)).toEqual([]);
	});

	it('is empty when nothing fits', () => {
		expect(connectTargets(emptyBody(), { kind: 'sample', id: 'draft:n1', side: 'out' }, names)).toEqual([]);
	});

	it('gives each entry the socket to wire to', () => {
		const [first] = connectTargets(body(), { kind: 'sample', id: 'draft:n7', side: 'out' }, names);
		expect(first.sock).toEqual({ kind: 'row', id: 'draft:n5', side: 'in' });
		expect(first.detail).toBe('operation');
	});
});

describe('searching the list', () => {
	const es = connectTargets(body(), { kind: 'sample', id: 'draft:n7', side: 'out' }, names);
	it('keeps entries that have every word', () => {
		expect(labels(filterConnect(es, 'test'))).toEqual(['Test n6']);
		expect(labels(filterConnect(es, 'n4'))).toEqual(['Op n4.0']);
		expect(labels(filterConnect(es, 'operation n4'))).toEqual(['Op n4.0']);
		expect(filterConnect(es, 'zzz')).toEqual([]);
		expect(filterConnect(es, ' ')).toHaveLength(es.length);
	});
});
