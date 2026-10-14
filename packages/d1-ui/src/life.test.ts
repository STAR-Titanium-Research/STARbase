import { describe, expect, it } from 'vitest';
import { buildLife, chipText, chipTitle, daySummary, groupLife, hiddenText, truncatedNotes, type TraceResponse } from './life';

const base = (): TraceResponse => ({
	sample: { sample_id: 's0', sample_code: '12-AA-FAST', form: 'disc' },
	stock_origins: [],
	ancestors: [],
	descendants: [],
	events: [],
	hidden: { stock_origins: 0, ancestors: 0, events: 0, descendants: 0 },
	truncated: {},
});

describe('buildLife', () => {
	it('is just this sample when nothing is related', () => {
		const items = buildLife(base());
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ kind: 'self', label: '12-AA-FAST', sub: 'Disc', to: null });
	});

	it('orders stock, ancestors (oldest first), self, events, descendants (nearest first)', () => {
		const t = base();
		t.stock_origins = [
			{ lot_id: 'l1', lot_code: 'LOT-1', stock_type: 'powder', supplier_name: 'Acme', mass_used_grams: 4.5, via_sample_id: 'a2', via_sample_code: 'A2', depth: 2, through_hidden: false },
		];
		t.ancestors = [
			{ depth: 1, sample_id: 'a1', sample_code: 'A1', form: 'bar', relationship_type: 'cut_from', fraction: 0.5, through_hidden: false },
			{ depth: 2, sample_id: 'a2', sample_code: 'A2', form: 'powder', relationship_type: null, fraction: null, through_hidden: false },
		];
		t.events = [
			{ type: 'manufacturing_operation', collection: 'manufacturing_operations', id: 'o1', date: '2026-01-01', label: 'P1', sequence: 1, status: null },
			{ type: 'test_session', collection: 'test_sessions', id: 't1', date: '2026-02-01', label: 'tensile', sequence: null, status: 'analysed' },
		];
		t.descendants = [
			{ depth: 2, sample_id: 'd2', sample_code: 'D2', form: null, relationship_type: null, fraction: null, through_hidden: false },
			{ depth: 1, sample_id: 'd1', sample_code: 'D1', form: null, relationship_type: null, fraction: null, through_hidden: false },
		];
		const items = buildLife(t);
		expect(items.map((i) => i.label)).toEqual(['LOT-1', 'A2', 'A1', '12-AA-FAST', 'P1', 'tensile', 'D1', 'D2']);
		expect(items.map((i) => i.kind)).toEqual(['stock', 'ancestor', 'ancestor', 'self', 'operation', 'test', 'descendant', 'descendant']);
	});

	it('links every record to its Explorer page, and a stock lot to the Data Studio', () => {
		const t = base();
		t.stock_origins = [
			{ lot_id: 'l1', lot_code: null, stock_type: null, supplier_name: null, mass_used_grams: null, via_sample_id: 's0', via_sample_code: null, depth: 0, through_hidden: false },
		];
		t.ancestors = [{ depth: 1, sample_id: 'a1', sample_code: null, form: null, relationship_type: null, fraction: null, through_hidden: false }];
		t.events = [
			{ type: 'manufacturing_operation', collection: 'manufacturing_operations', id: 'o1', date: null, label: null, sequence: null, status: null },
			{ type: 'test_session', collection: 'test_sessions', id: 't1', date: null, label: 'hardness', sequence: null, status: null },
		];
		const items = buildLife(t);
		expect(items.map((i) => i.to)).toEqual([
			'/content/raw_stock_lots/l1',
			'/home/samples/a1',
			null,
			'/home/operations/o1',
			'/home/tests/t1',
		]);
		expect(items[0].label).toBe('Stock lot');
		expect(items[3].label).toBe('Operation on 12-AA-FAST');
	});

	it('labels an operation without a pass code by the sample and step, not by a bare word', () => {
		const t = base();
		t.events = [{ type: 'manufacturing_operation', collection: 'manufacturing_operations', id: 'o1', date: null, label: null, sequence: 27, status: null }];
		expect(buildLife(t).map((i) => i.label)).toEqual(['12-AA-FAST', '12-AA-FAST · step 27']);
	});

	it('describes stock, relationships and test status on the second line', () => {
		const t = base();
		t.stock_origins = [
			{ lot_id: 'l1', lot_code: 'LOT-1', stock_type: 'powder', supplier_name: 'Acme', mass_used_grams: 4.5, via_sample_id: 'a1', via_sample_code: 'A1', depth: 1, through_hidden: false },
		];
		t.ancestors = [{ depth: 1, sample_id: 'a1', sample_code: 'A1', form: 'bar', relationship_type: 'cut_from', fraction: 0.5, through_hidden: false }];
		t.events = [
			{ type: 'manufacturing_operation', collection: 'manufacturing_operations', id: 'o1', date: null, label: 'P1', sequence: 3, status: null },
			{ type: 'test_session', collection: 'test_sessions', id: 't1', date: null, label: 'tensile', sequence: null, status: 'failed' },
		];
		const subs = buildLife(t).map((i) => i.sub);
		expect(subs).toEqual(['powder · Acme · 4.5 g used · via A1', 'Bar · cut from, fraction 0.5', 'Disc', '#3', 'failed']);
	});

	it('puts a "some records hidden" marker next to each hidden group, never in the middle of another', () => {
		const t = base();
		t.hidden = { stock_origins: 1, ancestors: 2, events: 3, descendants: 1 };
		t.ancestors = [{ depth: 1, sample_id: 'a1', sample_code: 'A1', form: null, relationship_type: null, fraction: null, through_hidden: true }];
		const items = buildLife(t);
		expect(items.map((i) => i.key)).toEqual([
			'hidden-stock_origins',
			'hidden-ancestors',
			'ancestor-a1',
			'self',
			'hidden-events',
			'hidden-descendants',
		]);
		expect(items.filter((i) => i.kind === 'hidden').map((i) => i.label)).toEqual([
			'some records hidden',
			'some records hidden',
			'some records hidden',
			'some records hidden',
		]);
		expect(items.find((i) => i.key === 'ancestor-a1')!.throughHidden).toBe(true);
	});
});

