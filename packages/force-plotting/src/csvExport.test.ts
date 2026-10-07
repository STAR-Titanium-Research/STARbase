import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText, toCsv, safeFilePart, useCopyFeedback, type CsvColumn } from './csvExport';

interface R { a: string | number | null | undefined; b?: number }
const cols: CsvColumn<R>[] = [
	{ header: 'a_N', value: (r) => r.a },
	{ header: 'b_mm', value: (r) => r.b },
];

describe('toCsv', () => {
	it('writes headers in column order, CRLF-terminated', () => {
		expect(toCsv(cols, [{ a: 1, b: 2 }, { a: 3, b: 4 }])).toBe('a_N,b_mm\r\n1,2\r\n3,4\r\n');
	});
	it('emits only the header for no rows', () => {
		expect(toCsv(cols, [])).toBe('a_N,b_mm\r\n');
	});
	it('quotes commas, quotes and newlines (RFC 4180)', () => {
		const csv = toCsv(cols, [{ a: 'x,y' }, { a: 'say "hi"' }, { a: 'l1\nl2' }, { a: 'cr\rx' }]);
		expect(csv).toBe('a_N,b_mm\r\n"x,y",\r\n"say ""hi""",\r\n"l1\nl2",\r\n"cr\rx",\r\n');
	});
	it('exports NaN, infinities, null and undefined as empty cells but keeps 0', () => {
		const csv = toCsv(cols, [{ a: NaN, b: Infinity }, { a: null, b: undefined }, { a: 0, b: -0.5 }]);
		expect(csv).toBe('a_N,b_mm\r\n,\r\n,\r\n0,-0.5\r\n');
	});
	it('quotes header cells too', () => {
		expect(toCsv([{ header: 'a,b', value: () => 1 }], [{ a: 1 }])).toBe('"a,b"\r\n1\r\n');
	});
});

describe('safeFilePart', () => {
	it('replaces unsafe runs and trims', () => {
		expect(safeFilePart(' Op/12 A ')).toBe('Op_12_A');
		expect(safeFilePart(null)).toBe('');
	});
});

describe('copyText fallback', () => {
	afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
	function fakeDoc(execResult: boolean | 'throw') {
		const ta: any = { value: '', style: {}, setAttribute: () => {}, focus: vi.fn(), select: vi.fn(), remove: vi.fn() };
		const button = { focus: vi.fn() };
		const doc = {
			activeElement: button,
			createElement: vi.fn(() => ta),
			body: { appendChild: vi.fn() },
			execCommand: vi.fn(() => { if (execResult === 'throw') throw new Error('no'); return execResult; }),
		};
		vi.stubGlobal('document', doc);
		return { ta, doc, button };
	}

	it('uses navigator.clipboard when it exists', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText } });
		expect(await copyText('x')).toBe(true);
		expect(writeText).toHaveBeenCalledWith('x');
	});

	it('falls back to execCommand when navigator.clipboard is undefined (http host)', async () => {
		vi.stubGlobal('navigator', {});
		const { ta, doc, button } = fakeDoc(true);
		expect(await copyText('a,b')).toBe(true);
		expect(ta.value).toBe('a,b');
		expect(doc.execCommand).toHaveBeenCalledWith('copy');
		expect(ta.remove).toHaveBeenCalled();
		expect(button.focus).toHaveBeenCalled();   // focus handed back, not left on <body>
	});

	it('falls back when the async API rejects', async () => {
		vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
		const { doc } = fakeDoc(true);
		expect(await copyText('x')).toBe(true);
		expect(doc.execCommand).toHaveBeenCalled();
	});

	it('is false when both routes fail', async () => {
		vi.stubGlobal('navigator', {});
		fakeDoc(false);
		expect(await copyText('x')).toBe(false);
		fakeDoc('throw');
		expect(await copyText('x')).toBe(false);
	});

	it('useCopyFeedback flags copied on success and failed when both routes fail, then resets', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('navigator', {});
		fakeDoc(false);
		const f = useCopyFeedback(() => 'data');
		await f.copy();
		expect(f.failed.value).toBe(true); expect(f.copied.value).toBe(false);
		vi.advanceTimersByTime(1600);
		expect(f.failed.value).toBe(false);
		fakeDoc(true);
		await f.copy();
		expect(f.copied.value).toBe(true); expect(f.failed.value).toBe(false);
	});
});
