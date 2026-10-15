import { describe, expect, it } from 'vitest';
import { badgeText, inboxLabel, inboxTarget, newFilesText, olderFilesText, parseSummary } from './inboxSummary';

describe('parseSummary', () => {
	it('reads the person, the teams and the totals', () => {
		const s = parseSummary({ person: { new: 3, older_matches: 2, has_alias: true }, teams: [{ team_id: 't1', name: 'Additive', new: 4, older_matches: 1 }], new: 7, older_matches: 3 });
		expect(s).toEqual({ person: { new: 3, older_matches: 2, has_alias: true }, teams: [{ team_id: 't1', name: 'Additive', new: 4, older_matches: 1 }], newCount: 7, olderMatches: 3 });
	});
	it('sums the person and the teams when the answer has no totals', () => {
		const s = parseSummary({ person: { new: 3, older_matches: 2 }, teams: [{ team_id: 't1', name: 'A', new: 4, older_matches: 1 }, { team_id: 't2', name: 'B', new: 1, older_matches: 0 }] });
		expect([s?.newCount, s?.olderMatches]).toEqual([8, 3]);
	});
	it('reads the wrapped form { data }', () => {
		expect(parseSummary({ data: { person: { new: 2, older_matches: 0 }, teams: [] } })?.newCount).toBe(2);
	});
	it('a missing or odd field is zero, never an error; a person with no alias says so', () => {
		const s = parseSummary({ person: { new: 'x', has_alias: false }, teams: [null, { name: 'no id' }] });
		expect(s).toEqual({ person: { new: 0, older_matches: 0, has_alias: false }, teams: [], newCount: 0, olderMatches: 0 });
		expect(parseSummary({})).toEqual({ person: null, teams: [], newCount: 0, olderMatches: 0 });
	});
	it('is null for something that is not an object', () => {
		expect(parseSummary(null)).toBeNull();
		expect(parseSummary('x')).toBeNull();
		expect(parseSummary([])).toBeNull();
	});
	it('counts a numeric string and ignores negatives', () => {
		const s = parseSummary({ person: { new: '5', older_matches: -2 } });
		expect([s?.person?.new, s?.person?.older_matches]).toEqual([5, 0]);
	});
});

describe('the words', () => {
	it('badge: nothing for none, the number, then 99+', () => {
		expect([badgeText(0), badgeText(1), badgeText(99), badgeText(100)]).toEqual(['', '1', '99', '99+']);
	});
	it('says how many, singular and plural', () => {
		expect(newFilesText(1)).toBe('1 new file');
		expect(newFilesText(12)).toBe('12 new files');
		expect(olderFilesText(1)).toBe('1 older file matches a record');
		expect(olderFilesText(3)).toBe('3 older files match a record');
		expect(inboxLabel(0)).toBe('Inbox');
		expect(inboxLabel(3)).toBe('Inbox, 3 new files');
	});
	it('sends to Older files only when nothing is new and older files match', () => {
		expect(inboxTarget(null)).toBe('/inbox');
		expect(inboxTarget({ newCount: 2, olderMatches: 5 })).toBe('/inbox');
		expect(inboxTarget({ newCount: 0, olderMatches: 5 })).toBe('/inbox?tab=older');
		expect(inboxTarget({ newCount: 0, olderMatches: 0 })).toBe('/inbox');
	});
});
