// @vitest-environment happy-dom
// The Project page's timeline follows the View rail's Activity range (30 d, 6 mo, All) client side: the page reads the whole history once, so
// changing the range reads nothing again, and the timeline's "last operation" still sees work older than the range.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { setExplorerHostFactory } from '@d1/ui';
import { useProjectData } from './useProjectData';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
// An operation 40 weeks before "now" (the test runs against the real clock, so it is built from it).
const OLD = new Date(Date.now() - 40 * 7 * 86_400_000).toISOString();
const RECENT = new Date(Date.now() - 2 * 86_400_000).toISOString();

let app: App | null = null;
afterEach(() => {
	app?.unmount();
	app = null;
});

// The chart's read is the one that asks for the operation date alone (for one project the rows are its own by the filter), unlike the page's lists.
const isActivityRead = (url: string, p: Record<string, any>) =>
	url === '/items/manufacturing_operations' && p.fields?.length === 1 && p.fields[0] === 'operation_date';

function setup() {
	const get = vi.fn(async (url: string, config?: { params?: Record<string, any> }) => {
		const p = config?.params ?? {};
		if (url === `/items/projects/${PROJECT}`) return { data: { data: { project_id: PROJECT, project_code: 'P-1' } } };
		if (isActivityRead(url, p)) return { data: { data: [{ operation_date: RECENT }, { operation_date: OLD }] } };
		return { data: { data: [] } };
	});
	setExplorerHostFactory(() => ({ api: { get }, navigate: () => {}, openDataStudio: () => {}, user: ref(null) }) as any);
	let data!: ReturnType<typeof useProjectData>;
	app = createApp(defineComponent({ setup: () => { data = useProjectData(ref(PROJECT)); return () => h('div'); } }));
	app.mount(document.createElement('div'));
	return { get, data: () => data };
}
const settle = async () => { for (let i = 0; i < 20; i++) await nextTick(); await new Promise((r) => setTimeout(r)); };
const activityReads = (get: ReturnType<typeof vi.fn>) => get.mock.calls.filter(([u, c]) => isActivityRead(u, c?.params ?? {}));

describe('useProjectData activity', () => {
	it('reads the whole history once: every dated done row, not a window', async () => {
		const { get, data } = setup();
		await settle();
		expect(activityReads(get)).toHaveLength(1);
		expect(JSON.stringify(activityReads(get)[0][1].params.filter)).toContain('_nnull');
		expect(JSON.stringify(activityReads(get)[0][1].params.filter)).not.toContain('_gte');
		expect(data().activity.value.data.ops).toEqual([RECENT, OLD]);
	});
});
