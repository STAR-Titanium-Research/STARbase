import { describe, expect, it } from 'vitest';
import type { AccessRecord } from './peopleApi';
import type { PeopleRow } from './peopleQuery';
import { canEditRole, countLabel, escapeClosesPanel, kindLabel, levelLabel, loginLine, sourceNote } from './personPanel';

const row = (status: string | null | undefined): PeopleRow => ({
	kind: 'person',
	person_id: 'p1',
	full_name: 'Alex Hart',
	email: 'a@x.ac.uk',
	is_researcher: true,
	is_operator: false,
	active: true,
	notes: null,
	user_id: status === undefined ? null : 'u1',
	login: status === undefined ? null : { status, role_id: 'r1', role_name: 'Lab Member', last_access: null, email: 'a@x.ac.uk' },
	attention: [],
});
const ADMIN = { admin: true, accounts: true };
const LAB_ADMIN = { admin: true, accounts: false };
const MEMBER = { admin: false, accounts: false };

describe('loginLine', () => {
	it('gives an account administrator Suspend, Reactivate, Resend and Invite', () => {
		expect(loginLine(row('active'), ADMIN)).toEqual({ state: 'Active', action: { kind: 'suspend', label: 'Suspend' } });
		expect(loginLine(row('suspended'), ADMIN)).toEqual({ state: 'Suspended', action: { kind: 'reactivate', label: 'Reactivate' } });
		expect(loginLine(row('invited'), ADMIN)).toEqual({ state: 'Invited', action: { kind: 'resend', label: 'Resend' } });
		expect(loginLine(row(undefined), ADMIN)).toEqual({ state: 'No login', action: { kind: 'invite', label: 'Invite' } });
	});
	it('keeps Suspend and Reactivate from a Lab Admin but leaves Resend and Invite', () => {
		expect(loginLine(row('active'), LAB_ADMIN).action).toBeNull();
		expect(loginLine(row('suspended'), LAB_ADMIN)).toEqual({ state: 'Suspended', action: null });
		expect(loginLine(row('invited'), LAB_ADMIN).action?.kind).toBe('resend');
		expect(loginLine(row(undefined), LAB_ADMIN).action?.kind).toBe('invite');
	});
	it('offers a member nothing', () => {
		for (const s of ['active', 'invited', undefined]) expect(loginLine(row(s), MEMBER).action).toBeNull();
	});
	it('names an unusual status without an action', () => {
		expect(loginLine(row('draft'), ADMIN)).toEqual({ state: 'Draft', action: null });
	});
});

describe('canEditRole', () => {
	it('is for an account administrator and a person with a login', () => {
		expect(canEditRole(row('active'), ADMIN)).toBe(true);
		expect(canEditRole(row('active'), LAB_ADMIN)).toBe(false);
		expect(canEditRole(row(undefined), ADMIN)).toBe(false);
	});
});

describe('words', () => {
	it('words counts, levels and kinds', () => {
		expect(countLabel(1)).toBe('1 record');
		expect(countLabel(0)).toBe('0 records');
		expect(countLabel(14)).toBe('14 records');
		expect(levelLabel('view')).toBe('Can view');
		expect(levelLabel('edit')).toBe('Can edit');
		expect(levelLabel('pi')).toBe('Principal investigator');
		expect(levelLabel('weird')).toBe('weird');
		expect(levelLabel(null)).toBe('');
		expect(kindLabel('sample')).toBe('Sample');
		expect(kindLabel(null)).toBe('Record');
	});
});

describe('sourceNote', () => {
	const rec = (source: string | null, kind = 'project'): AccessRecord => ({
		collection: 'projects',
		id: 'x',
		kind,
		code: 'P-1',
		title: null,
		level: 'edit',
		source,
		granted_by: null,
		added_at: null,
	});
	it('lets an administrator remove a direct entry only', () => {
		expect(sourceNote(rec('access'), true)).toEqual({ remove: true });
		expect(sourceNote(rec('access'), false)).toBeNull();
	});
	it('says where the others are changed', () => {
		expect(sourceNote(rec('co_owner', 'sample'), true)).toEqual({ remove: false, text: 'co-owner (old entry)' });
		expect(sourceNote(rec('investigator_junction'), true)).toEqual({ remove: false, text: 'old entry, change on the project' });
		expect(sourceNote(rec('pi'), true)).toEqual({ remove: false, text: 'change on the project' });
		expect(sourceNote(rec('owner', 'sample'), true)).toEqual({ remove: false, text: 'change on the sample' });
	});
});

describe('escapeClosesPanel', () => {
	const esc = { key: 'Escape', defaultPrevented: false };
	it('closes on a plain Esc', () => expect(escapeClosesPanel(esc, 'BUTTON', false)).toBe(true));
	it('ignores other keys', () => expect(escapeClosesPanel({ key: 'a', defaultPrevented: false }, null, false)).toBe(false));
	it('leaves Esc to whatever already took it', () => expect(escapeClosesPanel({ key: 'Escape', defaultPrevented: true }, null, false)).toBe(false));
	it('leaves Esc to a select', () => expect(escapeClosesPanel(esc, 'SELECT', false)).toBe(false));
	it('leaves Esc to an open dialog or menu', () => expect(escapeClosesPanel(esc, null, true)).toBe(false));
});
