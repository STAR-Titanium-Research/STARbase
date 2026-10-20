import { describe, expect, it } from 'vitest';
import { indexDefBySlug } from './indexConfig';
import { forgetListPrefs, groupFilters, nextRadioIndex, readListPrefs, validColumns, writeListPrefs } from './listPrefs';

function fakeStorage(initial: Record<string, string> = {}): Storage {
	const m = new Map(Object.entries(initial));
	return {
		get length() { return m.size; },
		clear: () => m.clear(),
		getItem: (k) => m.get(k) ?? null,
		key: (i) => [...m.keys()][i] ?? null,
		removeItem: (k) => void m.delete(k),
		setItem: (k, v) => void m.set(k, String(v)),
	};
}
const throwing = (): Storage => ({
	get length() { return 0; },
	clear() { throw new Error('blocked'); },
	getItem() { throw new Error('blocked'); },
	key() { throw new Error('blocked'); },
	removeItem() { throw new Error('blocked'); },
	setItem() { throw new Error('blocked'); },
});

const samples = indexDefBySlug('samples')!;
const FIELDS = samples.columns.map((c) => c.field);

describe('readListPrefs', () => {
	const DEFAULT = { view: 'table', density: 'normal', columns: null, pageSize: 50, groupBy: null };

	it('defaults to the table at normal density, 50 rows, every column, not grouped', () => {
		expect(readListPrefs('samples', samples, fakeStorage())).toEqual(DEFAULT);
		expect(readListPrefs('samples', samples, null)).toEqual(DEFAULT);
	});

	it('round-trips what was written, per list', () => {
		const s = fakeStorage();
		const mine = { view: 'cards', density: 'roomy', columns: { order: [...FIELDS.slice(1)].reverse(), hidden: ['form'] }, pageSize: 100, groupBy: 'current_status' } as const;
		writeListPrefs('samples', { ...mine, columns: { order: [...mine.columns.order], hidden: [...mine.columns.hidden] } }, s);
		writeListPrefs('operations', { ...DEFAULT, view: 'list', density: 'compact' } as never, s);
		expect(JSON.parse(s.getItem('d1.list.samples')!)).toEqual(mine);
		expect(readListPrefs('samples', samples, s)).toEqual(mine);
		expect(readListPrefs('operations', samples, s)).toEqual({ ...DEFAULT, view: 'list', density: 'compact' });
		expect(readListPrefs('tools', samples, s)).toEqual(DEFAULT);
	});

	it('reads the compact list layout', () => {
		expect(readListPrefs('x', samples, fakeStorage({ 'd1.list.x': '{"view":"list"}' })).view).toBe('list');
	});

	it('falls back to the default for junk', () => {
		for (const raw of ['not json', 'null', '[]', '42', '"cards"', '{}']) {
			expect(readListPrefs('x', samples, fakeStorage({ 'd1.list.x': raw })), raw).toEqual(DEFAULT);
		}
	});

	it('keeps a valid half and defaults the other', () => {
		expect(readListPrefs('x', samples, fakeStorage({ 'd1.list.x': '{"view":"cards","density":"huge"}' }))).toEqual({ ...DEFAULT, view: 'cards' });
		expect(readListPrefs('x', samples, fakeStorage({ 'd1.list.x': '{"view":"grid","density":"roomy"}' }))).toEqual({ ...DEFAULT, density: 'roomy' });
		expect(readListPrefs('x', samples, fakeStorage({ 'd1.list.x': '{"pageSize":30,"columns":"all","groupBy":7}' }))).toEqual(DEFAULT);
		expect(readListPrefs('x', samples, fakeStorage({ 'd1.list.x': '{"pageSize":25}' })).pageSize).toBe(25);
	});

	it('migrates a value stored before columns, page size and group-by existed', () => {
		expect(readListPrefs('samples', samples, fakeStorage({ 'd1.list.samples': '{"view":"cards","density":"roomy"}' }))).toEqual({ ...DEFAULT, view: 'cards', density: 'roomy' });
	});

	it('checks columns and the group-by field against the def: unknown ones are dropped', () => {
		const stored = JSON.stringify({ columns: { order: ['form', 'gone', 'form', 'nickname'], hidden: ['gone', 'nickname', 'sample_code'] }, groupBy: 'current_status' });
		expect(readListPrefs('samples', samples, fakeStorage({ 'd1.list.samples': stored }))).toMatchObject({
			columns: { order: ['form', 'nickname', ...FIELDS.slice(1).filter((f) => f !== 'form' && f !== 'nickname')], hidden: ['nickname'] },
			groupBy: 'current_status',
		});
		for (const groupBy of ['gone', 'no_owner', 'team', 'nickname']) {
			expect(readListPrefs('samples', samples, fakeStorage({ 'd1.list.samples': JSON.stringify({ groupBy }) })).groupBy, groupBy).toBeNull();
		}
	});

	it('does not throw when storage is blocked', () => {
		expect(readListPrefs('x', samples, throwing())).toEqual(DEFAULT);
		expect(() => writeListPrefs('x', DEFAULT as never, throwing())).not.toThrow();
		expect(() => writeListPrefs('x', DEFAULT as never, null)).not.toThrow();
	});
});

