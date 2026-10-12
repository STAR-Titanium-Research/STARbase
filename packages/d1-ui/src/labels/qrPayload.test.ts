import { describe, expect, it } from 'vitest';
import { buildQrPayload, effectiveQrKeys, parseQrPayload, QR_HEADER } from './qrPayload';
import { isPrintableSample } from './sample';
import { QR_KEYS, type LabelSample } from './types';

const full: LabelSample = {
	id: 'u1', code: 'S-0123', shortId: '1a2b3c4d', nickname: 'bracket A', material: 'Ti-6Al-4V', date: '2026-10-01', ownerInitials: 'DP',
	ownerEmail: 'dp@example.org',
};
const CONTACT = 'lab@example.org';
const FULL_TEXT = [
	'D1 SAMPLE', 'S-0123 | 1a2b3c4d', 'Ti-6Al-4V | "bracket A"', '2026-10-01 | DP', 'dp@example.org', 'Contact: lab@example.org',
].join('\n');
const NO_CONTACT = FULL_TEXT.replace('\nContact: lab@example.org', '');

describe('buildQrPayload', () => {
	it('carries the whole set by default', () => {
		expect(buildQrPayload(full, CONTACT)).toBe(FULL_TEXT);
		expect(QR_HEADER).toBe('D1 SAMPLE');
	});
	it('skips an empty value and drops a line with nothing on it', () => {
		expect(buildQrPayload({ ...full, ownerEmail: null }, CONTACT)).toBe(
			'D1 SAMPLE\nS-0123 | 1a2b3c4d\nTi-6Al-4V | "bracket A"\n2026-10-01 | DP\nContact: lab@example.org'
		);
		expect(buildQrPayload({ ...full, nickname: null }, CONTACT).split('\n')[2]).toBe('Ti-6Al-4V');
		expect(buildQrPayload({ ...full, nickname: null, material: null }, CONTACT).split('\n')).toEqual([
			'D1 SAMPLE', 'S-0123 | 1a2b3c4d', '2026-10-01 | DP', 'dp@example.org', 'Contact: lab@example.org',
		]);
		expect(buildQrPayload(full, null)).toBe(NO_CONTACT);
		expect(buildQrPayload(full, '  ')).toBe(NO_CONTACT);
		const bare = { ...full, nickname: null, material: null, date: null, ownerInitials: null, ownerEmail: null };
		expect(buildQrPayload(bare, null)).toBe('D1 SAMPLE\nS-0123 | 1a2b3c4d');
	});
	it('lets a template leave extras out; code and short id are always there', () => {
		expect(buildQrPayload(full, CONTACT, ['date'])).toBe('D1 SAMPLE\nS-0123 | 1a2b3c4d\n2026-10-01');
		expect(buildQrPayload(full, CONTACT, ['contact_email', 'owner_email'])).toBe(
			'D1 SAMPLE\nS-0123 | 1a2b3c4d\ndp@example.org\nContact: lab@example.org'
		);
		expect(buildQrPayload(full, CONTACT, ['nickname'])).toBe('D1 SAMPLE\nS-0123 | 1a2b3c4d\n"bracket A"');
	});
	it('treats an empty or all-unknown key list as all (legacy templates)', () => {
		expect(buildQrPayload(full, CONTACT, [])).toBe(FULL_TEXT);
		expect(buildQrPayload(full, CONTACT, ['nope' as never])).toBe(FULL_TEXT);
		expect(effectiveQrKeys(null)).toEqual(QR_KEYS);
		expect(effectiveQrKeys(['date'])).toEqual(['date']);
	});
	it('keeps every value on its own line: newlines and tabs become spaces', () => {
		const p = buildQrPayload({ ...full, nickname: 'line one\r\nline two\tend\n' }, 'a@b.c\nd');
		expect(p.split('\n')).toEqual([
			'D1 SAMPLE', 'S-0123 | 1a2b3c4d', 'Ti-6Al-4V | "line one line two end"', '2026-10-01 | DP', 'dp@example.org', 'Contact: a@b.c d',
		]);
	});
	it('is printable ASCII apart from the user text, so a scanner can type every line', () => {
		const p = buildQrPayload(full, CONTACT);
		expect(/^[\x20-\x7e\n]*$/.test(p)).toBe(true);
		expect(p).not.toContain('·');
		// the user text may be anything; the header, separators and labels are ours and stay ASCII
		const odd = buildQrPayload({ ...full, nickname: 'Größe' }, CONTACT);
		expect(/[^\x20-\x7e\n]/.test(odd.replace('Größe', ''))).toBe(false);
	});
});

