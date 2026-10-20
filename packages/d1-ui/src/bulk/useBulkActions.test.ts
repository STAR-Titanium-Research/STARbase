import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import type { AccessApi } from '../access/accessApi';
import { indexDefBySlug } from '../index/indexConfig';
import { bulkEntries } from './bulkModel';
import { useBulkActions } from './useBulkActions';

const samples = indexDefBySlug('samples')!;
const entries = bulkEntries(samples);
const entry = (id: string) => entries.find((e) => e.id === id)!;
const T0 = Date.parse('2026-10-20T10:00:00Z');

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}
const flush = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

type Post = (path: string, body?: any) => Promise<{ data: any }>;
function setup(post: Post, picked = ['a', 'b', 'c'], get?: (path: string) => Promise<{ data: any }>) {
	const api = { get: vi.fn(get ?? (async () => ({ data: { data: [] } }))), post: vi.fn(post), patch: vi.fn(), delete: vi.fn() } as unknown as AccessApi & { post: ReturnType<typeof vi.fn> };
	const sel = ref(picked);
	const changed: string[][] = [];
	const scope = effectScope();
	const bulk = scope.run(() => useBulkActions({ api, def: samples, picked: sel, onChanged: (keep) => changed.push(keep), now: () => Date.now() }))!;
	return { api, bulk, changed, sel, stop: () => scope.stop() };
}

const preview = (rows: [string, string, string?][]) => ({ data: { results: rows.map(([id, status, reason]) => ({ id, code: `S-${id}`, status, reason })) } });
const applied = (rows: [string, string, string?][], undoUntil = new Date(T0 + 60_000).toISOString()) => ({
	data: { action_id: 'act-1', undo_until: undoUntil, results: rows.map(([id, outcome, reason]) => ({ id, code: `S-${id}`, outcome, reason })) },
});

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('opening the dialog', () => {
	it('previews Restrict at once, on a copy of the ticked rows', async () => {
		const t = setup(async () => preview([['a', 'ok'], ['b', 'ok'], ['c', 'skip', 'RESTRICT_ADMIN_ONLY']]));
		t.bulk.open(entry('restrict'));
		t.sel.value = ['z'];
		await flush();
		expect(t.api.post).toHaveBeenCalledWith('/d1-bulk-actions/physical_samples/preview', { kind: 'restrict', ids: ['a', 'b', 'c'], params: {} });
		expect(t.bulk.summary.value).toBe('2 can be changed. 1 will be skipped');
		expect(t.bulk.skipGroups.value).toEqual([{ reason: 'Only administrators can restrict records yet', rows: [{ id: 'c', code: 'S-c' }] }]);
		expect(t.bulk.ready.value).toBe(true);
		t.stop();
	});

	it('waits for a field value before previewing, and previews it when chosen', async () => {
		const t = setup(async () => preview([['a', 'ok']]));
		t.bulk.open(entry('field:current_status'));
		await flush();
		expect(t.api.post).not.toHaveBeenCalled();
		expect(t.bulk.ready.value).toBe(false);
		t.bulk.choose('archived');
		await flush();
		expect(t.api.post).toHaveBeenCalledWith('/d1-bulk-actions/physical_samples/preview', { kind: 'edit_field', ids: ['a', 'b', 'c'], params: { field: 'current_status', value: 'archived' } });
		expect(t.bulk.ready.value).toBe(true);
		t.stop();
	});

	it('loads the options of a link field when opened', async () => {
		const t = setup(async () => preview([]), ['a'], async () => ({ data: { data: [{ project_id: 'p1', project_code: 'P-100' }] } }));
		t.bulk.open(entry('field:project_id'));
		await flush();
		expect(t.bulk.fieldOptions.value).toEqual([{ value: 'p1', label: 'P-100' }]);
		t.stop();
	});

	it('does nothing for the print entry (the page navigates itself)', () => {
		const t = setup(async () => preview([]));
		t.bulk.open(entry('print'));
		expect(t.bulk.dialog.value).toBeNull();
		t.stop();
	});

	it('shows the endpoint message when the preview fails, and cannot apply', async () => {
		const t = setup(async () => {
			throw Object.assign(new Error('x'), { response: { data: { errors: [{ message: 'Your account can look but not change.' }] } } });
		});
		t.bulk.open(entry('restrict'));
		await flush();
		expect(t.bulk.preview.value.error).toBe('Your account can look but not change.');
		expect(t.bulk.ready.value).toBe(false);
		t.stop();
	});

	it('cannot apply when nothing would change', async () => {
		const t = setup(async () => preview([['a', 'noop'], ['b', 'skip', 'You are not the owner']]));
		t.bulk.open(entry('restrict'));
		await flush();
		expect(t.bulk.summary.value).toBe('None can be changed. 1 need no change. 1 will be skipped');
		expect(t.bulk.ready.value).toBe(false);
		t.stop();
	});
});

