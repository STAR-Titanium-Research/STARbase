import { describe, expect, it } from 'vitest';
import { buildQrPayload, parseQrPayload, QR_HEADER } from './qrPayload';
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
