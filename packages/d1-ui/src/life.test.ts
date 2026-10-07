import { describe, expect, it } from 'vitest';
import { buildLife, hiddenText, truncatedNotes, type TraceResponse } from './life';

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
		expect(items[0]).toMatchObject({ kind: 'self', label: '12-AA-FAST', sub: 'disc', to: null });
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
		expect(items[3].label).toBe('—');
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
		expect(subs).toEqual(['powder · Acme · 4.5 g used · via A1', 'bar · cut from, fraction 0.5', 'disc', '#3', 'failed']);
	});

	it('puts a "not visible" marker next to each hidden group, never in the middle of another', () => {
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
			'1 not visible to you',
			'2 not visible to you',
			'3 not visible to you',
			'1 not visible to you',
		]);
		expect(items.find((i) => i.key === 'ancestor-a1')!.throughHidden).toBe(true);
	});
});

describe('hiddenText', () => {
	it('is the same wording as the timeline', () => {
		expect(hiddenText(5)).toBe('5 not visible to you');
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
