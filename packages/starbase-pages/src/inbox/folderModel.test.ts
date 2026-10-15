import { describe, expect, it } from 'vitest';
import {
	ALIAS_RE, ALIAS_TAKEN, FOLDER_CHANGE_NOTE, SHARE_FOLDER_TAKEN, aliasProblem, clean, folderPatch, folderSaveError, isDuplicateOf, shareFolderProblem,
} from './folderModel';

describe('aliasProblem (the database rule: 2 to 64 of [A-Za-z0-9._-], never starting with a dot)', () => {
	it('accepts a real alias, a hyphen or underscore first, 64 characters, and an empty one', () => {
		for (const ok of ['abc12de', 'ab', 'a.b', '_ab', '-ab', 'A1_b-c.d', 'a'.repeat(64), '', null, undefined, '  ab1cd  ']) expect(aliasProblem(ok), String(ok)).toBeNull();
	});
	it('refuses one character, 65, a slash, a space inside, a leading dot and only dots', () => {
		expect(aliasProblem('a')).toBe('A uni alias is at least 2 characters.');
		expect(aliasProblem('a'.repeat(65))).toBe('A uni alias is at most 64 characters.');
		expect(aliasProblem('a/b')).toBe('Use letters, digits, dots, underscores and hyphens only.');
		expect(aliasProblem('a b')).toBe('Use letters, digits, dots, underscores and hyphens only.');
		expect(aliasProblem('..')).toBe('A uni alias cannot be only dots.');
		expect(aliasProblem('.ab')).toBe('A uni alias cannot start with a dot.');
		expect(aliasProblem('ab\\cd')).not.toBeNull();
	});
	it('agrees with the regular expression on every case above', () => {
		const cases = ['abc12de', 'ab', 'a.b', '_ab', '-ab', 'a', '.ab', '..', 'a/b', 'a b', 'a'.repeat(64), 'a'.repeat(65)];
		for (const c of cases) expect(aliasProblem(c) === null, c).toBe(ALIAS_RE.test(c));
	});
});

describe('shareFolderProblem', () => {
	it('accepts a folder name with spaces inside and an empty one', () => {
		for (const ok of ['Additive', 'Old project', 'a.b', '', null, undefined]) expect(shareFolderProblem(ok), String(ok)).toBeNull();
	});
	it('refuses slashes, backslashes, blank and only dots', () => {
		expect(shareFolderProblem('x/y')).toContain('no slashes');
		expect(shareFolderProblem('x\\y')).toContain('no slashes');
		expect(shareFolderProblem('   ')).toBe('A share folder cannot be blank.');
		expect(shareFolderProblem('..')).toBe('A share folder cannot be only dots.');
	});
});

describe('what to send', () => {
	it('trims, sends only a change, and sends an empty value as null', () => {
		expect(clean('  ab1cd ')).toBe('ab1cd');
		expect(folderPatch('uni_alias', ' ab1cd ', null)).toEqual({ uni_alias: 'ab1cd' });
		expect(folderPatch('uni_alias', 'ab1cd', 'ab1cd')).toEqual({});
		expect(folderPatch('uni_alias', '', 'ab1cd')).toEqual({ uni_alias: null });
		expect(folderPatch('uni_alias', '  ', null)).toEqual({});
		expect(folderPatch('share_folder', 'Additive', 'Old')).toEqual({ share_folder: 'Additive' });
	});
	it('words the reset note as the coordinator asked', () => {
		expect(FOLDER_CHANGE_NOTE).toBe('Changing this resets the Inbox for this folder; linked files stay linked.');
	});
});

describe('a refused save', () => {
	const failure = (message: string, code?: string, field?: string) =>
		Object.assign(new Error('Request failed'), { response: { status: 400, data: { errors: [{ message, extensions: { ...(code ? { code } : {}), ...(field ? { field } : {}) } }] } } });
	it('a unique violation is told by the field it names, and names no one', () => {
		const e = failure('Value for field "uni_alias" in collection "people" has to be unique.', 'RECORD_NOT_UNIQUE', 'uni_alias');
		expect(isDuplicateOf(e, /uni_alias/)).toBe(true);
		expect(folderSaveError(e, 'alias', 'x')).toBe(ALIAS_TAKEN);
		expect(folderSaveError(failure('x', 'RECORD_NOT_UNIQUE', 'share_folder'), 'share_folder', 'x')).toBe(SHARE_FOLDER_TAKEN);
		expect(ALIAS_TAKEN).not.toMatch(/@/);
	});
	it('another unique column (people.user_id: a login already linked) is not "alias taken", whatever the message says', () => {
		const e = failure('Value for field "user_id" in collection "people" has to be unique. (the alias is unique too)', 'RECORD_NOT_UNIQUE', 'user_id');
		expect(isDuplicateOf(e, /uni_alias/)).toBe(false);
		expect(folderSaveError(e, 'alias', 'x')).toContain('user_id');
		// even with `only`: the answer names a field, and it is not this one
		expect(isDuplicateOf(e, /uni_alias/, { only: true })).toBe(false);
	});
	it('the message text alone never says duplicate: a failure that is not RECORD_NOT_UNIQUE is shown as the server wrote it', () => {
		const e = failure('duplicate key value violates unique constraint "people_uni_alias_key"');
		expect(isDuplicateOf(e, /uni_alias/)).toBe(false);
		expect(folderSaveError(e, 'alias', 'x')).toBe('duplicate key value violates unique constraint "people_uni_alias_key"');
	});
	it('with no field in the answer, `only` says the request changed just this one column', () => {
		const e = failure('has to be unique', 'RECORD_NOT_UNIQUE');
		expect(isDuplicateOf(e, /uni_alias/)).toBe(false);
		expect(isDuplicateOf(e, /uni_alias/, { only: true })).toBe(true);
		expect(folderSaveError(e, 'alias', 'x', { only: true })).toBe(ALIAS_TAKEN);
	});
	it("another failure shows the server's own words, or the fallback", () => {
		expect(folderSaveError(failure('You do not have permission to access this.'), 'alias', 'x')).toBe('You do not have permission to access this.');
		expect(folderSaveError({}, 'alias', 'Could not save the alias.')).toBe('Could not save the alias.');
		expect(isDuplicateOf({}, /uni_alias/)).toBe(false);
	});
});
