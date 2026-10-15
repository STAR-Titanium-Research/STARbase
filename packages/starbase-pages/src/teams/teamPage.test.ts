import { describe, expect, it } from 'vitest';
import type { PendingItem, TeamEvent, TeamSummary } from '@d1/ui';
import {
	LOGO_MAX_BYTES, addedLines, canManage, deleteRefusal, ownedCountsText, hiddenLine, historyLabel, levelCounts, logoProblem, managersLine, membersAndRecords, pendingLine, plural,
	teamsShown, tileOf,
} from './teamPage';

const event = (over: Partial<TeamEvent>): TeamEvent => ({
	event_id: 1, at: '2026-10-14T10:00:00Z', kind: 'created', actor_person_id: 'a', actor_name: 'Alex Hart', person_id: null, person_name: null,
	collection: null, record_id: null, record_kind: null, record_code: null, record_hidden: false, detail: null, ...over,
});
const team = (over: Partial<TeamSummary>): TeamSummary => ({
	team_id: 't', name: 'Additive', description: null, color: 'teal', logo: null, member_count: 1, managers: [], is_member: false, is_manager: false, ...over,
});

describe('plural', () => {
	it('agrees the noun with the count', () => {
		expect(plural(1, 'member')).toBe('1 member');
		expect(plural(0, 'member')).toBe('0 members');
		expect(plural(12, 'record')).toBe('12 records');
	});
});

describe('membersAndRecords', () => {
	it('says members and records, the records being every grant of the team', () => {
		expect(membersAndRecords(6, { view: 3, edit: 2, investigator: 1 })).toBe('6 members · 6 records');
		expect(membersAndRecords(1, { view: 1, edit: 0, investigator: 0 })).toBe('1 member · 1 record');
		expect(membersAndRecords(0, { view: 0, edit: 0, investigator: 0 })).toBe('0 members · 0 records');
	});
});

describe('records a team owns', () => {
	it('count as records of the team', () => {
		expect(membersAndRecords(6, { view: 3, edit: 2, investigator: 1, owns: 4 })).toBe('6 members · 10 records');
		expect(membersAndRecords(2, { view: 0, edit: 0, investigator: 0, owns: 1 })).toBe('2 members · 1 record');
	});
	it('are listed first as Owns, only when the team owns any', () => {
		expect(levelCounts({ view: 4, edit: 2, investigator: 0, owns: 3 })[0]).toEqual({ key: 'owns', label: 'Owns', n: 3 });
		expect(levelCounts({ view: 4, edit: 2, investigator: 0, owns: 0 })).toHaveLength(3);
		expect(levelCounts({ view: 4, edit: 2, investigator: 0 })).toHaveLength(3);
	});
});

describe('ownedCountsText', () => {
	it('lists the collections the team owns records in, with the right nouns', () => {
		expect(ownedCountsText({ physical_samples: 2, manufacturing_operations: 0, test_sessions: 0, campaigns: 1 })).toBe('2 samples and 1 campaign');
		expect(ownedCountsText({ physical_samples: 1, manufacturing_operations: 3, test_sessions: 2, campaigns: 1 })).toBe('1 sample, 3 operations, 2 tests and 1 campaign');
		expect(ownedCountsText({ campaigns: 5 })).toBe('5 campaigns');
		expect(ownedCountsText({})).toBe('records');
		expect(ownedCountsText(null)).toBe('records');
	});
});

describe('deleteRefusal', () => {
	const counts = { physical_samples: 2, manufacturing_operations: 0, test_sessions: 0, campaigns: 1 };
	it('says what the team owns, from the counts the endpoint sent', () => {
		const err = Object.assign(new Error('Beta owns 2 samples and 1 campaign. Transfer ownership of them to a person or another team before deleting the team.'), {
			status: 409, code: 'TEAM_OWNS_RECORDS', extensions: { code: 'TEAM_OWNS_RECORDS', counts },
		});
		expect(deleteRefusal('Beta', err)).toBe('Beta owns 2 samples and 1 campaign. Transfer ownership of them to a person or another team before deleting the team.');
	});
	it("falls back to the endpoint's own words, and to a plain sentence", () => {
		expect(deleteRefusal('Beta', Object.assign(new Error('Server says no'), { code: 'LAST_MANAGER' }))).toBe('Server says no');
		expect(deleteRefusal('Beta', Object.assign(new Error('This team owns records.'), { code: 'TEAM_OWNS_RECORDS', extensions: {} }))).toBe('This team owns records.');
		expect(deleteRefusal('Beta', null)).toBe('That did not work.');
	});
});

