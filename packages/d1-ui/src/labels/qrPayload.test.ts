import { describe, expect, it } from 'vitest';
import { buildQrPayload, parseQrPayload, QR_HEADER } from './qrPayload';
import { isPrintableSample } from './sample';
import type { LabelSample } from './types';

const full: LabelSample = {
	id: 'u1', code: 'S-0123', shortId: '1a2b3c4d', nickname: 'bracket A', material: 'Ti-6Al-4V', date: '2026-10-01', ownerInitials: 'DP',
};

describe('buildQrPayload', () => {
	it('always has the header, code and short id', () => {
		expect(buildQrPayload(full, [])).toBe('D1 SAMPLE\nS-0123 · 1a2b3c4d');
		expect(QR_HEADER).toBe('D1 SAMPLE');
	});
	it('matches the spec example with every extra', () => {
		expect(buildQrPayload(full, ['material', 'nickname', 'date', 'owner_initials'])).toBe(
			'D1 SAMPLE\nS-0123 · 1a2b3c4d\nTi-6Al-4V · "bracket A"\n2026-10-01 · DP'
		);
	});
	it('adds only the chosen extras, whatever order they are given in, and ignores the always-on keys', () => {
		expect(buildQrPayload(full, ['date', 'sample_code', 'short_id'])).toBe('D1 SAMPLE\nS-0123 · 1a2b3c4d\n2026-10-01');
		expect(buildQrPayload(full, ['nickname'])).toBe('D1 SAMPLE\nS-0123 · 1a2b3c4d\n"bracket A"');
	});
	it('leaves out extras the sample does not have', () => {
		const bare = { ...full, nickname: null, material: null, date: null, ownerInitials: null };
		expect(buildQrPayload(bare, ['material', 'nickname', 'date', 'owner_initials'])).toBe('D1 SAMPLE\nS-0123 · 1a2b3c4d');
	});
	it('keeps every value on its own line: newlines and tabs in a nickname become spaces', () => {
		const p = buildQrPayload({ ...full, nickname: 'line one\r\nline two\tend\n' }, ['nickname']);
		expect(p.split('\n')).toEqual(['D1 SAMPLE', 'S-0123 · 1a2b3c4d', '"line one line two end"']);
	});
});

