import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { setExplorerHostFactory, type ExplorerHost } from '../host';
import type { PinRef } from './sidebarModel';
import { DEFAULT_PREFS, __resetPinsForTests, usePins } from './usePins';

const S1 = '11111111-aaaa-4aaa-8aaa-000000000001';
const S2 = '22222222-aaaa-4aaa-8aaa-000000000002';
const P1 = '33333333-aaaa-4aaa-8aaa-000000000003';

type Handler = (path: string, arg?: any) => any;

// A host whose get and post answer through the given handlers; a handler may return a promise,
// throw, or return a rejected promise (use reject()).
function makeHost(get: Handler, post: Handler = () => ({ data: {} })) {
	const gets: Array<{ path: string; config?: any }> = [];
	const posts: Array<{ path: string; body?: any }> = [];
	const host: ExplorerHost = {
		api: {
			get: vi.fn(async (path: string, config?: any) => { gets.push({ path, config }); return get(path, config); }),
			post: vi.fn(async (path: string, body?: any) => { posts.push({ path, body }); return post(path, body); }),
			patch: async () => ({ data: {} }),
			delete: async () => ({ data: {} }),
		},
		navigate: () => {},
		openDataStudio: () => {},
		fieldsFor: async () => [],
		isAdmin: ref(false),
		adminKnown: ref(true),
		user: ref(null),
	};
	setExplorerHostFactory(() => host);
	return { host, gets, posts };
}

const fail = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });
const nav = (pins: Array<{ kind: string; target: string }>, prefs: Record<string, unknown> = {}) => ({ data: { pins, prefs } });
const SAMPLES: PinRef = { kind: 'page', target: 'samples' };
const PROJECTS: PinRef = { kind: 'page', target: 'projects' };

