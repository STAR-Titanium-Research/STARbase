import { describe, expect, it } from 'vitest';
import { breakableParts, errorText, formatDate, formatNumber, asRecord, formatQuantity, isDuplicate, isFilterRefused, isForbidden, isNotVisible } from './format';

describe('formatQuantity', () => {
	it('trims trailing zeros of a database numeric string', () => {
		expect(formatQuantity('12.5000')).toBe('12.5');
		expect(formatQuantity('20.000')).toBe('20');
	});
	it('keeps small values readable instead of rounding them to zero', () => {
		expect(formatQuantity(0.05)).toBe('0.05');
		expect(formatQuantity('0.000001')).toBe('1e-6');
		expect(formatQuantity(0.0000125)).toBe('1.25e-5');
	});
	it('limits the decimals of large values and groups the thousands', () => {
		expect(formatQuantity(1234.5678)).toBe('1,234.6');
		expect(formatQuantity(25600)).toBe('25,600');
	});
	it('handles zero, negatives and non-numbers', () => {
		expect(formatQuantity(0)).toBe('0');
		expect(formatQuantity(-3.25)).toBe('-3.25');
		expect(formatQuantity(null)).toBe('');
		expect(formatQuantity('abc')).toBe('');
	});
});

describe('formatDate', () => {
	it('formats an ISO date for en-GB', () => {
		expect(formatDate('2026-03-05T10:00:00Z')).toBe('5 Mar 2026');
	});
	it('uses the fallback for empty or invalid input', () => {
		expect(formatDate(null, 'undated')).toBe('undated');
		expect(formatDate('not a date', '?')).toBe('?');
	});
});

describe('formatNumber', () => {
	it('adds a unit and trims trailing zeros', () => {
		expect(formatNumber('20.000', 'mm')).toBe('20 mm');
		expect(formatNumber(12.5, 'mm')).toBe('12.5 mm');
	});
	it('is empty for a missing or non-numeric value', () => {
		expect(formatNumber(null, 'mm')).toBe('');
		expect(formatNumber('abc')).toBe('');
	});
	it('keeps zero', () => {
		expect(formatNumber(0, 'g')).toBe('0 g');
	});
});

describe('errorText', () => {
	it('prefers the Directus message', () => {
		expect(errorText({ response: { data: { errors: [{ message: 'nope' }] } }, message: 'x' })).toBe('nope');
		expect(errorText({ message: 'x' })).toBe('x');
		expect(errorText(undefined, 'fallback')).toBe('fallback');
	});
});

describe('isNotVisible', () => {
	it('treats 403 and 404 alike', () => {
		expect(isNotVisible({ response: { status: 403 } })).toBe(true);
		expect(isNotVisible({ response: { status: 404 } })).toBe(true);
		expect(isNotVisible({ response: { status: 500 } })).toBe(false);
		expect(isNotVisible(new Error('offline'))).toBe(false);
	});
});

describe('asRecord', () => {
	it('keeps an expanded relation and drops a bare id', () => {
		expect(asRecord({ a: 1 })).toEqual({ a: 1 });
		expect(asRecord('uuid')).toBeNull();
		expect(asRecord(null)).toBeNull();
		expect(asRecord([1])).toBeNull();
	});
});

describe('isForbidden and isDuplicate', () => {
	it('isForbidden is true only for permission failures, not for other errors', () => {
		const http = (status: number, code?: string) => ({ response: { status, data: { errors: [{ extensions: { code } }] } } });
		expect(isForbidden(http(403, 'FORBIDDEN'))).toBe(true);
		expect(isForbidden({ response: { status: 403 } })).toBe(true);
		expect(isForbidden(http(200, 'FORBIDDEN'))).toBe(true);
		expect(isForbidden(http(500, 'INTERNAL_SERVER_ERROR'))).toBe(false);
		expect(isForbidden(http(503))).toBe(false);
		expect(isForbidden(new Error('Network Error'))).toBe(false);
		expect(isForbidden(undefined)).toBe(false);
	});

	it('isFilterRefused is true for 400, 403, 404 and 5xx answers, not for a network failure or 401', () => {
		const http = (status: number) => ({ response: { status } });
		for (const s of [400, 403, 404, 500, 502, 503]) expect(isFilterRefused(http(s))).toBe(true);
		for (const s of [200, 401, 409, 422]) expect(isFilterRefused(http(s))).toBe(false);
		expect(isFilterRefused(new Error('Network Error'))).toBe(false);
		expect(isFilterRefused(undefined)).toBe(false);
	});

	it('isDuplicate recognises a unique-constraint failure', () => {
		expect(isDuplicate({ response: { status: 400, data: { errors: [{ extensions: { code: 'RECORD_NOT_UNIQUE' } }] } } })).toBe(true);
		expect(isDuplicate({ response: { status: 400, data: { errors: [{ extensions: { code: 'INVALID_PAYLOAD' } }] } } })).toBe(false);
		expect(isDuplicate(new Error('x'))).toBe(false);
	});

	it('isForbidden is not isNotVisible: a 404 is a missing record, not a permission failure', () => {
		expect(isForbidden({ response: { status: 404 } })).toBe(false);
		expect(isNotVisible({ response: { status: 404 } })).toBe(true);
	});
});

describe('breakableParts', () => {
	it('splits after underscores, dashes, dots and spaces, and loses nothing', () => {
		const name = 'Run_12-A_force trace.v2.mat';
		const parts = breakableParts(name);
		expect(parts).toEqual(['Run_', '12-', 'A_', 'force ', 'trace.', 'v2.', 'mat']);
		expect(parts.join('')).toBe(name);
	});

	it('keeps a name without separators whole, and an empty one empty', () => {
		expect(breakableParts('abcdef')).toEqual(['abcdef']);
		expect(breakableParts('')).toEqual([]);
		expect(breakableParts('__a').join('')).toBe('__a');
	});
});