describe('parseQrPayload', () => {
	it('round-trips code, short id and extra lines', () => {
		const p = buildQrPayload(full, ['material', 'nickname', 'date', 'owner_initials']);
		expect(parseQrPayload(p)).toEqual({
			code: 'S-0123', shortId: '1a2b3c4d', lines: ['Ti-6Al-4V · "bracket A"', '2026-10-01 · DP'],
		});
	});
	it('round-trips a nickname with the separator dot and newlines in it', () => {
		const s = { ...full, nickname: 'a · b\nc · d' };
		const parsed = parseQrPayload(buildQrPayload(s, ['nickname']));
		expect(parsed?.code).toBe('S-0123');
		expect(parsed?.shortId).toBe('1a2b3c4d');
		expect(parsed?.lines).toEqual(['"a · b c · d"']);
	});
	it('still finds the short id when the code itself contains the separator', () => {
		expect(parseQrPayload(buildQrPayload({ ...full, code: 'X · Y' }, []))).toMatchObject({ code: 'X · Y', shortId: '1a2b3c4d' });
	});
	it('tolerates CRLF, a trailing newline and a longer short id', () => {
		expect(parseQrPayload('D1 SAMPLE\r\nS-1 · 0123456789abcdef\r\n')).toEqual({ code: 'S-1', shortId: '0123456789abcdef', lines: [] });
	});
	it('splits on lone CR as well as CRLF and LF', () => {
		expect(parseQrPayload('D1 SAMPLE\rS-1 · 1a2b3c4d\rTi · "x"')).toEqual({ code: 'S-1', shortId: '1a2b3c4d', lines: ['Ti · "x"'] });
		expect(parseQrPayload('D1 SAMPLE\r\nS-1 · 1a2b3c4d\r\nline')).toMatchObject({ lines: ['line'] });
	});
	it('reads a code line typed by a scanner that has no dot: " - " or " | "', () => {
		expect(parseQrPayload('D1 SAMPLE\nS-0123 - 1a2b3c4d')).toEqual({ code: 'S-0123', shortId: '1a2b3c4d', lines: [] });
		expect(parseQrPayload('D1 SAMPLE\nS-0123 | 1a2b3c4d\nextra')).toEqual({ code: 'S-0123', shortId: '1a2b3c4d', lines: ['extra'] });
		expect(parseQrPayload('D1 SAMPLE\n10-AA-MF-2023-06-03 - 0123456789abcdef')).toMatchObject({ code: '10-AA-MF-2023-06-03' });
	});
	it('does not mistake a hyphenated code for a separator', () => {
		expect(parseQrPayload('D1 SAMPLE\n10-AA-1a2b3c4d')).toBeNull();
		expect(parseQrPayload('D1 SAMPLE\nS-1 -1a2b3c4d')).toBeNull();
	});
	it('rejects text that is not a D1 sample payload', () => {
		expect(parseQrPayload('https://example.org/x')).toBeNull();
		expect(parseQrPayload('')).toBeNull();
		expect(parseQrPayload('D1 SAMPLE')).toBeNull();
		expect(parseQrPayload('D1 SAMPLE\nno short id here')).toBeNull();
		expect(parseQrPayload('D1 SAMPLE\nS-1 · NOTHEX12')).toBeNull();
		expect(parseQrPayload('d1 sample\nS-1 · 1a2b3c4d')).toBeNull();
		expect(parseQrPayload('Hello\nD1 SAMPLE\nS-1 · 1a2b3c4d')).toBeNull();
		expect(parseQrPayload(null as unknown as string)).toBeNull();
	});
});

describe('build then parse', () => {
	const ALL = ['material', 'nickname', 'date', 'owner_initials'] as const;
	const collapse = (v: string) => v.replace(/\s+/g, ' ').trim();
	// Awkward but valid values: separators in the code, newlines and quotes in the nickname, unicode, long short ids.
	const codes = ['S-0123', '10-AA-MF-2023-06-03', 'X · Y', 'A - deadbeef', 'A | b', ' padded ', 'Ünï-コード', 'a\nb', 'W'.repeat(40)];
	const shortIds = ['1a2b3c4d', '0123456789abcdef', 'f'.repeat(32)];
	const nicknames = [null, 'bracket A', 'a · b\nc · d', '"quoted"', '</svg><script>', 'line1\r\nline2\rline3', 'trailing   '];

	it('round-trips code and short id for every valid sample, with every extra on', () => {
		for (const code of codes) {
			for (const shortId of shortIds) {
				for (const nickname of nicknames) {
					const s: LabelSample = { id: 'u', code, shortId, nickname, material: 'Ti-6Al-4V', date: '2026-10-01', ownerInitials: 'DP' };
					expect(isPrintableSample(s)).toBe(true);
					const parsed = parseQrPayload(buildQrPayload(s, ALL));
					expect(parsed, JSON.stringify(s)).not.toBeNull();
					expect(parsed!.code).toBe(collapse(code));
					expect(parsed!.shortId).toBe(shortId);
					expect(parsed!.lines.length).toBeLessThanOrEqual(2);
				}
			}
		}
	});
	it('does not round-trip a sample without a code or short id, which the renderer refuses to print', () => {
		const bad = { id: 'u', code: '', shortId: '1a2b3c4d', nickname: null, material: null, date: null, ownerInitials: null };
		expect(isPrintableSample(bad)).toBe(false);
		expect(parseQrPayload(buildQrPayload(bad, []))).toBeNull();
		expect(isPrintableSample({ ...bad, code: 'S-1', shortId: '' })).toBe(false);
		expect(parseQrPayload(buildQrPayload({ ...bad, code: 'S-1', shortId: '' }, []))).toBeNull();
	});
});
