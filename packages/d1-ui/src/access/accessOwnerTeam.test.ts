import { describe, expect, it, vi } from 'vitest';
import { transfer, type AccessApi } from './accessApi';
import {
	addable, hitName, isTeamOwner, noManagerText, ownerManagersText, ownerRowText, ownerWord, pickerTaken, teamHitOf, transferConfirmText, transferOffersTeams,
	type AccessTeamOwner,
} from './accessModel';
import { useAccess } from './useAccess';

const teamOwner = (over: Partial<AccessTeamOwner> = {}): AccessTeamOwner => ({
	kind: 'team', team_id: 't1', name: 'Additive', color: 'teal', logo: null,
	managers: [{ person_id: 'p1', full_name: 'Ada Hart' }, { person_id: 'p2', full_name: 'Bo Noor' }], ...over,
});
const personOwner = { kind: 'person' as const, person_id: 'p9', name: 'Cy Owner', can_sign_in: true };
const noManager = 'That team has no manager to look after the record — add a manager first';
const refusal = () => Object.assign(new Error('x'), { response: { status: 409, data: { errors: [{ message: noManager }] } } });

function fakeApi(post: (...a: any[]) => any = () => ({}), body: any = {}) {
	return {
		get: vi.fn(async () => ({ data: { restricted: false, owner: null, project_pi: null, can_manage: true, entries: [], ...body } })),
		post: vi.fn(async (...a: any[]) => ({ data: post(...a) })),
		patch: vi.fn(async () => ({ data: {} })),
		delete: vi.fn(async () => ({ data: {} })),
	} as unknown as AccessApi & Record<'get' | 'post' | 'patch' | 'delete', ReturnType<typeof vi.fn>>;
}

describe('a team as the owner', () => {
	it('is told apart from a person owner', () => {
		expect(isTeamOwner(teamOwner())).toBe(true);
		expect(isTeamOwner(personOwner)).toBe(false);
		expect(isTeamOwner({ person_id: 'p', name: 'Old shape', can_sign_in: true })).toBe(false);
		expect(isTeamOwner(null)).toBe(false);
	});

	it('reads "Additive (managers)" on the owner row, with the managers under it', () => {
		expect(ownerRowText(teamOwner())).toBe('Additive (managers)');
		expect(ownerRowText(personOwner)).toBe('Cy Owner');
		expect(ownerRowText(null)).toBe('No owner');
		expect(ownerManagersText(teamOwner())).toBe('Ada Hart, Bo Noor');
		expect(ownerManagersText(teamOwner({ managers: [] }))).toBe('');
		expect(ownerManagersText(personOwner)).toBe('');
	});

	it("says only the team's managers can change who has access", () => {
		expect(noManagerText(teamOwner())).toBe("Only Additive's managers can change who has access.");
		expect(noManagerText(personOwner)).toBe('Only Cy Owner can change who has access.');
		expect(noManagerText(null)).toBe('Only an admin can change who has access.');
	});

	it('is still the owner word of the record type', () => {
		expect(ownerWord('campaigns')).toBe('Owner');
	});

	it('leaves the people hits alone when the owner is a team (no person id to hide)', () => {
		const hits = [{ person_id: 'p1', full_name: 'Ada Hart' }, { person_id: 'p3', full_name: 'Di Wu' }];
		expect(addable(hits, { owner: teamOwner(), entries: [] }).map((h) => h.person_id)).toEqual(['p1', 'p3']);
		expect(addable(hits, { owner: personOwner, entries: [{ person_id: 'p1' } as any] }).map((h) => h.person_id)).toEqual(['p3']);
	});
});

describe('the transfer picker', () => {
	it('offers teams for the four ownable types and never for a project', () => {
		for (const c of ['physical_samples', 'manufacturing_operations', 'test_sessions', 'campaigns']) expect(transferOffersTeams(c), c).toBe(true);
		expect(transferOffersTeams('projects')).toBe(false);
	});

	it('leaves out only the owner: the team that owns the record, but not the teams that merely have access', () => {
		const list = { owner: teamOwner(), entries: [], teams: [{ team_id: 't2' }] };
		expect(pickerTaken(list, false)).toEqual({ owner: list.owner, entries: [], teams: [{ team_id: 't1' }] });
		expect(pickerTaken({ owner: personOwner, entries: [], teams: [{ team_id: 't2' }] }, false).teams).toEqual([]);
		// the add box (entries: true) leaves out everything already on the record, and the owning team (it cannot get a second grant)
		expect(pickerTaken(list, true).teams).toEqual([{ team_id: 't2' }, { team_id: 't1' }]);
		const mine = { owner: personOwner, entries: [], teams: [{ team_id: 't2' }] };
		expect(pickerTaken(mine, true)).toBe(mine);
	});

	it('names a hit, person or team', () => {
		expect(hitName({ person_id: 'p', full_name: 'Di Wu' })).toBe('Di Wu');
		const team = { team_id: 't', name: 'Additive', description: null, color: 'teal' as const, logo: null, member_count: 2, managers: [], is_member: true, is_manager: true };
		expect(hitName(teamHitOf(team))).toBe('Additive');
	});
});

