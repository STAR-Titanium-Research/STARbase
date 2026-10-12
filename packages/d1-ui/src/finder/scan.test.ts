import { describe, expect, it } from 'vitest';
import { buildQrPayload } from '../labels/qrPayload';
import { displayText, flattenLines, fromLastHeader, isScanComplete, isScanStarted, normalizeScan, resolveLabel } from './scan';
import type { ScanApi } from './scan';

const PAYLOAD = 'D1 SAMPLE\nS-0123 · 1a2b3c4d\nTi-6Al-4V · "bracket A"\n2026-10-01 · DP';
const row = { sample_id: 'uuid-1', sample_code: 'S-0123', short_id: '1a2b3c4d' };

function api(answers: Array<any | Error>): ScanApi & { calls: any[] } {
	const calls: any[] = [];
	return {
		calls,
		async get(path, cfg) {
			calls.push({ path, filter: JSON.parse(String(cfg?.params?.filter)) });
			const a = answers.shift();
			if (a instanceof Error) throw a;
			return { data: { data: a } };
		},
	};
}
const httpError = (status: number) => Object.assign(new Error('x'), { response: { status } });

describe('isScanStarted', () => {
	it('recognises the header however the line ends', () => {
		for (const t of ['D1 SAMPLE', 'D1 SAMPLE\r', 'D1 SAMPLE\rS-1', 'D1 SAMPLE\r\nS-1 - 1a2b3c4d', '  D1 SAMPLE\n']) expect(isScanStarted(t)).toBe(true);
	});
	it('is false for anything else', () => {
		for (const t of ['', 'S-0123', 'D1 SAMPLES', 'hello\nD1 SAMPLE']) expect(isScanStarted(t)).toBe(false);
	});
});

describe('normalizeScan', () => {
	it('turns CR and CRLF into LF and trims', () => {
		expect(normalizeScan('D1 SAMPLE\rS-1\r\nx\r')).toBe('D1 SAMPLE\nS-1\nx');
	});
});

describe('displayText', () => {
	it('keeps ordinary text, line breaks and tabs', () => {
		expect(displayText('a\nb\tc <b>')).toBe('a\nb\tc <b>');
	});
	it('shows control characters visibly and cuts a long payload', () => {
		expect(displayText('a\u0000b\u001b')).toBe('a\\x00b\\x1b');
		expect(displayText('x'.repeat(2000))).toHaveLength(1001);
	});
});

describe('resolveLabel', () => {
	it('opens the sample found by short id, asking nothing else', async () => {
		const a = api([[row]]);
		const out = await resolveLabel(a, PAYLOAD);
		expect(out).toEqual({ kind: 'open', to: '/home/samples/uuid-1', code: 'S-0123' });
		expect(a.calls).toEqual([{ path: '/items/physical_samples', filter: { short_id: { _eq: '1a2b3c4d' } } }]);
	});
	it('asks for confirmation, and does not open, when only the code matches', async () => {
		const a = api([[], [{ ...row, short_id: 'ffffffff', nickname: 'other' }]]);
		expect(await resolveLabel(a, PAYLOAD)).toEqual({
			kind: 'confirm', to: '/home/samples/uuid-1', code: 'S-0123', shortId: '1a2b3c4d',
			lines: ['Ti-6Al-4V · "bracket A"', '2026-10-01 · DP'], found: { shortId: 'ffffffff', nickname: 'other' },
		});
		expect(a.calls[1].filter).toEqual({ sample_code: { _eq: 'S-0123' } });
	});
	it('reads a payload a scanner typed with CR line ends and "-" for the dot', async () => {
		const typed = 'D1 SAMPLE\rS-0123 - 1a2b3c4d\rTi-6Al-4V\r';
		expect(await resolveLabel(api([[row]]), typed)).toMatchObject({ kind: 'open' });
	});
	it('round-trips what buildQrPayload makes', async () => {
		const text = buildQrPayload({ code: 'A-1', shortId: 'deadbeef', nickname: 'n', material: 'm', date: '2026-01-01', ownerInitials: 'DP' } as any, null, ['material', 'nickname']);
		const a = api([[{ sample_id: 'u', sample_code: 'A-1' }]]);
		await resolveLabel(a, text);
		expect(a.calls[0].filter).toEqual({ short_id: { _eq: 'deadbeef' } });
	});
	it('says not found, keeping the decoded lines, when neither lookup finds it', async () => {
		const out = await resolveLabel(api([[], []]), PAYLOAD);
		expect(out).toMatchObject({ kind: 'failed', reason: 'not_found', code: 'S-0123', shortId: '1a2b3c4d', lines: ['Ti-6Al-4V · "bracket A"', '2026-10-01 · DP'] });
	});
	it('says no access on a 403 and stops', async () => {
		const a = api([httpError(403)]);
		expect(await resolveLabel(a, PAYLOAD)).toMatchObject({ kind: 'failed', reason: 'no_access', code: 'S-0123' });
		expect(a.calls).toHaveLength(1);
	});
	it('says network when there was no response', async () => {
		expect(await resolveLabel(api([new Error('Network Error')]), PAYLOAD)).toMatchObject({ kind: 'failed', reason: 'network' });
	});
	it('reports any other server error with its status', async () => {
		const out = await resolveLabel(api([httpError(500)]), PAYLOAD);
		expect(out).toMatchObject({ kind: 'failed', reason: 'error' });
		expect((out as any).message).toContain('500');
	});
	it('returns the text of a non-D1 payload without asking the server', async () => {
		const a = api([]);
		expect(await resolveLabel(a, 'https://example.com/x')).toEqual({ kind: 'text', text: 'https://example.com/x', looksLikeD1: false });
		expect(a.calls).toEqual([]);
	});
	it('flags a D1 header that cannot be read', async () => {
		expect(await resolveLabel(api([]), 'D1 SAMPLE\ngarbage')).toMatchObject({ kind: 'text', looksLikeD1: true });
	});
});

