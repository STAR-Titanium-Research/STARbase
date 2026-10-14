import { describe, expect, it } from 'vitest';
import { applyConditions, matchesRule, type FieldCondition } from './conditions';

const base = { hidden: false, readonly: false, required: false };

// Real rows of directus_fields.conditions (migration 20261014000174).
const HIDE_UNLESS_MACHINING: FieldCondition[] = [
	{ name: 'Hide unless machining', rule: { _and: [{ process_category: { _neq: 'machining' } }] }, hidden: true },
];
const INPUT_SAMPLE: FieldCondition[] = [
	{
		name: 'machining needs an input sample',
		rule: { _and: [{ process_category: { _eq: 'machining' } }] },
		hidden: false,
		readonly: false,
		required: true,
	},
];
const HIDE_UNTIL_SAVED: FieldCondition[] = [
	{ name: 'Hide until saved once', rule: { _and: [{ short_id: { _empty: true } }] }, hidden: true },
];
const SHOW_WHEN_VALUE: FieldCondition[] = [
	{
		name: 'show when it has a value',
		rule: { _and: [{ nc_program_text: { _nempty: true } }] },
		hidden: false,
		readonly: false,
		required: false,
	},
];
const INNER_DIAMETER: FieldCondition[] = [
	{ name: 'sample only', rule: { _and: [{ item_type: { _in: ['equipment', 'miscellaneous'] } }] }, hidden: true, readonly: false, required: false },
	{ name: 'form', rule: { _and: [{ form: { _nin: ['ring'] } }] }, hidden: true, readonly: false, required: false },
];

