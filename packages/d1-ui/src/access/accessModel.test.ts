import { describe, expect, it } from 'vitest';
import { recordRoute } from '../recordRoute';
import {
	initials, RECORD_LINK_KINDS, RESTRICT_UI, ROLE_LABELS, addable, blockedText, canChangeRole, emailNote, entryLabel, isAccessCollection, isLoginless,
	noManagerText, ownerWord, peopleSearchQuery, piNote, showInherited, sortEntries, transferConfirmText, type AccessEntry,
} from './accessModel';

const entry = (over: Partial<AccessEntry> = {}): AccessEntry => ({
	person_id: 'p1', name: 'Edith Ford', role: 'view', source: 'access', can_sign_in: true, added_by: null, added_at: null, blocked_by: null, ...over,
});

describe('role labels', () => {
	it('offers Can view and Can edit on samples, operations, tests and campaigns', () => {
		for (const c of ['physical_samples', 'manufacturing_operations', 'test_sessions', 'campaigns']) {
			expect(ROLE_LABELS(c).map((r) => [r.role, r.label])).toEqual([['view', 'Can view'], ['edit', 'Can edit']]);
		}
	});
	it('offers Can view and Secondary investigator only on projects', () => {
		expect(ROLE_LABELS('projects').map((r) => [r.role, r.label])).toEqual([['view', 'Can view'], ['investigator', 'Secondary investigator']]);
	});
	it('reads a sample Can edit as a co-owner, whatever table it came from', () => {
		expect(entryLabel(entry({ role: 'edit' }), 'physical_samples')).toBe('Co-owner · can edit');
		expect(entryLabel(entry({ role: 'edit', source: 'co_owner' }), 'physical_samples')).toBe('Co-owner · can edit');
		expect(entryLabel(entry({ role: 'edit' }), 'campaigns')).toBe('Can edit');
		expect(entryLabel(entry({ role: 'view' }), 'projects')).toBe('Can view');
		expect(entryLabel(entry({ role: 'investigator', source: 'investigator' }), 'projects')).toBe('Secondary investigator');
	});
	it('calls a project owner the principal investigator', () => {
		expect(ownerWord('projects')).toBe('Principal investigator');
		expect(ownerWord('physical_samples')).toBe('Owner');
	});
	it('knows the five collections', () => {
		expect(isAccessCollection('projects')).toBe(true);
		expect(isAccessCollection('people')).toBe(false);
	});
});

describe('sortEntries', () => {
	it('puts stronger roles first, then by name, without changing the input', () => {
		const input = [
			entry({ name: 'Zed', role: 'view' }), entry({ name: 'Bea', role: 'view' }), entry({ name: 'Mo', role: 'edit' }), entry({ name: 'Al', role: 'investigator' }),
		];
		expect(sortEntries(input).map((e) => e.name)).toEqual(['Al', 'Mo', 'Bea', 'Zed']);
		expect(input[0].name).toBe('Zed');
	});
});

describe('canChangeRole', () => {
	it('needs a manager and a person the endpoint can address', () => {
		expect(canChangeRole(entry(), true)).toBe(true);
		expect(canChangeRole(entry(), false)).toBe(false);
		expect(canChangeRole(entry({ person_id: null }), true)).toBe(false); // an old row whose login has no People row
	});
});

describe('initials', () => {
	it('takes the first letter of the first and last word', () => {
		expect(initials('Edith Ford')).toBe('EF');
		expect(initials('  ada  king byron ')).toBe('AB');
		expect(initials('Madonna')).toBe('M');
		expect(initials('')).toBe('?');
	});
});

describe('people search', () => {
	it('asks for active people by name, by name order, with a limit and no email', () => {
		const q = peopleSearchQuery('  edi ', 5);
		expect(q.filter).toEqual({ _and: [{ active: { _eq: true } }, { full_name: { _icontains: 'edi' } }] });
		expect(q.limit).toBe(5);
		expect(q.sort).toEqual(['full_name']);
		expect(q.fields).toEqual(['person_id', 'full_name', 'user_id']);
	});
	it('marks a person with no login', () => {
		expect(isLoginless({ user_id: null })).toBe(true);
		expect(isLoginless({ user_id: 'u1' })).toBe(false);
		expect(isLoginless({ can_sign_in: false })).toBe(true);
		expect(isLoginless({ can_sign_in: true })).toBe(false);
	});
	it('leaves out people who are on the list already, the owner included', () => {
		const hits = [{ person_id: 'o', full_name: 'Owen' }, { person_id: 'p1', full_name: 'Edith' }, { person_id: 'p9', full_name: 'Nina' }];
		const list = { owner: { person_id: 'o', name: 'Owen', can_sign_in: true }, entries: [entry({ person_id: 'p1' }), entry({ person_id: null })] };
		expect(addable(hits, list).map((h) => h.person_id)).toEqual(['p9']);
	});
});