describe('hiddenText', () => {
	it('prints no number, whatever the response carries', () => {
		expect(hiddenText(5)).toBe('some records hidden');
		expect(hiddenText(true)).toBe('some records hidden');
		expect(hiddenText()).toBe('some records hidden');
		expect(hiddenText(5)).not.toMatch(/[0-9]/);
	});

	it('takes booleans from d1-trace: a marker for true, none for false, in the same places', () => {
		const t = base();
		t.hidden = { stock_origins: false, ancestors: true, events: true, descendants: false };
		const items = buildLife(t);
		expect(items.filter((i) => i.kind === 'hidden').map((i) => i.key)).toEqual(['hidden-ancestors', 'hidden-events']);
		expect(items.filter((i) => i.kind === 'hidden').map((i) => i.label)).toEqual(['some records hidden', 'some records hidden']);
	});
});

describe('truncatedNotes', () => {
	it('explains each cut-short list', () => {
		expect(truncatedNotes({ truncated: { events: true, ancestors: true } })).toEqual([
			'Very long history: only the newest 500 operations and tests are shown.',
			'Very long history: only the 500 nearest ancestors are shown.',
		]);
		expect(truncatedNotes({ truncated: {} })).toEqual([]);
	});
});

describe('buildLife: operations without a pass code', () => {
	const ev = (label: string | null, sequence: number | null) =>
		({ type: 'manufacturing_operation' as const, collection: 'manufacturing_operations', id: 'o1', date: null, label, sequence, status: null });

	it('does not repeat the step on the second line when the label already names it', () => {
		const t = base();
		t.events = [ev(null, 27)];
		const op = buildLife(t)[1];
		expect(op.label).toBe('12-AA-FAST · step 27');
		expect(op.sub).toBe('');
	});

	it('keeps the step as the second line under a pass code', () => {
		const t = base();
		t.events = [ev('P1', 3)];
		expect(buildLife(t)[1].sub).toBe('#3');
	});
});

describe('buildLife: isCode', () => {
	it('is true for records labelled by their code and false for descriptive labels', () => {
		const t = base();
		t.stock_origins = [
			{ lot_id: 'l1', lot_code: 'LOT-1', stock_type: null, supplier_name: null, mass_used_grams: null, via_sample_id: 's0', via_sample_code: null, depth: 0, through_hidden: false },
			{ lot_id: 'l2', lot_code: null, stock_type: null, supplier_name: null, mass_used_grams: null, via_sample_id: 's0', via_sample_code: null, depth: 0, through_hidden: false },
		];
		t.ancestors = [
			{ depth: 1, sample_id: 'a1', sample_code: 'A1', form: null, relationship_type: null, fraction: null, through_hidden: false },
			{ depth: 1, sample_id: 'a2', sample_code: null, form: null, relationship_type: null, fraction: null, through_hidden: false },
		];
		t.events = [
			{ type: 'manufacturing_operation', collection: 'manufacturing_operations', id: 'o1', date: null, label: 'P1', sequence: 1, status: null },
			{ type: 'manufacturing_operation', collection: 'manufacturing_operations', id: 'o2', date: null, label: null, sequence: 2, status: null },
			{ type: 'manufacturing_operation', collection: 'manufacturing_operations', id: 'o3', date: null, label: '  ', sequence: null, status: null },
			{ type: 'test_session', collection: 'test_sessions', id: 't1', date: null, label: 'tensile', sequence: null, status: null },
		];
		t.hidden.events = 1;
		t.descendants = [{ depth: 1, sample_id: 'd1', sample_code: 'D1', form: null, relationship_type: null, fraction: null, through_hidden: false }];
		const flags = Object.fromEntries(buildLife(t).map((i) => [i.key, i.isCode]));
		expect(flags).toEqual({
			'stock-l1|s0': true,
			'stock-l2|s0': false,
			'ancestor-a1': true,
			'ancestor-a2': false,
			self: true,
			'manufacturing_operation-o1': true,
			'manufacturing_operation-o2': false,
			'manufacturing_operation-o3': false,
			'test_session-t1': false,
			'hidden-events': false,
			'descendant-d1': true,
		});
	});

	it('is false for this sample without a code', () => {
		const t = base();
		t.sample.sample_code = null;
		expect(buildLife(t)[0]).toMatchObject({ label: 'This sample', isCode: false });
	});
});

