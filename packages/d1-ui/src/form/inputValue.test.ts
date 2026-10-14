import { describe, expect, it } from 'vitest';
import { inputText, isOtherValue, parseInput } from './inputValue';

const f = (kind: string, type = 'string') => ({ kind, type }) as any;

describe('inputText', () => {
	it('is blank for no value and never prints null', () => {
		expect(inputText(f('text'), null)).toBe('');
		expect(inputText(f('number'), undefined)).toBe('');
		expect(inputText(f('text'), '')).toBe('');
	});
	it('shows numbers, text and dates as typed', () => {
		expect(inputText(f('number', 'decimal'), '12.500')).toBe('12.500');
		expect(inputText(f('number'), 0)).toBe('0');
		expect(inputText(f('date', 'date'), '2026-10-14')).toBe('2026-10-14');
		expect(inputText(f('date', 'date'), '2026-10-14T00:00:00.000Z')).toBe('2026-10-14');
		expect(inputText(f('time', 'time'), '09:30:00')).toBe('09:30:00');
	});
	it('shows a zone-less date-time as stored, and a date alone at midnight', () => {
		expect(inputText(f('datetime', 'dateTime'), '2026-10-14T09:30:15')).toBe('2026-10-14T09:30');
		expect(inputText(f('datetime', 'dateTime'), '2026-10-14 09:30:15')).toBe('2026-10-14T09:30');
		expect(inputText(f('datetime', 'dateTime'), '2026-10-14')).toBe('2026-10-14T00:00');
	});
	it('shows a UTC timestamp in local time (a round trip returns the same instant)', () => {
		const stored = '2026-10-14T09:30:00.000Z';
		const text = inputText(f('datetime', 'timestamp'), stored);
		expect(text).toMatch(/^2026-10-1[345]T\d\d:\d\d$/);
		expect(parseInput(f('datetime', 'timestamp'), text)).toBe(stored);
	});
});

describe('parseInput', () => {
	it('blank is null', () => {
		expect(parseInput(f('text'), '')).toBeNull();
		expect(parseInput(f('number'), '  ')).toBeNull();
		expect(parseInput(f('datetime', 'timestamp'), '')).toBeNull();
	});
	it('numbers are numbers; text that is not one is null', () => {
		expect(parseInput(f('number'), '12.5')).toBe(12.5);
		expect(parseInput(f('number'), '0')).toBe(0);
		expect(parseInput(f('number'), '1e3')).toBe(1000);
		expect(parseInput(f('number'), 'abc')).toBeNull();
	});
	it('text keeps what was typed, notes keep their spaces', () => {
		expect(parseInput(f('text'), 'S-1')).toBe('S-1');
		expect(parseInput(f('textarea'), ' line one\nline two ')).toBe(' line one\nline two ');
	});
	it('dates, times and zone-less date-times', () => {
		expect(parseInput(f('date', 'date'), '2026-10-14')).toBe('2026-10-14');
		expect(parseInput(f('time', 'time'), '09:30')).toBe('09:30:00');
		expect(parseInput(f('datetime', 'dateTime'), '2026-10-14T09:30')).toBe('2026-10-14T09:30:00');
		expect(parseInput(f('datetime', 'timestamp'), 'not a date')).toBeNull();
	});
});

describe('isOtherValue', () => {
	const field = { allowOther: true, choices: [{ text: 'None', value: 'none' }, { text: 'Ground', value: 'ground' }] };
	it('is a value outside the choices in a field that allows one', () => {
		expect(isOtherValue(field, 'electro-polished')).toBe(true);
		expect(isOtherValue(field, 'ground')).toBe(false);
		expect(isOtherValue(field, null)).toBe(false);
		expect(isOtherValue({ ...field, allowOther: false }, 'electro-polished')).toBe(false);
	});
});