describe('fromLastHeader', () => {
	it('keeps only the label after the last header, so a scan typed after an old one replaces it', () => {
		expect(fromLastHeader('D1 SAMPLE\nA-1 | 11111111\nD1 SAMPLE\nB-2 | 22222222\n')).toBe('D1 SAMPLE\nB-2 | 22222222');
	});
	it('leaves a single label and other text alone', () => {
		expect(fromLastHeader('D1 SAMPLE\rA-1 | 11111111\r')).toBe('D1 SAMPLE\nA-1 | 11111111');
		expect(fromLastHeader('hello\nD1 SAMPLE')).toBe('hello\nD1 SAMPLE');
	});
});

describe('resolveLabel after an earlier scan', () => {
	it('reads the last label in the text', async () => {
		const a = api([[row]]);
		await resolveLabel(a, 'D1 SAMPLE\nOLD-1 | 11111111\nD1 SAMPLE\nS-0123 | 1a2b3c4d');
		expect(a.calls[0].filter).toEqual({ short_id: { _eq: '1a2b3c4d' } });
	});
});

describe('isScanComplete', () => {
	it('needs the code line to be followed by a line break', () => {
		expect(isScanComplete('D1 SAMPLE')).toBe(false);
		expect(isScanComplete('D1 SAMPLE\r')).toBe(false);
		expect(isScanComplete('D1 SAMPLE\rS-1 | 1a2b3c4d')).toBe(false);
		expect(isScanComplete('D1 SAMPLE\rS-1 | 1a2b3c4d\r')).toBe(true);
		expect(isScanComplete('D1 SAMPLE\nS-1 | 1a2b3c4d\nTi-6Al-4V')).toBe(true);
	});
	it('counts from the last header and ignores other text', () => {
		expect(isScanComplete('D1 SAMPLE\nA-1 | 11111111\nD1 SAMPLE\nS-1 | 1a2b3c4d')).toBe(false);
		expect(isScanComplete('S-0123')).toBe(false);
	});
});

describe('flattenLines', () => {
	it('turns line breaks into single spaces', () => {
		expect(flattenLines('S-0123\r\n  nickname\n\nend')).toBe('S-0123 nickname end');
		expect(flattenLines('one line')).toBe('one line');
	});
});

describe('displayText and bidi controls', () => {
	it('shows direction overrides and isolates visibly', () => {
		expect(displayText('abc\u202edef\u2066x\u2069')).toBe('abc\\u202edef\\u2066x\\u2069');
		expect(displayText('a\u200fb')).toBe('a\\u200fb');
	});
});
