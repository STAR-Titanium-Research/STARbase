import { describe, expect, it } from 'vitest';
import { parseSummary } from '@d1/ui';
import { DEFAULT_FILTERS, EXACT_MATCH, STRENGTH_FILTER_ITEMS, parseFilters } from '../inbox/inboxModel';
import { inboxLines, inboxPanelCount, showInboxPanel } from './inboxPanel';

const T1 = '11111111-2222-4333-8444-555555555555';

describe('the Home Inbox panel', () => {
	it('says "N new files" and "N older files match a record" for the person, then for each team', () => {
		const s = parseSummary({ person: { new: 3, older_matches: 2 }, teams: [{ team_id: T1, name: 'Additive', new: 1, older_matches: 0 }] });
		expect(inboxLines(s).map((l) => [l.text, l.to, l.scope])).toEqual([
			['3 new files', '/inbox?owner=me', ''],
			['2 older files match a record', '/inbox?tab=older&strength=short_id,code&owner=me', ''],
			['1 new file', `/inbox?owner=team:${T1}`, 'Additive'],
		]);
		expect(inboxPanelCount(s)).toBe(6);
	});
	it('every "older files match a record" line opens the Inbox on the Older files tab with the Exact match filter, in the right folder', () => {
		const s = parseSummary({ person: { new: 0, older_matches: 2 }, teams: [{ team_id: T1, name: 'Additive', new: 0, older_matches: 1 }] });
		const older = inboxLines(s).filter((l) => /older file/.test(l.text));
		expect(older.map((l) => l.text)).toEqual(['2 older files match a record', '1 older file matches a record']);
		const filters = older.map((l) => parseFilters(Object.fromEntries(new URL(l.to, 'http://x').searchParams)));
		expect(filters).toEqual([
			{ ...DEFAULT_FILTERS, tab: 'older', strength: EXACT_MATCH, owner: 'me' },
			{ ...DEFAULT_FILTERS, tab: 'older', strength: EXACT_MATCH, owner: `team:${T1}` },
		]);
		expect(STRENGTH_FILTER_ITEMS.find((i) => i.value === EXACT_MATCH)?.text).toBe('Exact match');
	});
	it('draws nothing when there is nothing to say, or no answer', () => {
		expect(showInboxPanel(null)).toBe(false);
		expect(showInboxPanel(parseSummary({ person: { new: 0, older_matches: 0 }, teams: [] }))).toBe(false);
		expect(inboxPanelCount(null)).toBe(0);
		expect(showInboxPanel(parseSummary({ person: { new: 0, older_matches: 4 }, teams: [] }))).toBe(true);
	});
});
