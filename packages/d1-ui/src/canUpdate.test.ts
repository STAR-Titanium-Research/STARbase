import { describe, expect, it } from 'vitest';
import { forbiddenReason, guardRefusal, itemPermissionsUrl, notOwnerMessage, updateAccess } from './canUpdate';

describe('itemPermissionsUrl', () => {
	it('builds the Directus 11 item-permissions path and encodes the key', () => {
		expect(itemPermissionsUrl('physical_samples', 'a-b')).toBe('/permissions/me/physical_samples/a-b');
		expect(itemPermissionsUrl('c', 'x/y')).toBe('/permissions/me/c/x%2Fy');
	});
});

describe('updateAccess', () => {
	it('reads update.access', () => {
		expect(updateAccess({ data: { update: { access: true }, delete: { access: false }, share: { access: false } } })).toBe(true);
		expect(updateAccess({ data: { update: { access: false } } })).toBe(false);
	});
	it('is unknown (null) for anything else, so Edit stays available', () => {
		expect(updateAccess(undefined)).toBeNull();
		expect(updateAccess({})).toBeNull();
		expect(updateAccess({ data: {} })).toBeNull();
		expect(updateAccess({ data: { update: { access: 'yes' } } })).toBeNull();
	});
});

describe('notOwnerMessage', () => {
	it('names who may change the record, per collection', () => {
		for (const c of ['physical_samples', 'manufacturing_operations', 'test_sessions', undefined]) {
			expect(notOwnerMessage(c)).toBe('Only the owner or a co-owner can change this record.');
		}
		expect(notOwnerMessage('campaigns')).toBe("Only the campaign's owner can change it.");
		expect(notOwnerMessage('projects')).toBe("Only the project's PI can change it.");
	});
});

// The two real shapes of a 403 body. Directus 11's stock ForbiddenError ALWAYS has `extensions.reason`
// (developer text naming the collection); the d1-access-guard's carries the marker, `kind` and details.
const stock = (collection = 'manufacturing_operations') => ({
	response: {
		status: 403,
		data: {
			errors: [{
				message: `You don't have permission to perform "update" for collection "${collection}" or it does not exist.`,
				extensions: { code: 'FORBIDDEN', reason: `You don't have permission to perform "update" for collection "${collection}" or it does not exist.` },
			}],
		},
	},
});
const guard = (reason: string, details: Record<string, unknown>) => ({
	response: { status: 403, data: { errors: [{ message: reason, extensions: { code: 'FORBIDDEN', reason, source: 'd1-access-guard', ...details } }] } },
});

describe('forbiddenReason', () => {
	it("ignores Directus's stock 403 even though it carries a reason, so the fallback text shows", () => {
		expect(forbiddenReason(stock())).toBeNull();
		expect(forbiddenReason({ response: { status: 403, data: { errors: [{ message: "You don't have permission", extensions: { code: 'FORBIDDEN', reason: 'anything' } }] } } })).toBeNull();
	});
	it('words the guard refusals by kind and collection', () => {
		expect(forbiddenReason(guard('x', { kind: 'owner', collection: 'physical_samples', id: 's1' }))).toBe("Only the sample's owner can hand it to someone else.");
		expect(forbiddenReason(guard('x', { kind: 'owner', collection: 'manufacturing_operations' }))).toBe("Only the operation's owner can hand it to someone else.");
		expect(forbiddenReason(guard('x', { kind: 'owner', collection: 'test_sessions' }))).toBe("Only the test's owner can hand it to someone else.");
		expect(forbiddenReason(guard('x', { kind: 'junction', collection: 'sample_co_owners', parent: 'physical_samples' }))).toBe('You can only add this to a sample you own or co-own.');
		expect(forbiddenReason(guard('x', { kind: 'junction', collection: 'campaign_samples', parent: 'campaigns' }))).toBe("Only the campaign's owner can add samples to it.");
		expect(forbiddenReason(guard('x', { kind: 'junction', collection: 'project_investigators', parent: 'projects' }))).toBe("Only the project's principal investigator can add investigators to it.");
	});
	it("falls back to the guard's own plain reason for a kind it does not know, and to null without one", () => {
		expect(forbiddenReason(guard('Plain words.', { kind: 'new-kind' }))).toBe('Plain words.');
		expect(forbiddenReason(guard('  ', { kind: 'new-kind' }))).toBeNull();
		expect(forbiddenReason(undefined)).toBeNull();
		expect(forbiddenReason({ response: { status: 500 } })).toBeNull();
	});
});

describe('guardRefusal', () => {
	it('returns the details of a marked error only', () => {
		expect(guardRefusal(guard('r', { kind: 'junction', collection: 'sample_co_owners', parent: 'physical_samples', id: 'x' }))).toEqual({
			kind: 'junction', collection: 'sample_co_owners', parent: 'physical_samples', reason: 'r',
		});
		expect(guardRefusal(stock())).toBeNull();
	});
});
