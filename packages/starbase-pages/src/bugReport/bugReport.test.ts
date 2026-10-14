import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_LINE, MAX_LINES, argText, clearCapture, getConsoleTail, record, safeLocation } from './capture';
import { issueLink, submitReport, type ReportInput } from './report';
import { AREAS, PAGES, collectionOptions, scopeOptions, suggestFromRoute } from './scopes';

afterEach(() => clearCapture());

describe('console capture', () => {
	it('writes one timestamped line per record, newest last', () => {
		record('WARN', ['a', { b: 1 }], new Date('2026-10-14T10:00:00Z'));
		record('ERROR', [new Error('boom')], new Date('2026-10-14T10:00:01Z'));
		const lines = getConsoleTail().split('\n');
		expect(lines[0]).toBe('2026-10-14T10:00:00.000Z WARN a {"b":1}');
		expect(lines[1]).toMatch(/^2026-10-14T10:00:01\.000Z ERROR Error: boom/);
	});
	it('keeps only the newest MAX_LINES and cuts a long line', () => {
		for (let i = 0; i < MAX_LINES + 5; i++) record('WARN', [`line ${i}`]);
		const lines = getConsoleTail().split('\n');
		expect(lines).toHaveLength(MAX_LINES);
		expect(lines[lines.length - 1]).toContain(`line ${MAX_LINES + 4}`);
		clearCapture();
		record('WARN', ['x'.repeat(MAX_LINE * 3)]);
		expect(getConsoleTail().length).toBeLessThan(MAX_LINE + 40);
	});
	it('turns unserialisable values into text instead of throwing', () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => argText(cyclic)).not.toThrow();
		expect(argText(undefined)).toBe('undefined');
		expect(argText(7)).toBe('7');
	});
	it('drops the query and hash from the page address', () => {
		expect(safeLocation({ origin: 'https://s.example', pathname: '/samples/1' })).toBe('https://s.example/samples/1');
	});
});

describe('submitReport', () => {
	const input: ReportInput = { kind: 'bug', area: 'general', scope: '', title: '  Broken  ', description: 'It broke', route: '/samples' };
	const api = (post: (path: string, body?: unknown) => Promise<{ data: unknown }>) => ({ post, get: vi.fn(), patch: vi.fn(), delete: vi.fn() }) as never;

	it('posts to the endpoint with a trimmed title and no diagnostics unless given', async () => {
		const post = vi.fn(async (_path: string, _body?: unknown) => ({ data: { ok: true, url: 'https://gh/1', number: 1 } }));
		const r = await submitReport(api(post), input);
		expect(r).toEqual({ ok: true, url: 'https://gh/1', number: 1 });
		const [path, body] = post.mock.calls[0]!;
		expect(path).toBe('/d1-bug-report/report');
		expect(body).toEqual({ title: 'Broken', description: 'It broke', kind: 'bug', area: 'general', scope: '', route: '/samples' });
	});
	it('sends diagnostics and the console tail when given', async () => {
		const post = vi.fn(async (_path: string, _body?: unknown) => ({ data: { ok: true } }));
		await submitReport(api(post), { ...input, diagnostics: 'Browser: X', consoleTail: 'ERROR y' });
		const body = post.mock.calls[0]![1] as Record<string, unknown>;
		expect(body.diagnostics).toBe('Browser: X');
		expect(body.consoleTail).toBe('ERROR y');
	});
	it('returns the endpoint reason when it refuses', async () => {
		const r = await submitReport(api(async () => ({ data: { ok: false, reason: 'could not reach the bug-report relay: ECONNREFUSED' } })), input);
		expect(r).toEqual({ ok: false, reason: 'could not reach the bug-report relay: ECONNREFUSED' });
	});
	it('falls back to a plain message for an empty refusal', async () => {
		const r = await submitReport(api(async () => ({ data: { ok: false } })), input);
		expect(r).toEqual({ ok: false, reason: 'The report could not be filed.' });
	});
	it('turns a failed request into a reason, never a throw', async () => {
		const expired = await submitReport(api(async () => Promise.reject({ response: { data: { error: 'authentication required' } } })), input);
		expect(expired).toEqual({ ok: false, reason: 'authentication required' });
		const offline = await submitReport(api(async () => Promise.reject(new Error('Network Error'))), input);
		expect(offline).toEqual({ ok: false, reason: 'The report could not be filed.' });
	});
	it('offers only an https address as a link', () => {
		expect(issueLink('https://github.com/o/r/issues/4')).toBe('https://github.com/o/r/issues/4');
		expect(issueLink('javascript:alert(1)')).toBeNull();
		expect(issueLink('')).toBeNull();
	});
});

describe('scopes', () => {
	it('lists a page set for every area but records and general', () => {
		expect(AREAS.map((a) => a.value)).toEqual(['data-entry', 'dashboards', 'reports', 'access', 'general']);
		expect(Object.keys(PAGES).sort()).toEqual(['access', 'dashboards', 'reports']);
		expect(scopeOptions('general')).toEqual([]);
	});
	it('offers every list page as a record scope, by collection', () => {
		expect(scopeOptions('data-entry')).toEqual(collectionOptions());
		expect(collectionOptions().find((o) => o.value === 'physical_samples')?.label).toBe('Samples');
	});
	it('guesses where the reporter was from the route they came from', () => {
		expect(suggestFromRoute('/')).toEqual({ area: 'dashboards', scope: 'home' });
		expect(suggestFromRoute('/plot/force?operation=9')).toEqual({ area: 'dashboards', scope: 'force-plot' });
		expect(suggestFromRoute('/plot/fast')).toEqual({ area: 'dashboards', scope: 'fast-plot' });
		expect(suggestFromRoute('/crawler')).toEqual({ area: 'dashboards', scope: 'force-crawler' });
		expect(suggestFromRoute('/labels?ids=1')).toEqual({ area: 'reports', scope: 'print-labels' });
		expect(suggestFromRoute('/samples/abc')).toEqual({ area: 'data-entry', scope: 'physical_samples' });
		expect(suggestFromRoute('/operations')).toEqual({ area: 'data-entry', scope: 'manufacturing_operations' });
		expect(suggestFromRoute('unknown')).toBeNull();
		expect(suggestFromRoute('/settings')).toBeNull();
	});
});