describe('matchesRule', () => {
	it('_eq and _neq are strict: a number matches its text form, nothing else is converted', () => {
		expect(matchesRule({ a: { _eq: 'x' } }, { a: 'x' })).toBe(true);
		expect(matchesRule({ a: { _eq: 'x' } }, { a: 'y' })).toBe(false);
		expect(matchesRule({ a: { _neq: 'x' } }, { a: 'y' })).toBe(true);
		// a number argument also matches the same number as text, and a numeric text argument the number
		expect(matchesRule({ n: { _eq: 5 } }, { n: '5' })).toBe(true);
		expect(matchesRule({ n: { _eq: '5' } }, { n: 5 })).toBe(true);
		// ...but "5.0" is not 5, "05" is not "5", and Postgres NUMERIC "12.500" is not 12.5
		expect(matchesRule({ n: { _eq: 5 } }, { n: '5.0' })).toBe(false);
		expect(matchesRule({ n: { _eq: '5' } }, { n: '05' })).toBe(false);
		expect(matchesRule({ n: { _eq: 12.5 } }, { n: '12.500' })).toBe(false);
		expect(matchesRule({ n: { _neq: 5 } }, { n: '5.0' })).toBe(true);
		expect(matchesRule({ n: { _neq: 5 } }, { n: '5' })).toBe(false);
		expect(matchesRule({ n: { _eq: '007' } }, { n: '007' })).toBe(true);
		expect(matchesRule({ n: { _eq: '007' } }, { n: 7 })).toBe(true); // Number('007') is 7
		expect(matchesRule({ b: { _eq: true } }, { b: true })).toBe(true);
		expect(matchesRule({ b: { _eq: true } }, { b: false })).toBe(false);
		expect(matchesRule({ b: { _eq: true } }, { b: 'true' })).toBe(false);
		expect(matchesRule({ b: { _eq: '' } }, { b: 0 })).toBe(false);
	});

	it('_neq and _nin are true for a null value, which is why a blank form needs them', () => {
		expect(matchesRule({ a: { _neq: 'x' } }, { a: null })).toBe(true);
		expect(matchesRule({ a: { _nin: ['x', 'y'] } }, { a: null })).toBe(true);
		expect(matchesRule({ a: { _eq: 'x' } }, { a: null })).toBe(false);
		expect(matchesRule({ a: { _eq: null } }, { a: null })).toBe(true);
	});

	it('_in and _nin take a list and compare strictly', () => {
		expect(matchesRule({ a: { _in: ['x', 'y'] } }, { a: 'y' })).toBe(true);
		expect(matchesRule({ a: { _in: ['x', 'y'] } }, { a: 'z' })).toBe(false);
		expect(matchesRule({ a: { _in: [1, 2] } }, { a: '1' })).toBe(false);
		expect(matchesRule({ a: { _nin: ['x', 'y'] } }, { a: 'z' })).toBe(true);
		expect(matchesRule({ a: { _nin: ['x', 'y'] } }, { a: 'x' })).toBe(false);
		// Data Studio takes a list only: comma text is not split
		expect(matchesRule({ a: { _in: 'x, y' } }, { a: 'y' })).toBe(false);
		expect(matchesRule({ a: { _nin: 'x, y' } }, { a: 'z' })).toBe(false);
	});

	it('_null / _nnull: the argument is ignored, so `_null: false` still means null', () => {
		expect(matchesRule({ a: { _null: true } }, { a: null })).toBe(true);
		expect(matchesRule({ a: { _null: true } }, { a: '' })).toBe(false);
		expect(matchesRule({ a: { _nnull: true } }, { a: '' })).toBe(true);
		expect(matchesRule({ a: { _null: false } }, { a: null })).toBe(true);
		expect(matchesRule({ a: { _null: false } }, { a: 'x' })).toBe(false);
		expect(matchesRule({ a: { _nnull: false } }, { a: 'x' })).toBe(true);
		expect(matchesRule({ a: { _nnull: false } }, { a: null })).toBe(false);
	});

	it('_empty is the empty string only; _nempty is anything else, null included', () => {
		expect(matchesRule({ a: { _empty: true } }, { a: '' })).toBe(true);
		expect(matchesRule({ a: { _empty: true } }, { a: null })).toBe(false);
		expect(matchesRule({ a: { _empty: true } }, { a: [] })).toBe(false);
		expect(matchesRule({ a: { _empty: true } }, { a: {} })).toBe(false);
		expect(matchesRule({ a: { _empty: true } }, { a: 0 })).toBe(false);
		expect(matchesRule({ a: { _empty: true } }, { a: ' ' })).toBe(false);
		expect(matchesRule({ a: { _nempty: true } }, { a: 'x' })).toBe(true);
		expect(matchesRule({ a: { _nempty: true } }, { a: ' ' })).toBe(true);
		expect(matchesRule({ a: { _nempty: true } }, { a: null })).toBe(true);
		expect(matchesRule({ a: { _nempty: true } }, { a: [] })).toBe(true);
		expect(matchesRule({ a: { _nempty: true } }, { a: '' })).toBe(false);
		// the argument is ignored here too
		expect(matchesRule({ a: { _empty: false } }, { a: '' })).toBe(true);
		expect(matchesRule({ a: { _empty: false } }, { a: 'x' })).toBe(false);
	});

	it('orders numbers as numbers when the argument is a number, anything else as dates', () => {
		expect(matchesRule({ n: { _gt: 9 } }, { n: '10' })).toBe(true);
		expect(matchesRule({ n: { _gt: '9' } }, { n: 10 })).toBe(true);
		expect(matchesRule({ n: { _gte: 10 } }, { n: 10 })).toBe(true);
		expect(matchesRule({ n: { _lt: 10 } }, { n: 10 })).toBe(false);
		expect(matchesRule({ n: { _lte: 10 } }, { n: 10 })).toBe(true);
		expect(matchesRule({ n: { _gt: 1 } }, { n: null })).toBe(false);
		expect(matchesRule({ n: { _gt: 1 } }, { n: 'abc' })).toBe(false);
		expect(matchesRule({ n: { _between: [1, 5] } }, { n: 3 })).toBe(true);
		expect(matchesRule({ n: { _between: [1, 5] } }, { n: 6 })).toBe(false);
		expect(matchesRule({ n: { _nbetween: [1, 5] } }, { n: 6 })).toBe(true);
		expect(matchesRule({ n: { _nbetween: [1, 5] } }, { n: 3 })).toBe(false);
		expect(matchesRule({ n: { _nbetween: [1, 5] } }, { n: null })).toBe(false);
	});

	it('compares dates as instants, so another zone for the same moment is equal', () => {
		expect(matchesRule({ d: { _gt: '2026-01-01' } }, { d: '2026-10-14' })).toBe(true);
		expect(matchesRule({ d: { _lt: '2026-10-14T10:00:00Z' } }, { d: '2026-10-14T10:30:00+01:00' })).toBe(true); // 09:30Z
		expect(matchesRule({ d: { _gt: '2026-10-14T10:00:00Z' } }, { d: '2026-10-14T10:30:00+01:00' })).toBe(false);
		expect(matchesRule({ d: { _gte: '2026-10-14T09:30:00Z' } }, { d: '2026-10-14T10:30:00+01:00' })).toBe(true);
		expect(matchesRule({ d: { _lte: '2026-10-14T09:30:00Z' } }, { d: '2026-10-14T10:30:00+01:00' })).toBe(true);
		// text ordering would put "…T10:30+01:00" after "…T10:00Z"; as instants it is before
		expect(matchesRule({ d: { _between: ['2026-10-14T00:00:00Z', '2026-10-14T23:59:59Z'] } }, { d: '2026-10-14T10:30:00+01:00' })).toBe(true);
		expect(matchesRule({ d: { _between: ['2026-10-15T00:00:00Z', '2026-10-16T00:00:00Z'] } }, { d: '2026-10-14T10:30:00+01:00' })).toBe(false);
		expect(matchesRule({ d: { _gt: '2026-01-01' } }, { d: 'not a date' })).toBe(false);
		expect(matchesRule({ d: { _gt: '2026-01-01' } }, { d: null })).toBe(false);
	});

	it('string operators', () => {
		expect(matchesRule({ a: { _contains: 'ab' } }, { a: 'xaby' })).toBe(true);
		expect(matchesRule({ a: { _contains: 'AB' } }, { a: 'xaby' })).toBe(false);
		expect(matchesRule({ a: { _ncontains: 'ab' } }, { a: 'xaby' })).toBe(false);
		expect(matchesRule({ a: { _ncontains: 'zz' } }, { a: 'xaby' })).toBe(true);
		expect(matchesRule({ a: { _icontains: 'AB' } }, { a: 'xaby' })).toBe(true);
		expect(matchesRule({ a: { _starts_with: 'x' } }, { a: 'xaby' })).toBe(true);
		expect(matchesRule({ a: { _nstarts_with: 'x' } }, { a: 'xaby' })).toBe(false);
		expect(matchesRule({ a: { _istarts_with: 'XA' } }, { a: 'xaby' })).toBe(true);
		expect(matchesRule({ a: { _ends_with: 'y' } }, { a: 'xaby' })).toBe(true);
		expect(matchesRule({ a: { _ends_with: 'x' } }, { a: 'xaby' })).toBe(false);
		expect(matchesRule({ a: { _niends_with: 'BY' } }, { a: 'xaby' })).toBe(false);
	});

	it('a blank value matches no text operator, not even the negative ones; a list matches by its items', () => {
		for (const op of ['_contains', '_ncontains', '_starts_with', '_nstarts_with', '_ends_with', '_nends_with']) {
			expect(matchesRule({ a: { [op]: 'x' } }, { a: null })).toBe(false);
			expect(matchesRule({ a: { [op]: 'x' } }, { a: '' })).toBe(false);
		}
		expect(matchesRule({ a: { _contains: 'ab' } }, { a: ['zz', 'xaby'] })).toBe(true);
		expect(matchesRule({ a: { _ncontains: 'ab' } }, { a: ['zz', 'xaby'] })).toBe(false);
		expect(matchesRule({ a: { _ncontains: 'ab' } }, { a: ['zz', 'yy'] })).toBe(true);
		expect(matchesRule({ a: { _contains: 5 } }, { a: '5' })).toBe(false); // a text argument only
	});

	it('a text argument starting with $ never matches without a context', () => {
		expect(matchesRule({ a: { _eq: '$CURRENT_USER' } }, { a: 'u1' })).toBe(false);
		expect(matchesRule({ a: { _eq: '$CURRENT_USER' } }, { a: '$CURRENT_USER' })).toBe(false);
		expect(matchesRule({ a: { _neq: '$CURRENT_USER' } }, { a: 'u1' })).toBe(false); // not "true because unequal"
		expect(matchesRule({ a: { _in: ['$CURRENT_USER', 'x'] } }, { a: 'x' })).toBe(false);
		expect(matchesRule({ a: { _gt: '$NOW' } }, { a: '2999-01-01' })).toBe(false);
		expect(matchesRule({ a: { _eq: '$CURRENT_ROLE' } }, { a: 'r1' }, { context: { userId: 'u1' } })).toBe(false);
		expect(matchesRule({ a: { _contains: '$x' } }, { a: '$x' })).toBe(false);
		expect(matchesRule({ _or: [{ a: { _eq: '$CURRENT_USER' } }, { b: { _eq: 1 } }] }, { a: 'u1', b: 1 })).toBe(true);
	});

	it('$CURRENT_USER and $NOW resolve from the context', () => {
		const context = { userId: 'u1', now: new Date('2026-10-14T12:00:00Z') };
		expect(matchesRule({ owner: { _eq: '$CURRENT_USER' } }, { owner: 'u1' }, { context })).toBe(true);
		expect(matchesRule({ owner: { _eq: '$CURRENT_USER' } }, { owner: 'u2' }, { context })).toBe(false);
		expect(matchesRule({ owner: { _neq: '$CURRENT_USER' } }, { owner: 'u2' }, { context })).toBe(true);
		expect(matchesRule({ owner: { _in: ['$CURRENT_USER', 'u9'] } }, { owner: 'u1' }, { context })).toBe(true);
		expect(matchesRule({ owner: { _eq: '$CURRENT_USER' } }, { owner: 'u1' }, { context: { userId: null } })).toBe(false);
		expect(matchesRule({ d: { _lt: '$NOW' } }, { d: '2026-10-14T11:00:00Z' }, { context })).toBe(true);
		expect(matchesRule({ d: { _lt: '$NOW' } }, { d: '2026-10-14T13:00:00Z' }, { context })).toBe(false);
		expect(matchesRule({ d: { _lt: '$NOW' } }, { d: '2026-10-14T11:00:00Z' }, { context: { userId: 'u1' } })).toBe(false);
		// a time-shifted variable ($NOW(-7 days)) is not resolved
		expect(matchesRule({ d: { _gt: '$NOW(-7 days)' } }, { d: '2026-10-14T11:00:00Z' }, { context })).toBe(false);
	});

	it('combines with _and and _or, nested', () => {
		const rule = { _or: [{ a: { _eq: 1 } }, { _and: [{ b: { _eq: 2 } }, { c: { _eq: 3 } }] }] };
		expect(matchesRule(rule, { a: 1 })).toBe(true);
		expect(matchesRule(rule, { b: 2, c: 3 })).toBe(true);
		expect(matchesRule(rule, { b: 2, c: 4 })).toBe(false);
		expect(matchesRule({ _and: [] }, {})).toBe(true);
		expect(matchesRule({ _or: [] }, {})).toBe(false);
	});

	it('several fields in one object must all hold', () => {
		expect(matchesRule({ a: { _eq: 1 }, b: { _eq: 2 } }, { a: 1, b: 2 })).toBe(true);
		expect(matchesRule({ a: { _eq: 1 }, b: { _eq: 2 } }, { a: 1, b: 3 })).toBe(false);
		expect(matchesRule({ a: { _gt: 1, _lt: 5 } }, { a: 3 })).toBe(true);
		expect(matchesRule({ a: { _gt: 1, _lt: 5 } }, { a: 7 })).toBe(false);
	});

	it('reads a nested leaf from a nested value', () => {
		expect(matchesRule({ person: { role: { _eq: 'admin' } } }, { person: { role: 'admin' } })).toBe(true);
		expect(matchesRule({ person: { role: { _eq: 'admin' } } }, { person: null })).toBe(false);
	});

	it('an absent field reads as null by default, and never matches under absent: fail', () => {
		expect(matchesRule({ a: { _null: true } }, {})).toBe(true);
		expect(matchesRule({ a: { _neq: 'x' } }, {})).toBe(true);
		expect(matchesRule({ a: { _empty: true } }, {})).toBe(false); // null is not the empty string
		expect(matchesRule({ a: { _null: true } }, {}, { absent: 'fail' })).toBe(false);
		expect(matchesRule({ short_id: { _empty: true } }, { short_id: '' }, { absent: 'fail' })).toBe(true);
		expect(matchesRule({ a: { _neq: 'x' } }, {}, { absent: 'fail' })).toBe(false);
	});

	it('an empty, malformed, dynamic or unknown rule never matches', () => {
		expect(matchesRule(undefined, {})).toBe(false);
		expect(matchesRule(null, {})).toBe(false);
		expect(matchesRule({}, {})).toBe(false);
		expect(matchesRule([], {})).toBe(false);
		expect(matchesRule({ a: 'x' }, { a: 'x' })).toBe(false);
		expect(matchesRule({ a: { _regex: 'x' } }, { a: 'x' })).toBe(false);
		expect(matchesRule({ a: { _some: { b: { _eq: 1 } } } }, { a: [{ b: 1 }] })).toBe(false);
	});
});

