import { describe, expect, it } from 'vitest';
import type { HostApi } from '@d1/ui';
import { createMyDrafts, draftPath, parseDrafts, SHOWN } from './useMyDrafts';

const row = (id: string, updated_at = '2026-10-14T10:00:00Z', over: Record<string, unknown> = {}) => ({ id, name: `Draft ${id}`, updated_at, summary: '2 operations, 4 samples', ...over });
const fail = (status?: number, message = 'boom') => Object.assign(new Error(message), status ? { response: { status, data: {} } } : {});
const apiOf = (get: HostApi['get']): HostApi => ({ get, post: async () => ({ data: {} }), patch: async () => ({ data: {} }), delete: async () => ({ data: {} }) });

describe('draftPath', () => {
	it('opens the draft in edit mode on the map', () => {
		expect(draftPath('abc-123')).toBe('/map?edit=abc-123');
		expect(draftPath('a b')).toBe('/map?edit=a%20b');
	});
});

describe('parseDrafts', () => {
	it('reads the data array, newest first', () => {
		const list = parseDrafts({ data: [row('a', '2026-10-12T00:00:00Z'), row('b', '2026-10-14T00:00:00Z'), row('c', '2026-10-13T00:00:00Z')] });
		expect(list.map((d) => d.id)).toEqual(['b', 'c', 'a']);
	});
	it('drops rows without an id and fills missing fields', () => {
		const list = parseDrafts({ data: [{ name: 'no id' }, null, 5, { id: 'x' }, { id: 'y', name: '  ' }] });
		expect(list).toEqual([
			{ id: 'x', name: 'Untitled draft', updated_at: '', summary: '' },
			{ id: 'y', name: 'Untitled draft', updated_at: '', summary: '' },
		]);
	});
	it('is empty for anything else', () => {
		expect(parseDrafts(null)).toEqual([]);
		expect(parseDrafts({})).toEqual([]);
		expect(parseDrafts({ data: 'nope' })).toEqual([]);
	});
});

describe('createMyDrafts', () => {
	it('reads GET /d1-build/drafts and shows the block', async () => {
		const paths: string[] = [];
		const s = createMyDrafts(apiOf(async (p) => { paths.push(p); return { data: { data: [row('a')] } }; }));
		expect(s.visible.value).toBe(false); // nothing yet: no empty box while loading
		await s.load();
		expect(paths).toEqual(['/d1-build/drafts']);
		expect(s.drafts.value).toHaveLength(1);
		expect(s.visible.value).toBe(true);
		expect(s.loading.value).toBe(false);
	});

	it('is hidden when there are no drafts', async () => {
		const s = createMyDrafts(apiOf(async () => ({ data: { data: [] } })));
		await s.load();
		expect(s.visible.value).toBe(false);
		expect(s.error.value).toBe('');
	});

	it('is hidden when the endpoint 404s (no d1-build on this server yet) or refuses (403)', async () => {
		for (const status of [404, 403]) {
			const s = createMyDrafts(apiOf(async () => { throw fail(status); }));
			await s.load();
			expect(s.absent.value).toBe(true);
			expect(s.visible.value).toBe(false);
			expect(s.error.value).toBe('');
		}
	});

	it('says so, on its own, when the read fails otherwise', async () => {
		const s = createMyDrafts(apiOf(async () => { throw fail(500, 'database is down'); }));
		await s.load();
		expect(s.visible.value).toBe(true);
		expect(s.error.value).toContain('Could not read your drafts');
		expect(s.error.value).toContain('database is down');
		expect(s.drafts.value).toEqual([]);
	});

	it('a failed reload keeps the drafts it had, with the reason', async () => {
		let n = 0;
		const s = createMyDrafts(apiOf(async () => { if (n++ === 0) return { data: { data: [row('a')] } }; throw fail(); }));
		await s.load();
		await s.load();
		expect(s.drafts.value).toHaveLength(1);
		expect(s.error.value).not.toBe('');
		expect(s.visible.value).toBe(true);
	});

	it('a later good read clears the error, and a 404 after drafts empties the block', async () => {
		const answers: (() => unknown)[] = [() => { throw fail(); }, () => ({ data: { data: [row('a')] } }), () => { throw fail(404); }];
		const s = createMyDrafts(apiOf(async () => answers.shift()!() as any));
		await s.load();
		expect(s.error.value).not.toBe('');
		await s.load();
		expect(s.error.value).toBe('');
		await s.load();
		expect(s.visible.value).toBe(false);
		expect(s.drafts.value).toEqual([]);
	});

	it('the latest read wins', async () => {
		const resolvers: ((v: unknown) => void)[] = [];
		const s = createMyDrafts(apiOf(() => new Promise((r) => resolvers.push(r)) as any));
		const first = s.load();
		const second = s.load();
		resolvers[1]({ data: { data: [row('new')] } });
		await second;
		resolvers[0]({ data: { data: [row('old')] } });
		await first;
		expect(s.drafts.value.map((d) => d.id)).toEqual(['new']);
	});

	it('shows the first few and counts the rest', async () => {
		const many = Array.from({ length: SHOWN + 3 }, (_, i) => row(`d${i}`, `2026-10-${String(10 + i).padStart(2, '0')}T00:00:00Z`));
		const s = createMyDrafts(apiOf(async () => ({ data: { data: many } })));
		await s.load();
		expect(s.shown.value).toHaveLength(SHOWN);
		expect(s.more.value).toBe(3);
	});
});
