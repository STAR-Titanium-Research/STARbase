import { describe, expect, it } from 'vitest';
import type { PeopleRow } from './peopleQuery';
import { rowNote } from './rowNote';

const row = (over: Partial<PeopleRow> = {}): PeopleRow => ({
	kind: 'person',
	person_id: 'p1',
	full_name: 'Alex Hart',
	email: null,
	is_researcher: true,
	is_operator: false,
	active: true,
	notes: null,
	user_id: null,
	login: null,
	attention: [],
	...over,
});
const login = (status: string) => ({ status, role_id: 'r', role_name: 'Lab Member', last_access: null, email: 'a@b.c' });

describe('rowNote', () => {
	it('is null when nothing is off', () => expect(rowNote(row())).toBeNull());
	it('names an unaccepted invite first', () =>
		expect(rowNote(row({ attention: ['missing_email', 'invite_not_accepted'], login: login('invited') }))).toBe('Invite not accepted'));
	it('says Suspended for a suspended login', () =>
		expect(rowNote(row({ attention: ['suspended_owns_records'], login: login('suspended') }))).toBe('Suspended'));
	it('otherwise gives the first note', () => expect(rowNote(row({ attention: ['possible_duplicate', 'missing_email'] }))).toBe('Possible duplicate'));
	it('falls back to the attention wording for an unknown key', () => expect(rowNote(row({ attention: ['something_new'] }))).toBe('something_new'));
	it('names a Former person who is still in a team', () => expect(rowNote(row({ attention: ['former_in_team'], active: false }))).toBe('Former, still in a team'));
	it('has no note on a login without a person', () => expect(rowNote(row({ kind: 'login', attention: ['login_without_person'] }))).toBeNull());
});
