import { describe, expect, it } from 'vitest';
import type { RecentTeamRecord } from '@d1/ui';
import { PANEL_MORE, PANEL_SHOWN, changedLabel, panelLines, showMoreLabel } from './myTeamsPanel';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const rec = (i: number, over: Partial<RecentTeamRecord> = {}): RecentTeamRecord => ({
	collection: 'physical_samples', id: `s${i}`, kind: 'sample', code: `S-${i}`, title: `Sample ${i}`,
	team_id: 't1', team_name: 'Additive Manufacturing', team_color: 'teal', changed_at: '2026-10-14T10:00:00Z', ...over,
});
const many = (n: number) => Array.from({ length: n }, (_, i) => rec(i));

describe('changedLabel', () => {
	it('reads "changed" plus the relative time of the People page', () => {
		expect(changedLabel('2026-10-14T10:00:00Z', NOW)).toBe('changed 2 h ago');
		expect(changedLabel('2026-10-13T09:00:00Z', NOW)).toBe('changed yesterday');
		expect(changedLabel('2026-10-14T11:59:50Z', NOW)).toBe('changed just now');
	});
	it('says nothing when the time is missing or unreadable', () => {
		expect(changedLabel(null, NOW)).toBe('');
		expect(changedLabel('not a date', NOW)).toBe('');
	});
});

describe('panelLines', () => {
	it('draws nothing for no items (a person in no team, or a failed read)', () => {
		expect(panelLines([], false, NOW)).toEqual([]);
		expect(panelLines(null as any, true, NOW)).toEqual([]);
	});
	it('makes one line per record: team tile, kind chip, code, title, change time, and the record path', () => {
		const [line] = panelLines([rec(1, { collection: 'test_sessions', id: 'x/1', kind: 'test' })], false, NOW);
		expect(line).toEqual({
			key: 'test_sessions:x/1', collection: 'test_sessions', id: 'x/1', kind: 'Test', code: 'S-1', title: 'Sample 1',
			team: { name: 'Additive Manufacturing', color: 'teal' }, changed: 'changed 2 h ago',
		});
	});
	it('labels a record with no kind, code or title, and falls back to the default colour for an unknown one', () => {
		const [line] = panelLines([rec(1, { kind: null, code: null, title: null, team_color: 'chartreuse' as any, changed_at: null })], false, NOW);
		expect(line).toMatchObject({ kind: 'Record', code: 'No code', title: '', changed: '' });
		expect(line.team.color).not.toBe('chartreuse');
	});
	it('shows at most 10 lines, and up to 20 once expanded', () => {
		expect(PANEL_SHOWN).toBe(10);
		expect(PANEL_MORE).toBe(20);
		expect(panelLines(many(25), false, NOW)).toHaveLength(10);
		expect(panelLines(many(25), true, NOW)).toHaveLength(20);
		expect(panelLines(many(7), true, NOW)).toHaveLength(7);
	});
	it('keeps the order the server gave (newest first)', () => {
		expect(panelLines(many(4), false, NOW).map((l) => l.code)).toEqual(['S-0', 'S-1', 'S-2', 'S-3']);
	});
});

describe('showMoreLabel', () => {
	it('offers more only when there are more than 10 and it is not expanded', () => {
		expect(showMoreLabel(10, false)).toBeNull();
		expect(showMoreLabel(11, false)).toBe('Show more');
		expect(showMoreLabel(20, true)).toBeNull();
	});
});