describe('texts', () => {
	it('words the transfer for the owner, an admin, and a record with no owner', () => {
		expect(transferConfirmText('Ada', 'Charles', 'physical_samples')).toBe(
			'Charles becomes the owner. You stay on the record as Can edit. Only the new owner can change who has access.',
		);
		expect(transferConfirmText('Ada', 'Charles', 'physical_samples', false)).toContain('Ada stays on the record as Can edit.');
		expect(transferConfirmText('Dr Ibis', 'Charles', 'projects')).toBe(
			'Charles becomes the principal investigator. You stay on the record as Secondary investigator. Only the new principal investigator can change who has access.',
		);
		const noOwner = transferConfirmText(null, 'Charles', 'campaigns');
		expect(noOwner).toBe('Charles becomes the owner. Only the new owner can change who has access.');
		expect(noOwner).not.toContain('stay');
	});
	it('says who can change the list when the viewer cannot', () => {
		expect(noManagerText({ name: 'Ada Byron' })).toBe('Only Ada Byron can change who has access.');
		expect(noManagerText(null)).toBe('Only an admin can change who has access.');
	});
	it('says why a grant will not take effect', () => {
		expect(blockedText(entry())).toBeNull();
		expect(blockedText(entry({ blocked_by: { collection: 'projects', id: 'x', kind: 'project', code: 'P-7' } }))).toBe(
			'Edith Ford cannot see project P-7, so this will not take effect until its owner adds them.',
		);
		expect(blockedText(entry({ blocked_by: { collection: 'campaigns', id: 'x', kind: 'campaign', code: null } }))).toContain('cannot see campaign,');
	});
	it('names the project PI on a record inside a project, not on the project itself', () => {
		const list = { project_pi: { person_id: 'q', name: 'Dr Ibis Jones', can_sign_in: true } };
		expect(piNote(list, 'physical_samples')).toBe('Project PI: Dr Ibis Jones, sees everything in the project.');
		expect(piNote(list, 'projects')).toBeNull();
		expect(piNote({ project_pi: null }, 'campaigns')).toBeNull();
	});
	it('mentions a failed email, and only a failed one', () => {
		expect(emailNote('failed', 'added')).toBe('Added. The email could not be sent.');
		expect(emailNote('failed', 'owner')).toContain('could not be sent');
		expect(emailNote('sent', 'added')).toBeNull();
		expect(emailNote('skipped', 'added')).toBeNull();
		expect(emailNote(undefined, 'added')).toBeNull();
	});
});

describe('inheritance', () => {
	it('shows the sample list under an operation or test only when neither is restricted', () => {
		expect(showInherited({ restricted: false }, { restricted: false })).toBe(true);
		expect(showInherited({ restricted: true }, { restricted: false })).toBe(false);
		expect(showInherited({ restricted: false }, { restricted: true })).toBe(false);
		expect(showInherited({ restricted: false }, null)).toBe(false);
	});
});

describe('the Restrict switch', () => {
	it('is off in A1a (A1b flips this deliberately)', () => {
		expect(RESTRICT_UI).toBe(false);
	});
});

describe('RECORD_LINK_KINDS', () => {
	it('matches the Explorer routes of recordRoute', () => {
		const collections: Record<string, string> = {
			sample: 'physical_samples', operation: 'manufacturing_operations', test: 'test_sessions', campaign: 'campaigns', project: 'projects',
		};
		expect(Object.keys(RECORD_LINK_KINDS).sort()).toEqual(Object.keys(collections).sort());
		for (const [kind, collection] of Object.entries(collections)) {
			expect(recordRoute(collection, 'abc')).toBe(`/home/${RECORD_LINK_KINDS[kind]}/abc`);
		}
	});
});
