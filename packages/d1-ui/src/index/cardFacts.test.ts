import { describe, expect, it } from 'vitest';
import { indexDefBySlug } from './indexConfig';
import { cardFacts, cardHead, isPlainClick, sortFieldOptions } from './cardFacts';

const samples = indexDefBySlug('samples')!;
const operators = indexDefBySlug('machine-operators')!;
const tools = indexDefBySlug('tools')!;

describe('cardHead', () => {
	it('uses a code as the link and the next column as the title', () => {
		expect(cardHead(samples, { sample_code: 'S-1', nickname: 'Bar A' })).toEqual({ link: 'S-1', mono: true, sub: 'Bar A' });
	});
	it('uses a name as the link when the first column is not a code', () => {
		expect(cardHead(operators, { Name: 'Ana', equipment: 'Lathe' })).toEqual({ link: 'Ana', mono: false, sub: '' });
	});
	it('gives an empty link for a row with no first value', () => {
		expect(cardHead(samples, {}).link).toBe('');
	});
});

describe('cardFacts', () => {
	const row = {
		sample_code: 'S-1', nickname: 'Bar A', material_id: { alloy_code: 'Ti64' }, project_id: { project_code: 'P1' },
		form: 'bar', current_status: 'stored', location: 'Shelf 2', created_at: '2026-03-05T10:00:00Z',
	};
	it('lists the columns after the code and title, formatted like the table, at most four', () => {
		const facts = cardFacts(samples, row);
		expect(facts).toHaveLength(4);
		expect(facts.map((f) => f.label)).toEqual(['Material', 'Project', 'Geometry', 'Status']);
		expect(facts[0]).toEqual({ label: 'Material', value: 'Ti64' });
	});
	it('skips empty values and a relation the role cannot read', () => {
		const facts = cardFacts(samples, { ...row, material_id: 'bare-key', project_id: null, form: '', current_status: null });
		expect(facts.map((f) => f.label)).toEqual(['Location', 'Created']);
	});
	it('starts at the second column when the first is a name', () => {
		expect(cardFacts(operators, { Name: 'Ana', equipment: 'Lathe' })).toEqual([{ label: 'Equipment', value: 'Lathe' }]);
	});
	it('shows booleans as Yes and No', () => {
		const facts = cardFacts(tools, { tool_code: 'T1', tool_name: 'Drill', tool_type: 'bit', manufacturer_id: null, is_active: false });
		expect(facts).toEqual([{ label: 'Type', value: 'bit' }, { label: 'Active', value: 'No' }]);
	});
});

describe('isPlainClick', () => {
	const ev = (o: Partial<Parameters<typeof isPlainClick>[0]> = {}) => ({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
	it('is only a bare left click', () => {
		expect(isPlainClick(ev())).toBe(true);
		expect(isPlainClick(ev({ ctrlKey: true }))).toBe(false);
		expect(isPlainClick(ev({ metaKey: true }))).toBe(false);
		expect(isPlainClick(ev({ button: 1 }))).toBe(false);
	});
});

describe('sortFieldOptions', () => {
	it('offers each sortable column once, a relation sorted by its display field', () => {
		const opts = sortFieldOptions(samples, '-created_at');
		expect(opts.find((o) => o.value === 'material_id.alloy_code')?.label).toBe('Material');
		expect(opts.find((o) => o.value === 'sample_code')?.label).toBe('Code');
		expect(opts.some((o) => o.value.startsWith('-'))).toBe(false);
		expect(opts.map((o) => o.value)).toEqual([...new Set(opts.map((o) => o.value))]);
	});
	it('leaves out a column that cannot be sorted', () => {
		const opts = sortFieldOptions(samples, '-created_at', (c) => !c.relation);
		expect(opts.some((o) => o.value.startsWith('material_id'))).toBe(false);
	});
	it('puts the default order first when no column carries it', () => {
		expect(sortFieldOptions(tools, '-created_at')[0]).toEqual({ value: 'created_at', label: 'Default order' });
		expect(sortFieldOptions(samples, '-created_at').some((o) => o.label === 'Default order')).toBe(false);
	});
	it('adds a current sort the page does not offer once, never twice', () => {
		expect(sortFieldOptions(samples, '-nickname').filter((o) => o.value === 'nickname')).toHaveLength(1);
		expect(sortFieldOptions(samples, 'weird')[0]).toEqual({ value: 'weird', label: 'Saved view order' });
	});
});
