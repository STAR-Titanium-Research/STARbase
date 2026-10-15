import { beforeEach, describe, expect, it, vi } from 'vitest';
const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// "Your work" must also list what the teams I belong to own (Review Focus 5 of plan People 3): the campaign and sample reads carry
// `owner_team_id _in <my team ids>`, the ids read once from /items/team_members.
const getItems = vi.fn();
vi.mock('@d1/ui', async (orig) => ({ ...(await orig<typeof import('@d1/ui')>()), useItems: () => ({ getItems, getItem: vi.fn() }) }));

import { useMyWork } from './useMyWork';

const teamClause = (ids: string[]) => ({ owner_team_id: { _in: ids } });
const callsOf = (collection: string) => getItems.mock.calls.filter(([c]) => c === collection).map(([, params]) => params);

function answer(rows: { team_members?: unknown[] | Error }) {
	getItems.mockImplementation(async (collection: string) => {
		if (collection === 'team_members') {
			if (rows.team_members instanceof Error) throw rows.team_members;
			return rows.team_members ?? [];
		}
		return [];
	});
}

beforeEach(() => getItems.mockReset());

describe('useMyWork and my teams', () => {
	it('reads my memberships once and widens the campaign and sample filters with them', async () => {
		answer({ team_members: [{ team_id: 't1' }, { team_id: 't2' }] });
		const w = useMyWork();
		await flushPromises();
		expect(callsOf('team_members')).toHaveLength(1);
		expect(JSON.stringify(callsOf('team_members')[0].filter)).toContain('$CURRENT_USER');
		const [campaigns] = callsOf('campaigns');
		expect(campaigns.filter._or).toContainEqual(teamClause(['t1', 't2']));
		const [samples] = callsOf('physical_samples');
		expect(samples.filter._or).toContainEqual(teamClause(['t1', 't2']));
		expect(w.partialTeams.value).toBe('');
	});

	it('leaves the filters as they were for a person with no team', async () => {
		answer({ team_members: [] });
		useMyWork();
		await flushPromises();
		expect(JSON.stringify(callsOf('campaigns')[0].filter)).not.toContain('owner_team_id');
		expect(JSON.stringify(callsOf('physical_samples')[0].filter)).not.toContain('owner_team_id');
	});

	it('shows my own records and says so when the memberships cannot be read', async () => {
		answer({ team_members: new Error('403') });
		const w = useMyWork();
		await flushPromises();
		expect(JSON.stringify(callsOf('campaigns')[0].filter)).not.toContain('owner_team_id');
		expect(w.campaigns.value.error).toBe('');
		expect(w.partialTeams.value).toContain('team memberships could not be read');
	});

	it('does not put the team clause on the projects read', async () => {
		answer({ team_members: [{ team_id: 't1' }] });
		useMyWork();
		await flushPromises();
		expect(JSON.stringify(callsOf('projects'))).not.toContain('owner_team_id');
	});
});