describe('usePins', () => {
	beforeEach(() => __resetPinsForTests());
	afterEach(() => {
		setExplorerHostFactory(null);
		vi.useRealTimers();
	});

	it('loads pins and prefs from /d1-usage/nav, filling missing prefs from DEFAULT_PREFS', async () => {
		const { gets } = makeHost(() => nav([SAMPLES, PROJECTS], { theme: 'dark' }));
		const s = usePins();
		expect(s.loaded.value).toBe(false);
		await s.refresh();
		expect(gets.map((g) => g.path)).toEqual(['/d1-usage/nav']);
		expect(s.pins.value).toEqual([SAMPLES, PROJECTS]);
		expect(s.prefs.value).toEqual({ ...DEFAULT_PREFS, theme: 'dark' });
		expect(s.loaded.value).toBe(true);
		expect(s.loadFailed.value).toBe(false);
		expect(s.isPinned({ kind: 'page', target: 'samples' })).toBe(true);
		expect(s.isPinned({ kind: 'view', target: 'samples' })).toBe(false);
	});

	it('ignores a stored pref of the wrong type', async () => {
		makeHost(() => nav([], { theme: 'purple', autoCollapse: 'yes', sidebarCollapsed: true }));
		const s = usePins();
		await s.refresh();
		expect(s.prefs.value).toEqual({ sidebarCollapsed: true, autoCollapse: true, theme: 'system' });
	});

	it('loads record codes for record pins, one request per collection, keyed by target', async () => {
		const pins = [
			{ kind: 'record', target: `physical_samples:${S1}` },
			{ kind: 'record', target: `physical_samples:${S2}` },
			{ kind: 'record', target: `projects:${P1}` },
			SAMPLES,
		];
		const { gets } = makeHost((path) => {
			if (path === '/d1-usage/nav') return nav(pins);
			if (path === '/items/physical_samples') return { data: { data: [{ sample_id: S1, sample_code: 'S-1' }, { sample_id: S2, sample_code: 'S-2' }] } };
			if (path === '/items/projects') return { data: { data: [{ project_id: P1, project_code: 'P-1' }] } };
			throw fail(404);
		});
		const s = usePins();
		await s.refresh();
		const itemGets = gets.filter((g) => g.path.startsWith('/items/'));
		expect(itemGets.map((g) => g.path).sort()).toEqual(['/items/physical_samples', '/items/projects']);
		expect(JSON.parse(itemGets.find((g) => g.path === '/items/physical_samples')!.config.params.filter)).toEqual({ sample_id: { _in: [S1, S2] } });
		expect(s.records.value.get(`physical_samples:${S1}`)).toEqual({ code: 'S-1', to: `/home/samples/${S1}` });
		expect(s.records.value.get(`physical_samples:${S2}`)?.code).toBe('S-2');
		expect(s.records.value.get(`projects:${P1}`)?.code).toBe('P-1');
		expect(s.pins.value).toHaveLength(4);
	});

	it('a record pin that 403s is unavailable (absent from records) and the other pins still load', async () => {
		const pins = [SAMPLES, { kind: 'record', target: `projects:${P1}` }, { kind: 'record', target: `physical_samples:${S1}` }];
		makeHost((path) => {
			if (path === '/d1-usage/nav') return nav(pins);
			if (path === '/items/projects') throw fail(403);
			return { data: { data: [{ sample_id: S1, sample_code: 'S-1' }] } };
		});
		const s = usePins();
		await s.refresh();
		expect(s.loadFailed.value).toBe(false);
		expect(s.loaded.value).toBe(true);
		expect(s.pins.value).toEqual(pins);
		expect(s.records.value.has(`projects:${P1}`)).toBe(false);
		expect(s.records.value.get(`physical_samples:${S1}`)?.code).toBe('S-1');
	});

	it('load failure sets loadFailed with no pins, and refresh() retries', async () => {
		let ok = false;
		const { gets } = makeHost(() => { if (!ok) throw fail(500); return nav([SAMPLES]); });
		const s = usePins();
		await s.refresh();
		expect(s.loadFailed.value).toBe(true);
		expect(s.pins.value).toEqual([]);
		expect(s.loaded.value).toBe(false);
		ok = true;
		await s.refresh();
		expect(gets).toHaveLength(2);
		expect(s.loadFailed.value).toBe(false);
		expect(s.loaded.value).toBe(true);
		expect(s.pins.value).toEqual([SAMPLES]);
	});

	it('two calls share one state and one GET', async () => {
		const { gets } = makeHost(() => nav([SAMPLES]));
		const a = usePins();
		const b = usePins();
		expect(b).toBe(a);
		await Promise.all([a.refresh(), b.refresh()]);
		expect(gets).toHaveLength(1);
		expect(b.pins.value).toEqual([SAMPLES]);
	});

	it('keeps separate state for separate hosts', async () => {
		makeHost(() => nav([SAMPLES]));
		const a = usePins();
		await a.refresh();
		makeHost(() => nav([PROJECTS]));
		const b = usePins();
		await b.refresh();
		expect(b).not.toBe(a);
		expect(a.pins.value).toEqual([SAMPLES]);
		expect(b.pins.value).toEqual([PROJECTS]);
	});

	describe('toggle', () => {
		it('is optimistic and posts /d1-usage/pin (pin goes last, unpin closes the gap)', async () => {
			let release!: () => void;
			const gate = new Promise<void>((r) => { release = r; });
			const { posts } = makeHost(() => nav([SAMPLES, PROJECTS]), async () => { await gate; return { data: {} }; });
			const s = usePins();
			await s.refresh();
			const tools = { kind: 'page', target: 'tools' } as const;
			const pending = s.toggle(tools);
			expect(s.pins.value).toEqual([SAMPLES, PROJECTS, tools]);
			expect(s.isPinned(tools)).toBe(true);
			expect(posts).toEqual([{ path: '/d1-usage/pin', body: { kind: 'page', target: 'tools', pinned: true } }]);
			release();
			await pending;
			expect(s.notice.value).toBeNull();
			await s.toggle({ kind: 'page', target: 'samples' });
			expect(s.pins.value).toEqual([PROJECTS, tools]);
			expect(posts[1]).toEqual({ path: '/d1-usage/pin', body: { kind: 'page', target: 'samples', pinned: false } });
		});

		it('rolls back and says so when the post rejects', async () => {
			makeHost(() => nav([SAMPLES, PROJECTS]), () => { throw fail(500); });
			const s = usePins();
			await s.refresh();
			await s.toggle({ kind: 'page', target: 'tools' });
			expect(s.pins.value).toEqual([SAMPLES, PROJECTS]);
			expect(s.notice.value).toBe("Couldn't save your pins. Try again.");
			await s.toggle({ kind: 'page', target: 'samples' });
			expect(s.pins.value).toEqual([SAMPLES, PROJECTS]);
		});

		it('a rolled back unpin goes back where it was', async () => {
			makeHost(() => nav([SAMPLES, PROJECTS, { kind: 'page', target: 'tools' }]), () => { throw fail(500); });
			const s = usePins();
			await s.refresh();
			await s.toggle({ kind: 'page', target: 'projects' });
			expect(s.pins.value.map((p) => p.target)).toEqual(['samples', 'projects', 'tools']);
		});

		it('fetches the code of a record pinned now, but not one it already has', async () => {
			const { gets, posts } = makeHost((path) => {
				if (path === '/d1-usage/nav') return nav([]);
				return { data: { data: [{ sample_id: S1, sample_code: 'S-1' }] } };
			});
			const s = usePins();
			await s.refresh();
			const rec = { kind: 'record', target: `physical_samples:${S1}` } as const;
			await s.toggle(rec);
			await vi.waitFor(() => expect(s.records.value.get(rec.target)?.code).toBe('S-1'));
			expect(posts[0].body).toEqual({ kind: 'record', target: rec.target, pinned: true });
			const itemGets = () => gets.filter((g) => g.path.startsWith('/items/')).length;
			expect(itemGets()).toBe(1);
			await s.toggle(rec); // unpin
			await s.toggle(rec); // pin again: the code is still known
			expect(itemGets()).toBe(1);
		});

		it('clears the notice after 6 seconds', async () => {
			makeHost(() => nav([SAMPLES]), () => { throw fail(500); });
			const s = usePins();
			await s.refresh();
			vi.useFakeTimers();
			await s.toggle({ kind: 'page', target: 'tools' });
			expect(s.notice.value).not.toBeNull();
			vi.advanceTimersByTime(5900);
			expect(s.notice.value).not.toBeNull();
			vi.advanceTimersByTime(200);
			expect(s.notice.value).toBeNull();
		});
	});

	it('sends writes one at a time, in the order they were made', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		let first = true;
		const { posts } = makeHost(() => nav([SAMPLES, PROJECTS]), async () => {
			if (first) { first = false; await gate; }
			return { data: {} };
		});
		const s = usePins();
		await s.refresh();
		const a = s.toggle({ kind: 'page', target: 'tools' });
		const b = s.reorder([PROJECTS, SAMPLES, { kind: 'page', target: 'tools' }]);
		await Promise.resolve();
		expect(posts.map((p) => p.path)).toEqual(['/d1-usage/pin']);
		release();
		await Promise.all([a, b]);
		expect(posts.map((p) => p.path)).toEqual(['/d1-usage/pin', '/d1-usage/pin-order']);
	});

	describe('reorder', () => {
		it('posts /d1-usage/pin-order with the new order', async () => {
			const { posts } = makeHost(() => nav([SAMPLES, PROJECTS]));
			const s = usePins();
			await s.refresh();
			await s.reorder([PROJECTS, SAMPLES]);
			expect(s.pins.value).toEqual([PROJECTS, SAMPLES]);
			expect(posts).toEqual([{ path: '/d1-usage/pin-order', body: { items: [PROJECTS, SAMPLES] } }]);
			expect(s.notice.value).toBeNull();
		});

		it('on 409 it refetches the server list and shows no notice', async () => {
			let serverPins = [SAMPLES, PROJECTS];
			const { gets } = makeHost(() => nav(serverPins), () => { serverPins = [PROJECTS, SAMPLES, { kind: 'page', target: 'tools' }]; throw fail(409); });
			const s = usePins();
			await s.refresh();
			await s.reorder([PROJECTS, SAMPLES]);
			expect(gets.filter((g) => g.path === '/d1-usage/nav')).toHaveLength(2);
			expect(s.pins.value.map((p) => p.target)).toEqual(['projects', 'samples', 'tools']);
			expect(s.notice.value).toBeNull();
		});

		it('on another failure it restores the old order and says so', async () => {
			makeHost(() => nav([SAMPLES, PROJECTS]), () => { throw fail(500); });
			const s = usePins();
			await s.refresh();
			await s.reorder([PROJECTS, SAMPLES]);
			expect(s.pins.value).toEqual([SAMPLES, PROJECTS]);
			expect(s.notice.value).toBe("Couldn't save your pins. Try again.");
		});
	});

	describe('setPref', () => {
		it('posts only that key and keeps the new value', async () => {
			const { posts } = makeHost(() => nav([]));
			const s = usePins();
			await s.refresh();
			await s.setPref('theme', 'dark');
			expect(posts).toEqual([{ path: '/d1-usage/prefs', body: { theme: 'dark' } }]);
			expect(s.prefs.value).toEqual({ ...DEFAULT_PREFS, theme: 'dark' });
		});

		it('is optimistic', async () => {
			let release!: () => void;
			const gate = new Promise<void>((r) => { release = r; });
			makeHost(() => nav([]), async () => { await gate; return { data: {} }; });
			const s = usePins();
			await s.refresh();
			const pending = s.setPref('sidebarCollapsed', true);
			expect(s.prefs.value.sidebarCollapsed).toBe(true);
			release();
			await pending;
		});

		it('on failure the old value comes back and a notice is shown', async () => {
			makeHost(() => nav([], { autoCollapse: false }), () => { throw fail(400); });
			const s = usePins();
			await s.refresh();
			await s.setPref('autoCollapse', true);
			expect(s.prefs.value.autoCollapse).toBe(false);
			expect(s.notice.value).toBe("Couldn't save. Try again.");
		});
	});

	describe('resetPins', () => {
		it('posts /d1-usage/pins/reset, then refreshes', async () => {
			let serverPins = [{ kind: 'page', target: 'tools' }];
			const { posts, gets } = makeHost(() => nav(serverPins), () => { serverPins = [SAMPLES, PROJECTS]; return { data: {} }; });
			const s = usePins();
			await s.refresh();
			expect(s.pins.value).toEqual([{ kind: 'page', target: 'tools' }]);
			await s.resetPins();
			expect(posts).toEqual([{ path: '/d1-usage/pins/reset', body: undefined }]);
			expect(gets.filter((g) => g.path === '/d1-usage/nav')).toHaveLength(2);
			expect(s.pins.value).toEqual([SAMPLES, PROJECTS]);
		});

		it('says so when the reset fails', async () => {
			makeHost(() => nav([SAMPLES]), () => { throw fail(500); });
			const s = usePins();
			await s.refresh();
			await s.resetPins();
			expect(s.pins.value).toEqual([SAMPLES]);
			expect(s.notice.value).toBe("Couldn't save your pins. Try again.");
		});
	});
});