describe('stale previews', () => {
	it('drops the answer of an older choice', async () => {
		const first = deferred<{ data: any }>();
		const second = deferred<{ data: any }>();
		const queue = [first, second];
		const t = setup(() => queue.shift()!.promise);
		t.bulk.open(entry('field:current_status'));
		t.bulk.choose('archived');
		t.bulk.choose('consumed');
		second.resolve(preview([['a', 'ok'], ['b', 'ok']]));
		await flush();
		first.resolve(preview([['a', 'skip', 'old']]));
		await flush();
		expect(t.bulk.counts.value).toEqual({ ok: 2, noop: 0, skip: 0 });
		t.stop();
	});

	it('drops an answer that arrives after the dialog closed', async () => {
		const slow = deferred<{ data: any }>();
		const t = setup(() => slow.promise);
		t.bulk.open(entry('restrict'));
		t.bulk.close();
		slow.resolve(preview([['a', 'ok']]));
		await flush();
		expect(t.bulk.preview.value.rows).toBeNull();
		expect(t.bulk.dialog.value).toBeNull();
		t.stop();
	});
});

describe('apply', () => {
	function applyingSetup(applyAnswer: ReturnType<typeof applied>) {
		return setup(async (path) => (path.endsWith('/preview') ? preview([['a', 'ok'], ['b', 'ok'], ['c', 'skip', 'You are not the owner']]) : applyAnswer));
	}

	it('posts the same rows, closes the dialog, shows the toast and reloads keeping only the skipped rows', async () => {
		const t = applyingSetup(applied([['a', 'applied'], ['b', 'applied'], ['c', 'skipped', 'You are not the owner']]));
		t.bulk.open(entry('field:current_status'));
		t.bulk.choose('archived');
		await flush();
		await t.bulk.apply();
		expect(t.api.post).toHaveBeenLastCalledWith('/d1-bulk-actions/physical_samples/apply', { kind: 'edit_field', ids: ['a', 'b', 'c'], params: { field: 'current_status', value: 'archived' } });
		expect(t.bulk.dialog.value).toBeNull();
		expect(t.changed).toEqual([['c']]);
		expect(t.bulk.toasts.value).toHaveLength(1);
		expect(t.bulk.toasts.value[0]).toMatchObject({ actionId: 'act-1', message: 'Set status to Archived on 2 samples', phase: 'pending', left: 60 });
		expect(t.bulk.toasts.value[0].skipped).toEqual([{ id: 'c', code: 'S-c', reason: 'You are not the owner' }]);
		t.stop();
	});

	it('keeps the dialog open and says why when the apply fails', async () => {
		const t = setup(async (path) => {
			if (path.endsWith('/preview')) return preview([['a', 'ok']]);
			throw Object.assign(new Error('x'), { response: { data: { errors: [{ message: 'Something broke.' }] } } });
		});
		t.bulk.open(entry('restrict'));
		await flush();
		await t.bulk.apply();
		expect(t.bulk.dialog.value).not.toBeNull();
		expect(t.bulk.applyError.value).toBe('Something broke.');
		expect(t.bulk.toasts.value).toHaveLength(0);
		expect(t.changed).toEqual([]);
		t.stop();
	});

	it('does not apply twice at once', async () => {
		const slow = deferred<{ data: any }>();
		const t = setup(async (path) => (path.endsWith('/preview') ? preview([['a', 'ok']]) : slow.promise));
		t.bulk.open(entry('restrict'));
		await flush();
		const one = t.bulk.apply();
		void t.bulk.apply();
		slow.resolve(applied([['a', 'applied']]));
		await one;
		expect(t.api.post.mock.calls.filter((c: any[]) => String(c[0]).endsWith('/apply'))).toHaveLength(1);
		t.stop();
	});

	it('still makes the toast when the dialog was closed while the apply ran', async () => {
		const slow = deferred<{ data: any }>();
		const t = setup(async (path) => (path.endsWith('/preview') ? preview([['a', 'ok']]) : slow.promise));
		t.bulk.open(entry('restrict'));
		await flush();
		const run = t.bulk.apply();
		t.bulk.close();
		slow.resolve(applied([['a', 'applied']]));
		await run;
		expect(t.bulk.toasts.value).toHaveLength(1);
		expect(t.bulk.toasts.value[0].message).toBe('Restricted 1 sample');
		t.stop();
	});
});