describe('levelCounts', () => {
	it('lists Can edit, Can view and Investigator in the spec order, with zeros kept', () => {
		expect(levelCounts({ view: 4, edit: 2, investigator: 0 })).toEqual([
			{ key: 'edit', label: 'Can edit', n: 2 },
			{ key: 'view', label: 'Can view', n: 4 },
			{ key: 'investigator', label: 'Investigator', n: 0 },
		]);
	});
});

describe('hiddenLine', () => {
	it('says how many records the viewer cannot see, and nothing for none', () => {
		expect(hiddenLine(0)).toBeNull();
		expect(hiddenLine(1)).toBe("and 1 you can't see");
		expect(hiddenLine(26)).toBe("and 26 you can't see");
	});
});

describe('managersLine', () => {
	it('names the managers', () => {
		expect(managersLine([{ full_name: 'Alex Hart' }, { full_name: null }])).toBe('Alex Hart, Unnamed');
		expect(managersLine([])).toBe('');
	});
});

describe('historyLabel', () => {
	it('words each kind of event', () => {
		expect(historyLabel(event({ kind: 'created' }))).toBe('Alex Hart created the team');
		expect(historyLabel(event({ kind: 'renamed', detail: { from: 'Add', to: 'Additive' } }))).toBe('Alex Hart renamed the team from Add to Additive');
		expect(historyLabel(event({ kind: 'member_added', person_id: 'p', person_name: 'Femi Noor', detail: { is_manager: false } }))).toBe('Alex Hart added Femi Noor');
		expect(historyLabel(event({ kind: 'member_added', person_id: 'p', person_name: 'Femi Noor', detail: { is_manager: true } }))).toBe('Alex Hart added Femi Noor as a manager');
		expect(historyLabel(event({ kind: 'member_removed', person_id: 'p', person_name: 'Femi Noor' }))).toBe('Alex Hart removed Femi Noor');
		expect(historyLabel(event({ kind: 'manager_set', person_id: 'p', person_name: 'Femi Noor' }))).toBe('Alex Hart made Femi Noor a manager');
		expect(historyLabel(event({ kind: 'manager_unset', person_id: 'p', person_name: 'Femi Noor' }))).toBe('Alex Hart made Femi Noor an ordinary member');
	});
	it('says "left" when the person removed themself', () => {
		expect(historyLabel(event({ kind: 'member_removed', actor_person_id: 'p', actor_name: 'Femi Noor', person_id: 'p', person_name: 'Femi Noor' }))).toBe('Femi Noor left the team');
	});
	it('names the record, or says it is hidden from the viewer', () => {
		const rec = { collection: 'physical_samples', record_id: 's1', record_kind: 'sample', record_code: 'S-0042' };
		expect(historyLabel(event({ kind: 'shared', ...rec, detail: { level: 'edit' } }))).toBe('Alex Hart shared Sample S-0042 with the team (Can edit)');
		expect(historyLabel(event({ kind: 'shared', ...rec }))).toBe('Alex Hart shared Sample S-0042 with the team');
		expect(historyLabel(event({ kind: 'unshared', ...rec }))).toBe('Alex Hart stopped sharing Sample S-0042 with the team');
		expect(historyLabel(event({ kind: 'shared', record_hidden: true, collection: 'projects', record_id: 'x' }))).toBe("Alex Hart shared a record you can't see with the team");
		expect(historyLabel(event({ kind: 'approved', person_id: 'p', person_name: 'Femi Noor', ...rec }))).toBe('Alex Hart approved Femi Noor on Sample S-0042');
		expect(historyLabel(event({ kind: 'declined', person_id: 'p', person_name: 'Femi Noor', ...rec }))).toBe('Alex Hart declined Femi Noor on Sample S-0042');
		expect(historyLabel(event({ kind: 'trust_set', ...rec }))).toBe('Alex Hart trusted future members on Sample S-0042');
		expect(historyLabel(event({ kind: 'trust_unset', ...rec }))).toBe('Alex Hart stopped trusting future members on Sample S-0042');
	});
	it('copes with a missing actor, a missing record kind and an unknown kind', () => {
		expect(historyLabel(event({ kind: 'created', actor_name: null, actor_person_id: null }))).toBe('Someone created the team');
		expect(historyLabel(event({ kind: 'shared', collection: 'projects', record_id: 'x' }))).toBe('Alex Hart shared a record with the team');
		expect(historyLabel(event({ kind: 'mystery' }))).toBe('Alex Hart: mystery');
		expect(historyLabel(event({ kind: 'renamed', detail: 'junk' }))).toBe('Alex Hart renamed the team');
	});
});

