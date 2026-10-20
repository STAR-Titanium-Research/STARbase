// @vitest-environment happy-dom
// The Project page's activity chart follows the View rail's range: changing it reads the chart again and nothing else.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { setExplorerHostFactory } from '@d1/ui';
import type { ActivityRange } from '@d1/ui';
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

// The chart's read is the one that asks for the campaign's project too (the project rule), unlike the Project page's plain lists.
const isActivityRead = (url: string, p: Record<string, any>) =>
	url === '/items/manufacturing_operations' && !!p.fields?.includes('campaign_id.project_id') && p.fields.includes('operation_date');

function setup() {
	const get = vi.fn(async (url: string, config?: { params?: Record<string, any> }) => {
		const p = config?.params ?? {};
		if (url === `/items/projects/${PROJECT}`) return { data: { data: { project_id: PROJECT, project_code: 'P-1' } } };
		if (isActivityRead(url, p)) {
			const all = [{ project_id: PROJECT, operation_date: RECENT }, { project_id: PROJECT, operation_date: OLD }];
			// the server applies the window: a start date keeps only the recent one
			return { data: { data: JSON.stringify(p.filter).includes('_gte') ? all.slice(0, 1) : all } };
		}
		return { data: { data: [] } };
	});
	setExplorerHostFactory(() => ({ api: { get }, navigate: () => {}, openDataStudio: () => {}, user: ref(null) }) as any);
	const range = ref<ActivityRange>('6mo');
	let data!: ReturnType<typeof useProjectData>;
	app = createApp(defineComponent({ setup: () => { data = useProjectData(ref(PROJECT), range); return () => h('div'); } }));
	app.mount(document.createElement('div'));
	return { get, range, data: () => data };
}
const settle = async () => { for (let i = 0; i < 20; i++) await nextTick(); await new Promise((r) => setTimeout(r)); };
const activityReads = (get: ReturnType<typeof vi.fn>) => get.mock.calls.filter(([u, c]) => isActivityRead(u, c?.params ?? {}));

describe('useProjectData activity range', () => {
	it('starts with the 26-week default window', async () => {
		const { get, data } = setup();
		await settle();
		expect(data().activity.value.data.data?.weeks).toHaveLength(26);
		expect(data().activity.value.data.data?.totalOps).toBe(1);
		expect(activityReads(get)).toHaveLength(1);
	});

	it('reads only the activity again when the range changes, over the new window', async () => {
		const { get, range, data } = setup();
		await settle();
		const campaignReads = () => get.mock.calls.filter(([u]) => u === '/items/campaigns').length;
		const before = campaignReads();
		range.value = '30d';
		await settle();
		expect(data().activity.value.data.data?.weeks).toHaveLength(5);
		range.value = 'all';
		await settle();
		const a = data().activity.value.data.data!;
		expect(a.weeks.length).toBeGreaterThanOrEqual(41);
		expect(a.totalOps).toBe(2);
		expect(activityReads(get)).toHaveLength(3);
		expect(JSON.stringify(activityReads(get)[2][1].params.filter)).toContain('_nnull');
		expect(campaignReads()).toBe(before);
	});
});