describe('groupLife', () => {
	const op = (id: string, date: string | null, sequence: number | null, label: string | null = `P-${id}`) =>
		({ type: 'manufacturing_operation' as const, collection: 'manufacturing_operations', id, date, label, sequence, status: null });
	const test = (id: string, date: string | null) =>
		({ type: 'test_session' as const, collection: 'test_sessions', id, date, label: 'tensile', sequence: null, status: 'analysed' });

	it('folds the operations and tests of one day into one step, and keeps a step per lineage record', () => {
		const t = base();
		t.ancestors = [{ depth: 1, sample_id: 'a1', sample_code: 'A1', form: null, relationship_type: null, fraction: null, through_hidden: false }];
		t.events = [op('o17', '2023-03-31', 17), op('o1', '2023-03-31', 1), test('t1', '2023-03-31'), op('o2', '2023-04-02', 2), op('o9', null, 9)];
		t.hidden.events = true;
		t.descendants = [{ depth: 1, sample_id: 'd1', sample_code: 'D1', form: null, relationship_type: null, fraction: null, through_hidden: false }];
		const steps = groupLife(buildLife(t));
		expect(steps.map((s) => (s.type === 'day' ? s.dayText : s.key))).toEqual([
			'ancestor-a1',
			'self',
			'31 Mar 2023',
			'2 Apr 2023',
			'Undated',
			'hidden-events',
			'descendant-d1',
		]);
		const first = steps[2];
		expect(first.type === 'day' && first.items.map((i) => i.key)).toEqual([
			'manufacturing_operation-o1',
			'manufacturing_operation-o17',
			'test_session-t1',
		]);
		expect(first.type === 'day' && [first.operations, first.tests]).toEqual([2, 1]);
	});

	it('gives every step a distinct key', () => {
		const t = base();
		// An undated event among dated ones (a date the reader may not see) makes two "Undated" days.
		t.events = [op('o1', '2023-03-31', 1), op('o4', null, 4), op('o2', '2023-04-01', 2), op('o3', null, null)];
		const steps = groupLife(buildLife(t));
		expect(steps.filter((s) => s.type === 'day' && s.dayText === 'Undated')).toHaveLength(2);
		const keys = steps.map((s) => s.key);
		expect(new Set(keys).size).toBe(keys.length);
	});
});

describe('day summary and chips', () => {
	it('counts operations and tests in words', () => {
		expect(daySummary({ operations: 26, tests: 2 })).toBe('26 operations · 2 tests');
		expect(daySummary({ operations: 1, tests: 0 })).toBe('1 operation');
		expect(daySummary({ operations: 0, tests: 1 })).toBe('1 test');
	});

	it('names an operation by its step and keeps the full label for the tooltip', () => {
		const t = base();
		t.events = [
			{ type: 'manufacturing_operation', collection: 'manufacturing_operations', id: 'o1', date: null, label: '10-AA-F17-30MPM', sequence: 17, status: null },
			{ type: 'manufacturing_operation', collection: 'manufacturing_operations', id: 'o2', date: null, label: null, sequence: 27, status: null },
			{ type: 'manufacturing_operation', collection: 'manufacturing_operations', id: 'o3', date: null, label: 'P3', sequence: null, status: null },
			{ type: 'test_session', collection: 'test_sessions', id: 't1', date: null, label: 'tensile', sequence: null, status: 'failed' },
		];
		const events = buildLife(t).slice(1);
		expect(events.map(chipText)).toEqual(['#17', '#27', 'P3', 'tensile']);
		expect(events.map(chipTitle)).toEqual(['10-AA-F17-30MPM · step 17', '12-AA-FAST · step 27', 'P3', 'tensile · failed']);
	});
});