describe('transferConfirmText with a team', () => {
	it('keeps the old wording between people', () => {
		expect(transferConfirmText('Ada', 'Charles', 'physical_samples')).toBe(
			'Charles becomes the owner. You stay on the record as Can edit. Only the new owner can change who has access.',
		);
	});

	it('to a team: the team becomes the owner, its managers decide, the person stays as Can edit', () => {
		expect(transferConfirmText('Ada', 'Additive', 'campaigns', true, { toTeam: true })).toBe(
			"Additive becomes the owner. You stay on the record as Can edit. Only Additive's managers can change who has access.",
		);
	});

	it('Ruling O5, a team record to a person: the managers lose access unless added back', () => {
		const text = transferConfirmText('Additive', 'Charles', 'physical_samples', true, { fromTeam: true });
		expect(text).toBe(
			'Charles becomes the owner. You and the other managers of Additive will lose access unless you are added back. Only the new owner can change who has access.',
		);
		expect(text).not.toContain('stay');
	});

	it('Ruling O5, team to team, and by an admin', () => {
		expect(transferConfirmText('Additive', 'Sintering', 'test_sessions', true, { fromTeam: true, toTeam: true })).toBe(
			"Sintering becomes the owner. You and the other managers of Additive will lose access unless you are added back. Only Sintering's managers can change who has access.",
		);
		expect(transferConfirmText('Additive', 'Charles', 'test_sessions', false, { fromTeam: true })).toBe(
			'Charles becomes the owner. The managers of Additive will lose access unless they are added back. Only the new owner can change who has access.',
		);
	});
});

describe('transfer to a team (api)', () => {
	it('sends the team id', async () => {
		const api = fakeApi(() => ({ owner: { kind: 'team', name: 'Additive' }, email: 'sent', blocked_by: null }));
		expect(await transfer(api, 'campaigns', 'c1', { team_id: 't1' })).toEqual({ ok: true, data: { email: 'sent', owner: { kind: 'team', name: 'Additive' }, blocked_by: null } });
		expect(api.post).toHaveBeenCalledWith('/d1-record-access/campaigns/c1/transfer', { team_id: 't1' });
	});

	it('a bare string is still a person', async () => {
		const api = fakeApi();
		await transfer(api, 'campaigns', 'c1', 'p1');
		expect(api.post).toHaveBeenCalledWith('/d1-record-access/campaigns/c1/transfer', { person_id: 'p1' });
		await transfer(api, 'campaigns', 'c1', { person_id: 'p2' });
		expect(api.post).toHaveBeenLastCalledWith('/d1-record-access/campaigns/c1/transfer', { person_id: 'p2' });
	});

	it("hands back the endpoint's refusal (a team with no manager)", async () => {
		const api = fakeApi(() => { throw refusal(); });
		expect(await transfer(api, 'campaigns', 'c1', { team_id: 't1' })).toEqual({ ok: false, message: noManager });
	});
});

describe('useAccess: transfer to a team', () => {
	it('keeps a team owner on the list as the endpoint sent it', async () => {
		const a = useAccess(fakeApi(() => ({}), { owner: teamOwner() }), () => ({ collection: 'campaigns', id: 'c1' }));
		await a.load();
		expect(a.list.value?.owner).toEqual(teamOwner());
	});

	it('transfers to a team, refetches and tells the page', async () => {
		const api = fakeApi(() => ({ owner: { kind: 'team', name: 'Additive' }, email: 'sent', blocked_by: null }));
		const changed = vi.fn();
		const a = useAccess(api, () => ({ collection: 'campaigns', id: 'c1' }), changed);
		await a.load();
		api.get.mockClear();
		expect(await a.transferTo({ team_id: 't1' })).toBe(true);
		expect(api.post).toHaveBeenCalledWith('/d1-record-access/campaigns/c1/transfer', { team_id: 't1' });
		expect(api.get).toHaveBeenCalledTimes(1);
		expect(changed).toHaveBeenCalledTimes(1);
		expect(a.note.value).toBe('Ownership transferred.');
	});

	it('shows the refusal of a team with no manager', async () => {
		const api = fakeApi(() => { throw refusal(); });
		const changed = vi.fn();
		const a = useAccess(api, () => ({ collection: 'campaigns', id: 'c1' }), changed);
		await a.load();
		expect(await a.transferTo({ team_id: 't1' })).toBe(false);
		expect(a.error.value).toContain('has no manager');
		expect(changed).not.toHaveBeenCalled();
	});
});
