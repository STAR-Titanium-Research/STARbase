import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import type { ExplorerHost } from '../host';
import { indexDefBySlug } from './indexConfig';
import { memoryRoute, nounsFor, pickText, pickedRows, rectOf, rootElement, PICK_ATTR } from './pickMode';
import { useIndexPage } from './useIndexPage';
import { usePickMode } from './usePickMode';
import { useRowSelection } from './useRowSelection';

const rect = (x: number) => ({ x, y: 0, width: 100, height: 20, top: 0, left: x, right: x + 100, bottom: 20, toJSON: () => ({}) }) as DOMRect;
const fakeRoot = (rects: Record<string, DOMRect>) => ({
	querySelector: vi.fn((selector: string) => {
		const m = selector.match(/^\[data-pick-key="(.*)"\]$/);
		const key = m ? m[1].replace(/\\(["\\])/g, '$1') : '';
		return key in rects ? { getBoundingClientRect: () => rects[key] } : null;
	}),
});

describe('texts', () => {
	it('nounsFor makes the singular of a list title', () => {
		expect(nounsFor('Samples')).toEqual({ one: 'sample', many: 'samples' });
		expect(nounsFor('Cutting inserts')).toEqual({ one: 'cutting insert', many: 'cutting inserts' });
		expect(nounsFor('Campaigns')).toEqual({ one: 'campaign', many: 'campaigns' });
		expect(nounsFor('People')).toEqual({ one: 'person', many: 'people' });
		expect(nounsFor('Raw stock lots')).toEqual({ one: 'raw stock lot', many: 'raw stock lots' });
	});
	it('pickText: Add N samples', () => {
		const n = nounsFor('Samples');
		expect(pickText(0, n)).toBe('Add samples');
		expect(pickText(1, n)).toBe('Add 1 sample');
		expect(pickText(12, n)).toBe('Add 12 samples');
	});
});

describe('rectangles', () => {
	it('rectOf reads the row with that key, null when it is not drawn', () => {
		const root = fakeRoot({ s1: rect(10) });
		expect(rectOf(root, 's1')?.x).toBe(10);
		expect(rectOf(root, 'gone')).toBeNull();
		expect(rectOf(null, 's1')).toBeNull();
	});
	it('a key with quotes cannot break the selector', () => {
		const root = fakeRoot({ 'a"b': rect(5) });
		expect(rectOf(root, 'a"b')?.x).toBe(5);
		expect(root.querySelector).toHaveBeenCalledWith(`[${PICK_ATTR}="a\\"b"]`);
	});
	it('pickedRows keeps the ticked order and names rows no longer on screen', () => {
		const root = fakeRoot({ s2: rect(20), s1: rect(10) });
		const out = pickedRows(['s2', 's9', 's1'], new Map([['s2', 'S-2'], ['s1', 'S-1']]), root);
		expect(out.map((r) => [r.id, r.code, r.rect?.x ?? null])).toEqual([['s2', 'S-2', 20], ['s9', 's9', null], ['s1', 'S-1', 10]]);
	});
	it('rootElement takes an element or a component root, and nothing on the server', () => {
		const el = fakeRoot({});
		expect(rootElement(el)).toBe(el);
		expect(rootElement({ $el: el })).toBe(el);
		expect(rootElement(null)).toBeNull();
		expect(rootElement({ $el: null })).toBeNull();
		expect(rootElement({ $el: { nodeType: 8 } })).toBeNull();
	});
});

describe('memoryRoute', () => {
	it('keeps the list state in memory and answers to the list slug', () => {
		const { route, router } = memoryRoute('samples');
		expect(route).toMatchObject({ path: '/home/samples', query: {}, params: { slug: 'samples' } });
		void router.push({ path: route.path, query: { q: 'ti' } });
		expect(route.query).toEqual({ q: 'ti' });
		void router.replace({ path: route.path, query: { page: '2' } });
		expect(route.query).toEqual({ page: '2' });
	});

	it('drives useIndexPage: a search and a page change reload with the new state, and no address changes', async () => {
		vi.useFakeTimers();
		const get = vi.fn(async (path: string, config?: { params?: Record<string, any> }) => {
			if (path === '/items/physical_samples' && !config?.params?.groupBy) return { data: { data: [{ sample_id: 's1', sample_code: 'A-1' }], meta: { filter_count: 250 } } };
			return { data: { data: [] } };
		});
		const host = { api: { get }, navigate: vi.fn(), openDataStudio: vi.fn(), isAdmin: ref(false), adminKnown: ref(true), user: ref(null) } as unknown as ExplorerHost;
		const { route, router } = memoryRoute('samples');
		const page = useIndexPage(host, indexDefBySlug('samples')!, route, router);
		const rowCalls = () => get.mock.calls.filter(([p, c]) => p === '/items/physical_samples' && !c?.params?.groupBy);
		await vi.advanceTimersByTimeAsync(10);
		expect(rowCalls()).toHaveLength(1);
		expect(page.rows.value).toHaveLength(1);

		page.setPage(2);
		await vi.advanceTimersByTimeAsync(10);
		expect(route.query).toEqual({ page: '2' });
		expect(rowCalls()).toHaveLength(2);
		expect(rowCalls()[1][1]?.params?.page).toBe(2);

		page.setSearch('ti64');
		await vi.advanceTimersByTimeAsync(400);
		expect(route.query.q).toBe('ti64');
		expect(rowCalls()).toHaveLength(3);
		vi.useRealTimers();
	});
});

describe('usePickMode', () => {
	const def = indexDefBySlug('samples')!;
	const key = (r: Record<string, unknown>) => String(r.sample_id);
	const label = (r: Record<string, unknown>) => String(r.sample_code);
	const page1 = [{ sample_id: 's1', sample_code: 'S-1' }, { sample_id: 's2', sample_code: 'S-2' }, { sample_id: 's3', sample_code: 'S-3' }];
	const page2 = [{ sample_id: 's4', sample_code: 'S-4' }];

	function setup(taken: string[] = []) {
		const rows = ref<Record<string, unknown>[]>(page1);
		const tickable = ref(rows.value);
		const picks: unknown[][] = [];
		const root = ref<unknown>(fakeRoot({ s1: rect(1), s3: rect(3) }));
		let state!: ReturnType<typeof usePickMode>;
		const sel = useRowSelection(def, tickable, key, vi.fn());
		state = usePickMode({ sel, rows, rowKey: key, rowLabel: label, root, taken: () => taken, nouns: nounsFor('Samples'), emit: (r) => picks.push(r) });
		return { rows, sel, state, picks, tickable };
	}

	it('counts the ticked rows and says so on the button', () => {
		const { sel, state } = setup();
		expect(state.text.value).toBe('Add samples');
		sel.toggle(page1[0]);
		expect(state.text.value).toBe('Add 1 sample');
		sel.toggle(page1[2]);
		expect(state.text.value).toBe('Add 2 samples');
	});

	it('confirming hands back the rows in ticked order with their rectangles, then starts over', () => {
		const { sel, state, picks } = setup();
		sel.toggle(page1[2]);
		sel.toggle(page1[0]);
		state.confirm();
		expect(picks).toHaveLength(1);
		expect((picks[0] as { id: string; code: string; rect: DOMRect }[]).map((r) => [r.id, r.code, r.rect.x])).toEqual([['s3', 'S-3', 3], ['s1', 'S-1', 1]]);
		expect(sel.picked.value).toEqual([]);
		expect(state.count.value).toBe(0);
		state.confirm(); // nothing ticked: nothing sent
		expect(picks).toHaveLength(1);
	});

	it('a row ticked on an earlier page keeps its code and has no rectangle', async () => {
		const { rows, sel, state, picks } = setup();
		sel.toggle(page1[1]);
		rows.value = page2; // the next page
		await nextTick();
		sel.toggle(page2[0]);
		state.confirm();
		expect((picks[0] as { id: string; code: string; rect: DOMRect | null }[]).map((r) => [r.id, r.code, r.rect])).toEqual([['s2', 'S-2', null], ['s4', 'S-4', null]]);
	});

	it('a taken row cannot be ticked and is left out of what is handed back', () => {
		const { sel, state, picks } = setup(['s2']);
		state.toggle(page1[1]);
		expect(sel.picked.value).toEqual([]);
		expect(state.isTaken(page1[1])).toBe(true);
		sel.picked.value = ['s2', 's1']; // even if it got in (a stale tick), it is not sent
		expect(state.count.value).toBe(1);
		state.confirm();
		expect((picks[0] as { id: string }[]).map((r) => r.id)).toEqual(['s1']);
	});

	it('select all on page ticks the page', () => {
		const { sel } = setup();
		sel.togglePage();
		expect(sel.picked.value).toEqual(['s1', 's2', 's3']);
		expect(sel.allPicked.value).toBe(true);
		sel.togglePage();
		expect(sel.picked.value).toEqual([]);
	});
});