describe('pendingLine', () => {
	const item = (n: number, name: string | null = 'Femi Noor'): PendingItem => ({
		team_id: 't',
		team_name: 'Additive',
		person_id: 'p',
		full_name: name,
		records: Array.from({ length: n }, (_, i) => ({ collection: 'physical_samples', id: String(i), kind: 'sample', code: `S-${i}`, title: null, role: 'edit' })),
	});
	it('says who joined which team and how many of the viewer records it concerns', () => {
		expect(pendingLine(item(12))).toBe('Femi Noor joined Additive · 12 of your records');
		expect(pendingLine(item(1))).toBe('Femi Noor joined Additive · 1 of your records');
		expect(pendingLine(item(2, null))).toBe('Someone joined Additive · 2 of your records');
	});
});

describe('addedLines', () => {
	it('says only what happens', () => {
		expect(addedLines('Femi Noor', 'Additive', { pending: 0, owners_asked: 0, owned_edit: 0 })).toEqual(['Femi Noor is now a member of Additive.']);
		expect(addedLines('Femi Noor', 'Additive', { pending: 26, owners_asked: 3, owned_edit: 0 })).toEqual([
			'Femi Noor is now a member of Additive.',
			'Owners of 26 records shared with Additive will be asked to approve.',
		]);
		expect(addedLines('Femi Noor', 'Additive', { pending: 1, owners_asked: 1, owned_edit: 0 })[1]).toBe('The owner of 1 record shared with Additive will be asked to approve.');
	});
	it('adds the records the team owns once teams can own records', () => {
		expect(addedLines('Femi Noor', 'Additive', { pending: 0, owners_asked: 0, owned_edit: 12 })[1]).toBe('Femi Noor gets Can edit on the 12 records Additive owns.');
		expect(addedLines('Femi Noor', 'Additive', { pending: 0, owners_asked: 0, owned_edit: 1 })[1]).toBe('Femi Noor gets Can edit on the 1 record Additive owns.');
	});
	it('says a new manager can also share, transfer and delete the records the team owns', () => {
		expect(addedLines('Femi Noor', 'Additive', { pending: 0, owners_asked: 0, owned_edit: 12 }, true)[1]).toBe(
			'Femi Noor gets Can edit on the 12 records Additive owns, and as a manager can share, transfer and delete them.',
		);
		expect(addedLines('Femi Noor', 'Additive', { pending: 0, owners_asked: 0, owned_edit: 0 }, true)).toHaveLength(1);
	});
});

describe('canManage', () => {
	it('lets a manager of the team and an administrator manage it', () => {
		expect(canManage(team({ is_manager: true }), false)).toBe(true);
		expect(canManage(team({ is_member: true }), false)).toBe(false);
		expect(canManage(team({}), true)).toBe(true);
		expect(canManage(null, true)).toBe(false);
	});
});

describe('teamsShown', () => {
	const teams = [team({ team_id: 'a', is_member: true }), team({ team_id: 'b' })];
	it('shows every team, or the ones the viewer is in', () => {
		expect(teamsShown(teams, 'all').map((t) => t.team_id)).toEqual(['a', 'b']);
		expect(teamsShown(teams, 'mine').map((t) => t.team_id)).toEqual(['a']);
	});
});

describe('tileOf', () => {
	it('falls back to teal for an unknown colour', () => {
		expect(tileOf({ name: 'X', color: 'chartreuse', logo: null }).color).toBe('teal');
		expect(tileOf({ name: 'X', color: 'blue', logo: 'f' })).toEqual({ name: 'X', color: 'blue', logo: 'f' });
	});
});

describe('logoProblem', () => {
	const file = (type: string, size: number) => ({ type, size }) as File;
	it('accepts png, jpeg and svg up to 1 MB', () => {
		for (const t of ['image/png', 'image/jpeg', 'image/svg+xml']) expect(logoProblem(file(t, 1000))).toBeNull();
		expect(logoProblem(file('image/png', LOGO_MAX_BYTES))).toBeNull();
	});
	it('refuses another type or a larger file, saying why', () => {
		expect(logoProblem(file('image/gif', 10))).toBe('The logo must be a PNG, JPEG or SVG image.');
		expect(logoProblem(file('image/png', LOGO_MAX_BYTES + 1))).toBe('The logo must be 1 MB or smaller.');
	});
});