describe('parseQrPayload', () => {
	it('round-trips code, short id and the other lines', () => {
		expect(parseQrPayload(buildQrPayload(full, CONTACT))).toEqual({
			code: 'S-0123', shortId: '1a2b3c4d',
			lines: ['Ti-6Al-4V | "bracket A"', '2026-10-01 | DP', 'dp@example.org', 'Contact: lab@example.org'],
		});
	});
	it('round-trips with the email, nickname and contact missing', () => {
		const p = buildQrPayload({ ...full, ownerEmail: null, nickname: null }, null);
		expect(parseQrPayload(p)).toEqual({ code: 'S-0123', shortId: '1a2b3c4d', lines: ['Ti-6Al-4V', '2026-10-01 | DP'] });
	});
	it('round-trips a nickname with the separator and newlines in it', () => {
		const parsed = parseQrPayload(buildQrPayload({ ...full, nickname: 'a | b\nc | d' }, CONTACT));
		expect(parsed?.code).toBe('S-0123');
		expect(parsed?.shortId).toBe('1a2b3c4d');
		expect(parsed?.lines[0]).toBe('Ti-6Al-4V | "a | b c | d"');
	});
	it('still finds the short id when the code itself contains the separator', () => {
		expect(parseQrPayload(buildQrPayload({ ...full, code: 'X | Y' }, CONTACT))).toMatchObject({ code: 'X | Y', shortId: '1a2b3c4d' });
	});
	it('tolerates CRLF, a trailing newline and a longer short id', () => {
		expect(parseQrPayload('D1 SAMPLE\r\nS-1 | 0123456789abcdef\r\n')).toEqual({ code: 'S-1', shortId: '0123456789abcdef', lines: [] });
	});
	it('splits on lone CR as well as CRLF and LF', () => {
		expect(parseQrPayload('D1 SAMPLE\rS-1 | 1a2b3c4d\rTi | "x"')).toEqual({ code: 'S-1', shortId: '1a2b3c4d', lines: ['Ti | "x"'] });
		expect(parseQrPayload('D1 SAMPLE\r\nS-1 | 1a2b3c4d\r\nline')).toMatchObject({ lines: ['line'] });
	});
	it('reads a code line typed by a scanner that has no dot: " - " or " | "', () => {
		expect(parseQrPayload('D1 SAMPLE\nS-0123 - 1a2b3c4d')).toEqual({ code: 'S-0123', shortId: '1a2b3c4d', lines: [] });
		expect(parseQrPayload('D1 SAMPLE\nS-0123 | 1a2b3c4d\nextra')).toEqual({ code: 'S-0123', shortId: '1a2b3c4d', lines: ['extra'] });
		expect(parseQrPayload('D1 SAMPLE\n10-AA-MF-2023-06-03 - 0123456789abcdef')).toMatchObject({ code: '10-AA-MF-2023-06-03' });
	});
	it('still reads labels printed with the middle dot', () => {
		const dot = '·';
		expect(parseQrPayload(`D1 SAMPLE\nS-0123 ${dot} 1a2b3c4d\nTi-6Al-4V ${dot} "bracket A"\n2026-10-01 ${dot} DP`)).toEqual({
			code: 'S-0123', shortId: '1a2b3c4d', lines: [`Ti-6Al-4V ${dot} "bracket A"`, `2026-10-01 ${dot} DP`],
		});
		expect(parseQrPayload(buildQrPayload(full, CONTACT).replace(' | ', ` ${dot} `))).toMatchObject({ code: 'S-0123', shortId: '1a2b3c4d' });
		expect(parseQrPayload(`D1 SAMPLE\nX ${dot} Y ${dot} 1a2b3c4d`)).toMatchObject({ code: `X ${dot} Y`, shortId: '1a2b3c4d' });
	});
	it('reads what a scanner with Caps Lock on types, and lower-cases the short id', () => {
		expect(parseQrPayload('D1 SAMPLE\nS-0123 - 1A2B3C4D')).toEqual({ code: 'S-0123', shortId: '1a2b3c4d', lines: [] });
	});
	it('accepts a stray non-ASCII separator, no separator at all, and extra spaces', () => {
		expect(parseQrPayload('D1 SAMPLE\nS-0123 ? 1a2b3c4d')).toMatchObject({ code: 'S-0123', shortId: '1a2b3c4d' });
		expect(parseQrPayload('D1 SAMPLE\nS-0123 1a2b3c4d')).toMatchObject({ code: 'S-0123', shortId: '1a2b3c4d' });
		expect(parseQrPayload('D1 SAMPLE\n  S-0123   |   1a2b3c4d ')).toMatchObject({ code: 'S-0123', shortId: '1a2b3c4d' });
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
		expect(parseQrPayload('D1 SAMPLE\nS-1 | NOTHEX12')).toBeNull();
		expect(parseQrPayload('d1 sample\nS-1 | 1a2b3c4d')).toBeNull();
		expect(parseQrPayload('Hello\nD1 SAMPLE\nS-1 | 1a2b3c4d')).toBeNull();
		expect(parseQrPayload(null as unknown as string)).toBeNull();
	});
});

describe('build then parse', () => {
	const collapse = (v: string) => v.replace(/\s+/g, ' ').trim();
	// Awkward but valid values: separators in the code, newlines and quotes in the nickname, unicode, long short ids.
	const codes = ['S-0123', '10-AA-MF-2023-06-03', 'X | Y', 'A - deadbeef', 'A | b', ' padded ', 'Ünï-コード', 'a\nb', 'W'.repeat(40)];
	const shortIds = ['1a2b3c4d', '0123456789abcdef', 'f'.repeat(32)];
	const nicknames = [null, 'bracket A', 'a | b\nc | d', '"quoted"', '</svg><script>', 'line1\r\nline2\rline3', 'trailing   '];

	it('round-trips code and short id for every valid sample, with everything on', () => {
		for (const code of codes) {
			for (const shortId of shortIds) {
				for (const nickname of nicknames) {
					const s: LabelSample = { ...full, code, shortId, nickname };
					expect(isPrintableSample(s)).toBe(true);
					const parsed = parseQrPayload(buildQrPayload(s, CONTACT));
					expect(parsed, JSON.stringify(s)).not.toBeNull();
					expect(parsed!.code).toBe(collapse(code));
					expect(parsed!.shortId).toBe(shortId);
					expect(parsed!.lines.length).toBeLessThanOrEqual(4);
				}
			}
		}
	});
	it('does not round-trip a sample without a code or short id, which the renderer refuses to print', () => {
		const bad = { ...full, code: '' };
		expect(isPrintableSample(bad)).toBe(false);
		expect(parseQrPayload(buildQrPayload(bad, CONTACT))).toBeNull();
		expect(isPrintableSample({ ...full, shortId: '' })).toBe(false);
		expect(parseQrPayload(buildQrPayload({ ...full, shortId: '' }, CONTACT))).toBeNull();
	});
});
