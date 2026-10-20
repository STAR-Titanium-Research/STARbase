import { describe, expect, it } from 'vitest';
import { SHOWN_WHEN_FOLDED, railSockets, socketOwners } from './railSockets';
import type { ContainerNode, SampleRow } from './types';

const con = (rows: SampleRow[], over: Partial<ContainerNode> = {}): ContainerNode =>
	({
		id: 'op:o1',
		type: 'container',
		kind: 'operation',
		group: { id: 'op:o1', kind: 'operation', rowIds: rows.map((r) => r.recordId), batch: null },
		title: 'Cut',
		code: 'OP-1',
		category: 'machining',
		rows,
		slots: [],
		settings: [],
		bundled: false,
		probable: false,
		...over,
	}) as ContainerNode;

const ids = (list: { id: string }[]) => list.map((s) => s.id);

describe('an operation the draft attaches (slice 3)', () => {
	// Recorded: its output is the sample it made. Not wired yet: nothing is on its input.
	const loose = () => con([{ recordId: 'op1', out: 'op:op1:out:0' }], { id: 'op:op1', attaching: true });
	const wiredIn = () => con([{ recordId: 'op1', in: 'op:op1:in:0', out: 'op:op1:out:0' }], { id: 'op:op1', attaching: true });

	it('has a free input a sample can be wired to, and never a free output (it keeps the sample it made)', () => {
		const ins = railSockets(loose(), 'in', { editable: true });
		expect(ins).toEqual([{ id: 'free:in:op1', fat: false, recordId: 'op1', row: 0, free: true }]);
		expect(railSockets(loose(), 'out', { editable: true, selected: true }).filter((s) => s.free)).toEqual([]);
		expect(railSockets(wiredIn(), 'out', { editable: true, selected: true }).filter((s) => s.free)).toEqual([]);
	});

	it('owns its input socket for the draft, not its output', () => {
		const owners = socketOwners(wiredIn());
		expect([...owners.keys()]).toEqual(['op:op1:in:0']);
	});

	it('is not offered a second input once it has one', () => {
		expect(railSockets(wiredIn(), 'in', { editable: true, selected: true }).filter((s) => s.free)).toEqual([]);
	});
});

describe('railSockets', () => {
	it('lists each socket id once, in row order (a cut\'s shared input once)', () => {
		const node = con([
			{ recordId: 'a', in: 'op:o1:in:0', out: 'op:o1:out:0' },
			{ recordId: 'b', in: 'op:o1:in:0', out: 'op:o1:out:1' },
		]);
		expect(ids(railSockets(node, 'in'))).toEqual(['op:o1:in:0']);
		expect(ids(railSockets(node, 'out'))).toEqual(['op:o1:out:0', 'op:o1:out:1']);
		expect(railSockets(node, 'out').map((s) => [s.recordId, s.row])).toEqual([['a', 0], ['b', 1]]);
	});

	it('draws the rows past the fold on one fat bundle socket, last', () => {
		const rows: SampleRow[] = ['a', 'b', 'c', 'd'].map((r, i) => (i < SHOWN_WHEN_FOLDED ? { recordId: r, in: `op:o1:in:${i}`, out: `op:o1:out:${i}` } : { recordId: r, in: 'op:o1:in:b', out: 'op:o1:out:b' }));
		const node = con(rows, { bundled: true });
		const outs = railSockets(node, 'out');
		expect(ids(outs)).toEqual(['op:o1:out:0', 'op:o1:out:1', 'op:o1:out:b']);
		expect(outs[2]).toMatchObject({ fat: true, recordId: null, row: -1 });
	});

	it('gives a row with nothing wired a free socket in edit mode only', () => {
		const node = con([{ recordId: 'draft:n3', out: 'op:o1:out:0' }]);
		expect(railSockets(node, 'in')).toEqual([]);
		expect(railSockets(node, 'in', { editable: true })).toEqual([{ id: 'free:in:draft:n3', fat: false, recordId: 'draft:n3', row: 0, free: true }]);
		expect(railSockets(node, 'out', { editable: true }).map((s) => s.free)).toEqual([false]);
	});

	it('gives a test no output, wired or free', () => {
		const node = con([{ recordId: 't1' }], { kind: 'test' });
		expect(railSockets(node, 'out', { editable: true })).toEqual([]);
		expect(ids(railSockets(node, 'in', { editable: true }))).toEqual(['free:in:t1']);
	});
});

describe('socketOwners', () => {
	it('says which row and side each wired socket is, and nothing of a bundle', () => {
		const rows: SampleRow[] = ['a', 'b', 'c'].map((r, i) => (i < SHOWN_WHEN_FOLDED ? { recordId: r, in: `op:o1:in:${i}`, out: `op:o1:out:${i}` } : { recordId: r, in: 'op:o1:in:b', out: 'op:o1:out:b' }));
		const owners = socketOwners(con(rows, { bundled: true }));
		expect(owners.get('op:o1:in:1')).toEqual({ recordId: 'b', side: 'in', row: 1 });
		expect(owners.get('op:o1:out:0')).toEqual({ recordId: 'a', side: 'out', row: 0 });
		expect(owners.has('op:o1:in:b')).toBe(false);
	});

	it('gives a shared socket to the first row that has it, and a test\'s output to nobody', () => {
		const shared = con([{ recordId: 'a', in: 'op:o1:in:0' }, { recordId: 'b', in: 'op:o1:in:0' }]);
		expect(socketOwners(shared).get('op:o1:in:0')).toMatchObject({ recordId: 'a' });
		const test = con([{ recordId: 't1', in: 'op:t1:in:0', out: 'op:t1:out:0' }], { kind: 'test' });
		expect(socketOwners(test).has('op:t1:out:0')).toBe(false);
		expect(socketOwners(test).has('op:t1:in:0')).toBe(true);
	});
});