describe('the toast', () => {
	async function withToast(post?: Post) {
		const t = setup(
			post ?? (async (path) => (path.endsWith('/preview') ? preview([['a', 'ok'], ['b', 'ok']]) : path.endsWith('/apply') ? applied([['a', 'applied'], ['b', 'applied']]) : { data: {} })),
			['a', 'b'],
		);
		t.bulk.open(entry('restrict'));
		await flush();
		await t.bulk.apply();
		return t;
	}

	it('counts down every second and ends as done, then goes', async () => {
		const t = await withToast();
		vi.advanceTimersByTime(10_000);
		expect(t.bulk.toasts.value[0].left).toBe(50);
		vi.advanceTimersByTime(50_000);
		expect(t.bulk.toasts.value[0]).toMatchObject({ phase: 'done', left: 0 });
		vi.advanceTimersByTime(3000);
		expect(t.bulk.toasts.value).toHaveLength(0);
		t.stop();
	});

	it('undoes: the toast says undone, the list reloads, rows not put back stay ticked', async () => {
		const t = await withToast(async (path) => {
			if (path.endsWith('/preview')) return preview([['a', 'ok'], ['b', 'ok']]);
			if (path.endsWith('/apply')) return applied([['a', 'applied'], ['b', 'applied']]);
			return { data: { state: 'partly_reverted', results: [{ id: 'a', revert_outcome: 'reverted' }, { id: 'b', revert_outcome: 'changed_since' }] } };
		});
		t.changed.length = 0;
		await t.bulk.undo('act-1');
		expect(t.api.post).toHaveBeenLastCalledWith('/d1-bulk-actions/act-1/undo');
		expect(t.bulk.toasts.value[0]).toMatchObject({ phase: 'undone', busy: false });
		expect(t.bulk.toasts.value[0].undoSkipped).toEqual([{ id: 'b', code: 'S-b', reason: 'Changed since, so it was left as it is' }]);
		expect(t.changed).toEqual([['b']]);
		// something to read: it stays until dismissed
		vi.advanceTimersByTime(20_000);
		expect(t.bulk.toasts.value).toHaveLength(1);
		t.bulk.dismiss('act-1');
		expect(t.bulk.toasts.value).toHaveLength(0);
		t.stop();
	});

	it('shows the error and stays when the undo is refused', async () => {
		const t = await withToast(async (path) => {
			if (path.endsWith('/preview')) return preview([['a', 'ok']]);
			if (path.endsWith('/apply')) return applied([['a', 'applied']]);
			throw Object.assign(new Error('x'), { response: { data: { errors: [{ message: 'The undo window has closed.' }] } } });
		});
		t.changed.length = 0;
		await t.bulk.undo('act-1');
		expect(t.bulk.toasts.value[0]).toMatchObject({ phase: 'pending', busy: false, error: 'The undo window has closed.' });
		expect(t.changed).toEqual([]);
		t.stop();
	});

	it('undoes once only while the request is out', async () => {
		const slow = deferred<{ data: any }>();
		const t = await withToast(async (path) => {
			if (path.endsWith('/preview')) return preview([['a', 'ok']]);
			if (path.endsWith('/apply')) return applied([['a', 'applied']]);
			return slow.promise;
		});
		const one = t.bulk.undo('act-1');
		void t.bulk.undo('act-1');
		slow.resolve({ data: { state: 'undone', results: [{ id: 'a', revert_outcome: 'reverted' }] } });
		await one;
		expect(t.api.post.mock.calls.filter((c: any[]) => String(c[0]).endsWith('/undo'))).toHaveLength(1);
		expect(t.bulk.toasts.value[0].phase).toBe('undone');
		// nothing left to read: it goes by itself
		vi.advanceTimersByTime(5000);
		expect(t.bulk.toasts.value).toHaveLength(0);
		t.stop();
	});

	it('stops its clock with the scope', async () => {
		const t = await withToast();
		t.stop();
		expect(vi.getTimerCount()).toBe(0);
	});
});