describe('applyConditions', () => {
	it('keeps the base state with no conditions or no match', () => {
		expect(applyConditions(base, undefined, {})).toEqual({ ...base, options: null, by: null });
		expect(applyConditions(base, [], { a: 1 })).toEqual({ ...base, options: null, by: null });
		expect(applyConditions(base, HIDE_UNLESS_MACHINING, { process_category: 'machining' }).hidden).toBe(false);
	});

	it('hides a group unless the category is machining (a blank form too)', () => {
		expect(applyConditions(base, HIDE_UNLESS_MACHINING, { process_category: 'sintering' })).toMatchObject({ hidden: true, by: 'Hide unless machining' });
		expect(applyConditions(base, HIDE_UNLESS_MACHINING, { process_category: null }).hidden).toBe(true);
	});

	it('makes the input sample required for machining only', () => {
		expect(applyConditions(base, INPUT_SAMPLE, { process_category: 'machining' }).required).toBe(true);
		expect(applyConditions(base, INPUT_SAMPLE, { process_category: 'sintering' }).required).toBe(false);
	});

	it('hides Related records until the record has been saved (short_id empty)', () => {
		expect(applyConditions(base, HIDE_UNTIL_SAVED, { short_id: '' }).hidden).toBe(true);
		// absent reads as null, which is not the empty string: a form must hold short_id's default '' (fieldViews does)
		expect(applyConditions(base, HIDE_UNTIL_SAVED, {}).hidden).toBe(false);
		expect(applyConditions(base, HIDE_UNTIL_SAVED, { short_id: null }).hidden).toBe(false);
		expect(applyConditions(base, HIDE_UNTIL_SAVED, { short_id: 'a1b2c3' }).hidden).toBe(false);
	});

	it('a legacy field shown only with a value is hidden at base and shown by its condition', () => {
		const hiddenBase = { ...base, hidden: true };
		expect(applyConditions(hiddenBase, SHOW_WHEN_VALUE, { nc_program_text: '' }).hidden).toBe(true);
		expect(applyConditions(hiddenBase, SHOW_WHEN_VALUE, { nc_program_text: 'G01' }).hidden).toBe(false);
		// as in Data Studio: `_nempty` is true for null, so the rule of migration 174 shows the field when it holds null
		expect(applyConditions(hiddenBase, SHOW_WHEN_VALUE, { nc_program_text: null }).hidden).toBe(false);
	});

	it('takes the last matching condition', () => {
		const rows: FieldCondition[] = [
			{ name: 'first', rule: { a: { _eq: 1 } }, hidden: true },
			{ name: 'second', rule: { b: { _eq: 2 } }, hidden: false, readonly: true },
		];
		expect(applyConditions(base, rows, { a: 1, b: 2 })).toMatchObject({ hidden: false, readonly: true, by: 'second' });
		expect(applyConditions(base, rows, { a: 1, b: 3 })).toMatchObject({ hidden: true, by: 'first' });
	});

	it('the geometry dimension hides for a rig kit and for the wrong form, shows for a ring', () => {
		expect(applyConditions(base, INNER_DIAMETER, { item_type: 'equipment', form: 'ring' }).hidden).toBe(true);
		expect(applyConditions(base, INNER_DIAMETER, { item_type: 'sample', form: 'disc' }).hidden).toBe(true);
		expect(applyConditions(base, INNER_DIAMETER, { item_type: 'sample', form: 'ring' }).hidden).toBe(false);
		// a blank new form: item_type defaults to 'sample', no geometry chosen yet, so the form rule hides it
		expect(applyConditions(base, INNER_DIAMETER, { item_type: 'sample', form: null }).hidden).toBe(true);
	});

	it('a condition that only says hidden leaves required as the field has it', () => {
		const required = { ...base, required: true };
		expect(applyConditions(required, HIDE_UNLESS_MACHINING, { process_category: 'tensile' })).toMatchObject({ hidden: true, required: true });
	});

	it('hands back the options a condition sets', () => {
		const rows: FieldCondition[] = [{ rule: { a: { _eq: 1 } }, options: { choices: [{ text: 'A', value: 'a' }] } }];
		expect(applyConditions(base, rows, { a: 1 }).options).toEqual({ choices: [{ text: 'A', value: 'a' }] });
		expect(applyConditions(base, rows, { a: 2 }).options).toBeNull();
	});

	it('tolerates a null condition entry', () => {
		expect(applyConditions(base, [null as unknown as FieldCondition], {}).hidden).toBe(false);
	});
});