describe('derived sockets (R5): a socket per wire and one free one per side', () => {
	const editing = { editable: true };
	const wiredIn = new Set(['op:o1:in:0']);

	it('a socket nobody wired is not drawn as one: the free socket stands for it', () => {
		const node = con([{ recordId: 'draft:n3', in: 'op:o1:in:0', out: 'op:o1:out:0' }]);
		const s = railSockets(node, 'out', { ...editing, wired: wiredIn });
		expect(s).toEqual([{ id: 'free:out:draft:n3', fat: false, recordId: 'draft:n3', row: 0, free: true }]);
		expect(ids(railSockets(node, 'in', { ...editing, wired: wiredIn }))).toEqual(['op:o1:in:0']);
	});

	it('shows a wired side as its sockets only, until the card is selected: then a free one is beside them', () => {
		const node = con([{ recordId: 'draft:n3', in: 'op:o1:in:0', out: 'op:o1:out:0' }], { draft: true });
		const wired = new Set(['op:o1:in:0', 'op:o1:out:0']);
		expect(ids(railSockets(node, 'out', { ...editing, wired }))).toEqual(['op:o1:out:0']);
		const picked = railSockets(node, 'out', { ...editing, wired, selected: true });
		expect(ids(picked)).toEqual(['op:o1:out:0', 'free:out:+']);
		// Every row has a wire: the free socket stands for a row that is not there yet (its recordId is the last row's).
		expect(picked[1]).toMatchObject({ free: true, add: true, recordId: 'draft:n3', row: 1 });
	});

	it('a new operation of several rows gives every row with no wire its own free socket, selected or not: each is a piece that will be made (slice 1b review, finding 9)', () => {
		const node = con(['a', 'b', 'c'].map((r, i) => ({ recordId: r, in: 'op:o1:in:0', out: `op:o1:out:${i}` })), { draft: true });
		const wired = new Set(['op:o1:in:0', 'op:o1:out:1']);
		for (const selected of [false, true]) {
			const outs = railSockets(node, 'out', { ...editing, wired, selected });
			expect(ids(outs)).toEqual(['op:o1:out:1', 'free:out:a', 'free:out:c']);
			expect(outs.filter((s) => s.free).map((s) => s.recordId)).toEqual(['a', 'c']);
		}
	});

	it('a row alone, or a card that is not a new operation (a deck, a recorded one), has at most the one free socket, for the first row with no wire', () => {
		const rows = ['a', 'b'].map((r, i) => ({ recordId: r, in: 'op:o1:in:0', out: `op:o1:out:${i}` }));
		const wired = new Set(['op:o1:in:0']);
		expect(ids(railSockets(con(rows, { draft: true, stacked: true }), 'out', { ...editing, wired, selected: true }))).toEqual(['free:out:a']);
		expect(ids(railSockets(con(rows), 'out', { ...editing, wired, selected: true }))).toEqual(['free:out:a']); // (a recorded operation has no edit sockets on the card at all: ContainerNode draws them for drafts only)
		const one = con([{ recordId: 'a', in: 'op:o1:in:0', out: 'op:o1:out:0' }], { draft: true });
		expect(ids(railSockets(one, 'out', { ...editing, wired, selected: false }))).toEqual(['free:out:a']); // nothing wired on that side
	});

	it('never adds a free socket that is not editable, to a deck of passes, to a recorded operation, or to a test output', () => {
		const rows = [{ recordId: 'a', in: 'op:o1:in:0', out: 'op:o1:out:0' }];
		const wired = new Set(['op:o1:in:0', 'op:o1:out:0']);
		expect(ids(railSockets(con(rows, { draft: true }), 'out', { wired, selected: true }))).toEqual(['op:o1:out:0']);
		expect(ids(railSockets(con(rows, { draft: true, stacked: true }), 'out', { ...editing, wired, selected: true }))).toEqual(['op:o1:out:0']);
		expect(ids(railSockets(con(rows), 'out', { ...editing, wired, selected: true }))).toEqual(['op:o1:out:0']); // not a draft: it cannot grow
		const test = con([{ recordId: 't1', in: 'op:t:in:0' }], { kind: 'test', draft: true });
		expect(railSockets(test, 'out', { ...editing, wired: new Set(['op:t:in:0']), selected: true })).toEqual([]);
	});

	it('a test takes any number of samples: its free input is there when selected, even with every row wired', () => {
		const test = con([{ recordId: 't1', in: 'op:t:in:0' }], { kind: 'test', draft: true });
		const wired = new Set(['op:t:in:0']);
		expect(ids(railSockets(test, 'in', { ...editing, wired }))).toEqual(['op:t:in:0']);
		expect(ids(railSockets(test, 'in', { ...editing, wired, selected: true }))).toEqual(['op:t:in:0', 'free:in:t1']);
	});

	it('is the same, with nothing kept, whenever it is asked again', () => {
		const node = con([{ recordId: 'draft:n3', in: 'op:o1:in:0', out: 'op:o1:out:0' }], { draft: true });
		const o = { ...editing, wired: new Set(['op:o1:in:0']), selected: true };
		expect(railSockets(node, 'out', o)).toEqual(railSockets(node, 'out', o));
		expect(JSON.stringify(node)).not.toContain('free');
	});
});
