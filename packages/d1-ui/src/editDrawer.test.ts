import { describe, expect, it } from 'vitest';
import { buildPatch, formFields, saveErrors, versionChanged, type FieldDef } from './editDrawer';

const defs: FieldDef[] = [
	{ field: 'sample_id', schema: { is_primary_key: true } },
	{ field: 'sample_code', schema: {} },
	{ field: 'owner', schema: {} }, // not readable by this user: absent from the item
	{ field: 'data_files_open', schema: null, type: 'alias' }, // interface only
	{ field: 'date_created', schema: {}, meta: { system: true } },
];

describe('formFields', () => {
	it('keeps readable columns and interface-only fields, drops unreadable and system ones', () => {
		const item = { sample_id: 'a', sample_code: 'X', date_created: 'now' };
		expect(formFields(defs, item).map((f) => f.field)).toEqual(['sample_id', 'sample_code', 'data_files_open']);
	});

	it('leaves out the fields a page asks to hide', () => {
		const item = { sample_id: 'a', sample_code: 'X' };
		expect(formFields(defs, item, ['data_files_open', 'sample_code']).map((f) => f.field)).toEqual(['sample_id']);
	});

	it('shows nothing before the item has loaded', () => {
		expect(formFields(defs, null)).toEqual([]);
	});
});

describe('buildPatch', () => {
	it('sends only the changed fields', () => {
		expect(buildPatch({ nickname: 'bar', mass_grams: 4 })).toEqual({ nickname: 'bar', mass_grams: 4 });
	});

	it('keeps null (clearing a field) but drops undefined', () => {
		expect(buildPatch({ nickname: null, notes: undefined })).toEqual({ nickname: null });
	});

	it('is null when nothing changed', () => {
		expect(buildPatch({})).toBeNull();
		expect(buildPatch(null)).toBeNull();
		expect(buildPatch({ a: undefined })).toBeNull();
	});
});

describe('versionChanged', () => {
	it('detects a save by someone else', () => {
		expect(versionChanged(3, 4)).toBe(true);
		expect(versionChanged('3', 3)).toBe(false);
	});

	it('does not warn when either side has no version', () => {
		expect(versionChanged(undefined, 4)).toBe(false);
		expect(versionChanged(3, null)).toBe(false);
	});
});

describe('saveErrors', () => {
	it('lists every Directus error', () => {
		const e = { response: { data: { errors: [{ message: 'one' }, { message: 'two' }] } } };
		expect(saveErrors(e)).toEqual(['one', 'two']);
	});

	it('replaces a refusal with the owner-or-co-owner message', () => {
		const status403 = { response: { status: 403, data: { errors: [{ message: "You don't have permission to access this." }] } } };
		expect(saveErrors(status403)).toEqual(['Only the owner or a co-owner can change this record.']);
		const code = { response: { data: { errors: [{ message: 'x', extensions: { code: 'FORBIDDEN' } }] } } };
		expect(saveErrors(code)).toEqual(['Only the owner or a co-owner can change this record.']);
	});

	it("shows the guard's refusal in plain words (the real guard shape)", () => {
		const reason = "Only the sample's owner can hand it to someone else.";
		const e = {
			response: { status: 403, data: { errors: [{ message: reason, extensions: { code: 'FORBIDDEN', reason, source: 'd1-access-guard', kind: 'owner', collection: 'physical_samples', id: 's1' } }] } },
		};
		expect(saveErrors(e, 'physical_samples')).toEqual([reason]);
	});

	it("does not show Directus's stock 403 reason (developer text); it falls back to the collection's wording", () => {
		const message = 'You don\'t have permission to perform "update" for collection "manufacturing_operations" or it does not exist.';
		const e = { response: { status: 403, data: { errors: [{ message, extensions: { code: 'FORBIDDEN', reason: message } }] } } };
		expect(saveErrors(e, 'manufacturing_operations')).toEqual(['Only the owner or a co-owner can change this record.']);
		expect(saveErrors(e, 'campaigns')).toEqual(["Only the campaign's owner can change it."]);
	});

	it('words a reasonless refusal for the collection', () => {
		const e = { response: { status: 403, data: { errors: [{ message: "You don't have permission to access this." }] } } };
		expect(saveErrors(e, 'campaigns')).toEqual(["Only the campaign's owner can change it."]);
		expect(saveErrors(e, 'projects')).toEqual(["Only the project's PI can change it."]);
		expect(saveErrors(e, 'test_sessions')).toEqual(['Only the owner or a co-owner can change this record.']);
	});

	it('falls back to the error message', () => {
		expect(saveErrors(new Error('offline'))).toEqual(['offline']);
		expect(saveErrors({})).toEqual(['The record could not be saved.']);
	});
});
