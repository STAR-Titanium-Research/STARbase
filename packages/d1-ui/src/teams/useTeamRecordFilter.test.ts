import { describe, expect, it, vi } from 'vitest';
import { nextTick, reactive } from 'vue';
import type { ExplorerHost } from '../host';
import { useTeamRecordFilter } from './useTeamRecordFilter';
import type { TeamRouteLike, TeamRouterLike } from './useTeamRecordFilter';

const flush = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await nextTick();
};

function setup(query: Record<string, string>, records: (id: string) => Promise<any> | any) {
	const api = {
		get: vi.fn(async (path: string, config?: any) => {
			if (path === '/d1-teams') return { data: { teams: [{ team_id: 't1', name: 'Additive' }] } };
			const m = /^\/d1-teams\/([^/]+)\/records$/.exec(path);
			if (m) return { data: await records(decodeURIComponent(m[1])), config };
			throw new Error(`unexpected ${path}`);
		}),
	};
	const host = { api } as unknown as ExplorerHost;
	const route = reactive<TeamRouteLike>({ path: '/home/projects', query });
	const replaced: Record<string, string>[] = [];
	const router: TeamRouterLike = { replace: (to) => { replaced.push(to.query); route.query = to.query; } };
	return { host, route, router, api, replaced };
}

describe('useTeamRecordFilter', () => {
	it('lists the teams and asks for no ids while no team is chosen', async () => {
		const t = setup({}, () => ({ ids: [], truncated: false }));
		const f = useTeamRecordFilter(t.host, 'projects', t.route, t.router);
		await flush();
		expect(f.teams.value).toEqual([{ value: 't1', label: 'Additive' }]);
		expect(f.team.value).toBe('');
		expect([...f.ids.value]).toEqual([]);
		expect(t.api.get).toHaveBeenCalledTimes(1);
	});

	it('reads f.team from the URL and loads that team\'s readable project ids', async () => {
		const t = setup({ 'f.team': 't1' }, () => ({ ids: ['p1', 'p2'], truncated: false }));
		const f = useTeamRecordFilter(t.host, 'projects', t.route, t.router);
		expect(f.ids.value.size).toBe(0); // nothing is shown while they load
		await flush();
		expect(f.team.value).toBe('t1');
		expect([...f.ids.value]).toEqual(['p1', 'p2']);
		expect(t.api.get).toHaveBeenCalledWith('/d1-teams/t1/records', { params: { collection: 'projects', limit: 500 } });
		expect(f.note.value).toBe('');
	});

	it('writes the choice to the URL keeping the other keys, and clears it', async () => {
		const t = setup({ 'f.other': 'x' }, (id: string) => ({ ids: [id], truncated: true }));
		const f = useTeamRecordFilter(t.host, 'projects', t.route, t.router);
		await flush();
		f.setTeam('t1');
		expect(t.replaced.at(-1)).toEqual({ 'f.other': 'x', 'f.team': 't1' });
		await flush();
		expect([...f.ids.value]).toEqual(['t1']);
		expect(f.note.value).toBe("Showing the latest 500 of this team's records.");
		f.setTeam('');
		expect(t.replaced.at(-1)).toEqual({ 'f.other': 'x' });
		await flush();
		expect(f.ids.value.size).toBe(0);
		expect(f.note.value).toBe('');
	});

	it('a failed ids request leaves the set empty (nothing matches) and says why', async () => {
		const t = setup({ 'f.team': 't1' }, () => { throw Object.assign(new Error('x'), { response: { status: 500, data: { errors: [{ message: 'boom' }] } } }); });
		const f = useTeamRecordFilter(t.host, 'projects', t.route, t.router);
		await flush();
		expect(f.ids.value.size).toBe(0);
		expect(f.error.value).not.toBe('');
		expect(f.loading.value).toBe(false);
	});
});
