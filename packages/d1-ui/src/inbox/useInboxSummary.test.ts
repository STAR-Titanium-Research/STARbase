import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import type { ExplorerHost } from '../host';
import { FOCUS_MIN_MS, POLL_MS, useInboxSummary } from './useInboxSummary';

const host = (get: (path: string) => Promise<{ data: any }>): ExplorerHost => ({ api: { get: vi.fn(get), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }) as unknown as ExplorerHost;
const body = { person: { new: 3, older_matches: 1, has_alias: true }, teams: [] };
const refused = (status: number) => Object.assign(new Error('x'), { response: { status, data: { errors: [{ message: 'no' }] } } });

// The hook's lifetime is its effect scope (a component's setup scope in the app). No DOM is needed: window and document are small stand-ins.
function fakeTarget(extra: Record<string, unknown> = {}) {
	const listeners = new Map<string, Set<() => void>>();
	const set = (t: string) => listeners.get(t) ?? listeners.set(t, new Set()).get(t)!;
	return {
		...extra,
		addEventListener: (t: string, f: () => void) => void set(t).add(f),
		removeEventListener: (t: string, f: () => void) => void listeners.get(t)?.delete(f),
		fire: (t: string) => listeners.get(t)?.forEach((f) => f()),
		count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
	};
}
let win: ReturnType<typeof fakeTarget>;
let doc: ReturnType<typeof fakeTarget> & { hidden: boolean };

function mount(h0: ExplorerHost) {
	const scope = effectScope();
	const state = scope.run(() => useInboxSummary(h0))!;
	return { state, unmount: () => scope.stop() };
}

beforeEach(() => {
	vi.useFakeTimers();
	win = fakeTarget();
	doc = fakeTarget({ hidden: false }) as typeof doc;
	vi.stubGlobal('window', win);
	vi.stubGlobal('document', doc);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('useInboxSummary', () => {
	it('reads once on mount and exposes the counts', async () => {
		const h0 = host(async () => ({ data: body }));
		const { state, unmount } = mount(h0);
		await vi.advanceTimersByTimeAsync(0);
		expect(h0.api.get).toHaveBeenCalledTimes(1);
		expect(h0.api.get).toHaveBeenCalledWith('/d1-inbox/summary', expect.anything());
		expect(state.newCount.value).toBe(3);
		expect(state.olderMatches.value).toBe(1);
		expect(state.absent.value).toBe(false);
		unmount();
	});
	it('polls calmly, and not while the tab is hidden', async () => {
		const h0 = host(async () => ({ data: body }));
		const { unmount } = mount(h0);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(h0.api.get).toHaveBeenCalledTimes(2);
		doc.hidden = true;
		await vi.advanceTimersByTimeAsync(POLL_MS * 2);
		expect(h0.api.get).toHaveBeenCalledTimes(2);
		doc.hidden = false;
		unmount();
	});
	it('reads again when the window gets focus, but not more than once every 30 s', async () => {
		const h0 = host(async () => ({ data: body }));
		const { unmount } = mount(h0);
		await vi.advanceTimersByTimeAsync(0);
		win.fire('focus');
		await vi.advanceTimersByTimeAsync(0);
		expect(h0.api.get).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(FOCUS_MIN_MS);
		win.fire('focus');
		await vi.advanceTimersByTimeAsync(0);
		expect(h0.api.get).toHaveBeenCalledTimes(2);
		unmount();
	});
	it('stops with the last component and lets go of the window', async () => {
		const h0 = host(async () => ({ data: body }));
		const { unmount } = mount(h0);
		await vi.advanceTimersByTimeAsync(0);
		expect(win.count() + doc.count()).toBe(2);
		unmount();
		await vi.advanceTimersByTimeAsync(POLL_MS * 3);
		expect(h0.api.get).toHaveBeenCalledTimes(1);
		expect(win.count() + doc.count()).toBe(0);
	});
	it('a server with no d1-inbox (404) takes the Inbox away without an error, for good: it stops asking', async () => {
		const h0 = host(async () => { throw refused(404); });
		const { state, unmount } = mount(h0);
		await vi.advanceTimersByTimeAsync(0);
		expect(state.absent.value).toBe(true);
		expect(state.error.value).toBe('');
		await vi.advanceTimersByTimeAsync(POLL_MS * 2);
		win.fire('focus');
		await state.refresh();
		expect(h0.api.get).toHaveBeenCalledTimes(1);
		unmount();
	});
	it('a refusal (401 or 403) hides the Inbox but is not final: the next poll or focus asks again and shows it when it works', async () => {
		for (const status of [403, 401]) {
			let refusing = true;
			const h0 = host(async () => { if (refusing) throw refused(status); return { data: body }; });
			const { state, unmount } = mount(h0);
			await vi.advanceTimersByTimeAsync(0);
			expect(state.absent.value).toBe(true);
			expect(state.error.value).toBe('');
			refusing = false;
			await vi.advanceTimersByTimeAsync(POLL_MS);
			expect(h0.api.get).toHaveBeenCalledTimes(2);
			expect(state.absent.value).toBe(false);
			expect(state.newCount.value).toBe(3);
			unmount();
		}
	});
	it('another failure keeps the last numbers and keeps the Inbox', async () => {
		let fail = false;
		const h0 = host(async () => { if (fail) throw refused(500); return { data: body }; });
		const { state, unmount } = mount(h0);
		await vi.advanceTimersByTimeAsync(0);
		fail = true;
		await state.refresh();
		expect(state.absent.value).toBe(false);
		expect(state.newCount.value).toBe(3);
		expect(state.error.value).toBe('no');
		unmount();
	});
	it('a refresh asked while a read is in flight reads once more when it settles (the first may have started before the write)', async () => {
		let n = 0;
		let release: Array<() => void> = [];
		const h0 = host(() => new Promise((resolve) => { n += 1; const mine = n; release.push(() => resolve({ data: { person: { new: mine, older_matches: 0 }, teams: [] } })); }));
		const { state, unmount } = mount(h0);
		await vi.advanceTimersByTimeAsync(0);
		expect(n).toBe(1);
		// two asks during the read share ONE more read
		const a = state.refresh();
		const b = state.refresh();
		release.splice(0).forEach((r) => r());
		await vi.advanceTimersByTimeAsync(0);
		expect(n).toBe(2);
		release.splice(0).forEach((r) => r());
		await Promise.all([a, b]);
		expect(n).toBe(2);
		expect(state.newCount.value).toBe(2);
		unmount();
	});
	it('a refresh with nothing in flight is one read', async () => {
		let n = 0;
		const h0 = host(async () => { n += 1; return { data: body }; });
		const { state, unmount } = mount(h0);
		await vi.advanceTimersByTimeAsync(0);
		await state.refresh();
		expect(n).toBe(2);
		unmount();
	});
});
