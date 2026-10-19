import { describe, expect, it } from 'vitest';
import type { HostApi } from '@d1/ui';
import { CHOICES_LIMIT, useProjectChoices } from './useProjectChoices';

const PROJECTS = [
	{ project_id: 'pa', project_code: 'P-A', project_name: 'Alpha' },
	{ project_id: 'pb', project_code: null, project_name: 'Beta' },
];
const CAMPAIGNS = [
	{ campaign_id: 'ca', campaign_code: 'C-A', name: 'Trial A', project_id: 'pa' },
	{ campaign_id: 'cb', campaign_code: null, name: 'Trial B', project_id: { project_id: 'pb' } },
];

function fake(over: { projects?: unknown; campaigns?: unknown } = {}) {
	const calls: { path: string; params: Record<string, unknown> }[] = [];
	const api = {
		get: async (path: string, config?: { params?: Record<string, unknown> }) => {
			calls.push({ path, params: config?.params ?? {} });
			const answer = path === '/items/projects' ? (over.projects ?? PROJECTS) : (over.campaigns ?? CAMPAIGNS);
			if (answer instanceof Error) throw answer;
			return { data: { data: answer } };
		},
	} as unknown as HostApi;
	return { api, calls };
}

describe('useProjectChoices', () => {
	it('reads the projects and the campaigns once, as the signed-in user, through /items', async () => {
		const { api, calls } = fake();
		const c = useProjectChoices(api);
		await c.ensure();
		await c.ensure();
		expect(calls.map((x) => x.path).sort()).toEqual(['/items/campaigns', '/items/projects']);
		expect(c.projects.value).toEqual([{ value: 'pa', label: 'P-A · Alpha' }, { value: 'pb', label: 'Beta' }]);
		expect(c.campaigns.value).toEqual([{ value: 'ca', label: 'C-A · Trial A', projectId: 'pa' }, { value: 'cb', label: 'Trial B', projectId: 'pb' }]);
		expect(c.error.value).toBe('');
		expect(calls[0].params.limit).toBe(CHOICES_LIMIT);
	});

	it('says so when a list could not be read, and keeps the other', async () => {
		const { api } = fake({ campaigns: new Error('boom') });
		const c = useProjectChoices(api);
		await c.ensure();
		expect(c.projects.value).toHaveLength(2);
		expect(c.campaigns.value).toEqual([]);
		expect(c.error.value).toMatch(/campaigns/);
	});

	it('says when the list is cut at the limit', async () => {
		const many = Array.from({ length: CHOICES_LIMIT }, (_, i) => ({ project_id: `p${i}`, project_code: `P${i}`, project_name: 'x' }));
		const c = useProjectChoices(fake({ projects: many }).api);
		await c.ensure();
		expect(c.error.value).toMatch(/first/);
	});

	it('reload asks again', async () => {
		const { api, calls } = fake();
		const c = useProjectChoices(api);
		await c.ensure();
		await c.reload();
		expect(calls).toHaveLength(4);
	});
});
