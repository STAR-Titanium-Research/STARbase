import { describe, expect, it } from 'vitest';
import { capList, ownerName, visibleFacts, type Fact } from './facts';

describe('visibleFacts', () => {
	it('drops facts with null, undefined or empty values', () => {
		const facts: Fact[] = [
			{ label: 'a', value: null },
			{ label: 'b', value: undefined },
			{ label: 'c', value: '' },
			{ label: 'd', value: 'x' },
		];
		expect(visibleFacts(facts).map((f) => f.label)).toEqual(['d']);
	});

	it('keeps zero, which is a value', () => {
		expect(visibleFacts([{ label: 'n', value: 0 }]).map((f) => f.label)).toEqual(['n']);
	});

	it('drops an empty list but keeps a non-empty one even without a value', () => {
		const facts: Fact[] = [
			{ label: 'none', value: null, list: [] },
			{ label: 'some', value: null, list: [{ label: 'A' }] },
		];
		expect(visibleFacts(facts).map((f) => f.label)).toEqual(['some']);
	});

	it('keeps a hidden fact even when it has no value', () => {
		expect(visibleFacts([{ label: 'project', value: null, hidden: true }]).map((f) => f.label)).toEqual(['project']);
	});

	it('keeps the order', () => {
		expect(visibleFacts([{ label: 'z', value: 1 }, { label: 'a', value: 2 }]).map((f) => f.label)).toEqual(['z', 'a']);
	});
});

describe('capList', () => {
	it('shows everything when there are none', () => {
		expect(capList([])).toEqual({ shown: [], more: 0 });
	});
	it('shows six of six', () => {
		const r = capList([1, 2, 3, 4, 5, 6]);
		expect(r.shown).toHaveLength(6);
		expect(r.more).toBe(0);
	});
	it('shows six of nine and counts three more', () => {
		const r = capList([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(r.shown).toEqual([1, 2, 3, 4, 5, 6]);
		expect(r.more).toBe(3);
	});
	it('takes another cap', () => {
		expect(capList([1, 2, 3], 2)).toEqual({ shown: [1, 2], more: 1 });
	});
});

describe('ownerName', () => {
	it("is the owning team's name when the record has one, else the owner person's name", () => {
		expect(ownerName({ owner_person_id: { full_name: 'Ada Owner' }, owner_team_id: null })).toBe('Ada Owner');
		expect(ownerName({ owner_person_id: null, owner_team_id: { team_id: 't1', name: 'Additive' } })).toBe('Additive');
		expect(ownerName({ owner_person_id: { full_name: 'Ada Owner' } })).toBe('Ada Owner');
	});

	it('is empty for no owner, and for a team the reader cannot read (a bare id)', () => {
		expect(ownerName({ owner_person_id: null, owner_team_id: null })).toBe('');
		expect(ownerName({ owner_person_id: null, owner_team_id: 't1' })).toBe('');
		expect(ownerName(null)).toBe('');
	});
});