describe('validColumns', () => {
	const REST = FIELDS.slice(1);
	it('keeps what is hidden and the order, never naming the first column, each column once and only the def\'s', () => {
		expect(validColumns(samples, { order: ['form', 'sample_code', 'nope', 'form'], hidden: ['sample_code', 'nickname', 'nickname', 'nope'] })).toEqual({
			order: ['form', ...REST.filter((f) => f !== 'form')],
			hidden: ['nickname'],
		});
	});
	it('puts a column the value does not name (one added to the list later) at the end of the order, shown', () => {
		const v = validColumns(samples, { order: REST.slice(0, 3), hidden: [REST[0]] })!;
		expect(v.order).toEqual(REST);
		expect(v.hidden).toEqual([REST[0]]);
	});
	it('is null when everything is shown in the def order, or for something that is not stored columns', () => {
		expect(validColumns(samples, { order: REST, hidden: [] })).toBeNull();
		expect(validColumns(samples, { order: REST.slice(0, 2), hidden: [] })).toBeNull();
		expect(validColumns(samples, { order: [...REST].reverse(), hidden: [] })).toEqual({ order: [...REST].reverse(), hidden: [] });
		for (const junk of ['form', undefined, null, 5, {}]) expect(validColumns(samples, junk), String(junk)).toBeNull();
	});
	it('reads the first shape, a list of the shown columns: what it leaves out is hidden', () => {
		expect(validColumns(samples, ['sample_code', 'form', 'nickname'])).toEqual({
			order: ['form', 'nickname', ...REST.filter((f) => f !== 'form' && f !== 'nickname')],
			hidden: REST.filter((f) => f !== 'form' && f !== 'nickname'),
		});
		expect(validColumns(samples, FIELDS)).toBeNull();
		expect(validColumns(samples, [])).toEqual({ order: REST, hidden: REST });
	});
});

describe('groupFilters', () => {
	it('offers the enum and relation filters only', () => {
		expect(groupFilters(samples).map((f) => f.field)).toEqual(['project_id', 'current_status', 'material_id']);
	});
});

describe('nextRadioIndex', () => {
	it('moves with the arrows and wraps', () => {
		expect(nextRadioIndex(3, 0, 'ArrowRight')).toBe(1);
		expect(nextRadioIndex(3, 2, 'ArrowRight')).toBe(0);
		expect(nextRadioIndex(3, 0, 'ArrowLeft')).toBe(2);
		expect(nextRadioIndex(3, 1, 'ArrowDown')).toBe(2);
		expect(nextRadioIndex(3, 1, 'ArrowUp')).toBe(0);
	});

	it('jumps to the ends with Home and End and ignores other keys', () => {
		expect(nextRadioIndex(3, 1, 'Home')).toBe(0);
		expect(nextRadioIndex(3, 1, 'End')).toBe(2);
		expect(nextRadioIndex(3, 1, 'Enter')).toBeNull();
		expect(nextRadioIndex(0, 0, 'ArrowRight')).toBeNull();
	});
});

describe('forgetListPrefs', () => {
	it('clears the list prefs and the record pages\' View rail keys, and nothing else', () => {
		const storage = fakeStorage({
			'd1.list.samples': '{"view":"cards","density":"roomy"}',
			'd1.list.projects': '{"view":"cards"}',
			'd1.list.samples.open': '1',
			'd1.view.sample': '{"panels":2}',
			'd1.view.sample.open': '1',
			'd1.view.project': '{"range":"all"}',
			'starbase.theme': 'dark',
			'd1.listing': 'keep',
			other: 'x',
		});
		forgetListPrefs(storage);
		expect(storage.getItem('d1.list.samples')).toBeNull();
		expect(storage.getItem('d1.list.projects')).toBeNull();
		for (const k of ['d1.list.samples.open', 'd1.view.sample', 'd1.view.sample.open', 'd1.view.project']) expect(storage.getItem(k), k).toBeNull();
		expect(storage.getItem('starbase.theme')).toBe('dark');
		expect(storage.getItem('d1.listing')).toBe('keep');
		expect(storage.getItem('other')).toBe('x');
		expect(readListPrefs('samples', samples, storage)).toMatchObject({ view: 'table', density: 'normal' });
	});
	it('does nothing without storage, and survives storage that throws', () => {
		expect(() => forgetListPrefs(null)).not.toThrow();
		expect(() => forgetListPrefs(throwing())).not.toThrow();
	});
});
