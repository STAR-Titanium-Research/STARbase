import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
import type { DraftBody, HostApi } from '@d1/ui';
import { mkData, mkOp, mkSample } from './model/fixtures';
import type { ProcessData } from './model/types';
import { loadFamily, loadFormRead } from './model/loadFamily';
import { apply, emptyBody, type DraftAction } from './edit/draft';
import { isDraftNode } from './edit/socketRefs';
import { toGraph } from './edit/toGraph';
import { useProcessMap, type MapOverlay } from './useProcessMap';

// The map with edit mode's overlay: the draft is merged into the loaded data (blank canvas included) and its cards are always drawn.

vi.mock('./model/loadFamily', async (orig) => ({
	...(await orig<typeof import('./model/loadFamily')>()),
	loadFamily: vi.fn(),
	loadFormRead: vi.fn(async () => ({ defs: null, work: [] as string[] })),
}));

const family = vi.mocked(loadFamily);
const api = {} as HostApi;
const settle = async () => {
	for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
	await nextTick();
};
const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);

/** The overlay as useEditMode makes it, over a body the test changes. */
function overlayOf(initial: DraftBody, on = true) {
	const body = ref(initial);
	const active = ref(on);
	const focused = ref(true);
	const overlay: MapOverlay = {
		active: () => active.value,
		blank: () => active.value && !focused.value,
		merge: (d: ProcessData | null) => toGraph(d, body.value),
		keep: (n) => isDraftNode(body.value, n),
	};
	return { body, active, focused, overlay };
}

function setup(query: Record<string, unknown>, overlay?: MapOverlay) {
	const route = reactive({ path: '/map', query: { ...query } as Record<string, unknown> });
	const replace = vi.fn(async (to: { query: Record<string, unknown> }) => void (route.query = to.query));
	const map = useProcessMap(api, route, { replace }, overlay);
	return { map, route };
}

const loaded = (): ProcessData =>
	mkData({
		samples: [mkSample('s1'), mkSample('s2')],
		operations: [mkOp({ id: 'o1', sampleId: 's1', outputSampleId: 's2', date: '2026-09-01T09:00:00Z', methodName: 'Cut' })],
	});

beforeEach(() => {
	family.mockReset();
	vi.mocked(loadFormRead).mockResolvedValue({ defs: null, work: [] });
});

describe('the map with a blank canvas', () => {
	it('is ready with only the draft on it, when edit mode has no record to map', async () => {
		const o = overlayOf(run([{ type: 'addSample' }]));
		o.focused.value = false;
		const { map } = setup({}, o.overlay);
		await settle();
		expect(family).not.toHaveBeenCalled();
		expect(map.status.value).toBe('ready');
		expect(map.nodes.value.map((n) => n.id)).toEqual(['s:draft:n1']);
		expect(map.focusNodeId.value).toBe('s:draft:n1');
	});

	it('draws a container with nothing wired to it, though no focus reaches it', async () => {
		const o = overlayOf(run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' } }]));
		o.focused.value = false;
		const { map } = setup({}, o.overlay);
		await settle();
		const nodes = map.nodes.value;
		expect(nodes).toHaveLength(1);
		expect(nodes[0].type).toBe('container');
	});

	it('is the search-first page again once edit mode ends', async () => {
		const o = overlayOf(emptyBody());
		o.focused.value = false;
		const { map } = setup({}, o.overlay);
		await settle();
		expect(map.status.value).toBe('ready');
		o.active.value = false;
		await settle();
		expect(map.status.value).toBe('empty');
	});

	it('is the search-first page without an overlay', async () => {
		const { map } = setup({});
		await settle();
		expect(map.status.value).toBe('empty');
	});
});

describe('the map with a draft on a loaded history', () => {
	it('draws the loaded family and the draft together', async () => {
		family.mockResolvedValue(loaded());
		const o = overlayOf(run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } }]));
		const { map } = setup({ focus: 'physical_samples:s1' }, o.overlay);
		await settle();
		const ids = map.nodes.value.map((n) => n.id);
		expect(ids).toEqual(expect.arrayContaining(['s:s1', 's:s2', 's:draft:n1']));
		expect(map.nodes.value.filter((n) => n.type === 'container')).toHaveLength(2);
		expect(map.overlaid.value?.samples.some((s) => s.draft)).toBe(true);
		// `data` keeps its meaning: what was loaded for the focus, without the draft.
		expect(map.data.value?.samples.some((s) => s.draft)).toBe(false);
	});

	it('keeps the draft drawn however far the reach is from the focus', async () => {
		family.mockResolvedValue(loaded());
		// A draft sample with a draft operation that nothing links to the history: no reach would show it.
		const o = overlayOf(run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } }]));
		const { map } = setup({ focus: 'physical_samples:s1', reach: '1' }, o.overlay);
		await settle();
		expect(map.shown.value.has('s:draft:n1')).toBe(true);
		expect([...map.shown.value].filter((id) => id.includes('draft'))).toHaveLength(2);
	});

	it('Expand (＋) on a draft card does nothing: its id is not a record, so no family is read for it', async () => {
		family.mockResolvedValue(loaded());
		const o = overlayOf(run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } }]));
		const { map } = setup({ focus: 'physical_samples:s1' }, o.overlay);
		await settle();
		const before = map.nodes.value.length;
		for (const id of ['s:draft:n1', ...map.nodes.value.filter((n) => n.type === 'container').map((n) => n.id).filter((id) => id.includes('draft'))]) {
			await map.expand(id);
		}
		await settle();
		expect(family).toHaveBeenCalledTimes(1);
		expect(map.nodes.value.length).toBe(before);
		expect(map.notice.value).toBe('');
	});

	it('redraws when the draft changes, and the loaded data is not touched', async () => {
		family.mockResolvedValue(loaded());
		const o = overlayOf(emptyBody());
		const { map } = setup({ focus: 'physical_samples:s1' }, o.overlay);
		await settle();
		const before = map.nodes.value.length;
		o.body.value = apply(o.body.value, { type: 'addSample' });
		await nextTick();
		expect(map.nodes.value.length).toBe(before + 1);
		expect(family).toHaveBeenCalledTimes(1);
	});

	it('has no draft on it while the overlay is off', async () => {
		family.mockResolvedValue(loaded());
		const o = overlayOf(run([{ type: 'addSample' }]), false);
		const { map } = setup({ focus: 'physical_samples:s1' }, o.overlay);
		await settle();
		expect(map.nodes.value.some((n) => n.id.includes('draft'))).toBe(false);
	});

	it('selects and describes a draft card like any other', async () => {
		family.mockResolvedValue(loaded());
		const o = overlayOf(run([{ type: 'addSample', values: { sample_code: '{seq}-Ti64-MF-2026-10-14' } }]));
		const { map } = setup({ focus: 'physical_samples:s1' }, o.overlay);
		await settle();
		map.select('s:draft:n1');
		expect(map.selectedId.value).toBe('s:draft:n1');
		expect(map.selectedInfo.value?.kind).toBe('sample');
		expect(map.selected.value?.ref.id).toBe('draft:n1');
	});

	it('takes the hints of the changes the draft makes, for the canvas', async () => {
		family.mockResolvedValue(loaded());
		const { map } = setup({ focus: 'physical_samples:s1' }, overlayOf(emptyBody()).overlay);
		await settle();
		map.hintMerge({ anchor: 's:s1' });
		expect(map.takeMergeHints()).toEqual([{ anchor: 's:s1' }]);
		expect(map.takeMergeHints()).toEqual([]);
	});
});
