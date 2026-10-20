import { describe, expect, it } from 'vitest';
import type { BulkActionRow, BulkActionSummary } from './bulkApi';
import type { RevertRow } from './bulkModel';
import {
	PAGE_SIZE, actionWords, actorText, canRevert, countsText, detailLines, headline, kindLabel, linesById, listFailedText, mergePage, moreFailedText, revertConfirm,
	revertFailedText, revertLines, revertSummary, rowsFailedText, stateBadge, whenText, whenTitle,
} from './adminBulkModel';

const line = (over: Partial<BulkActionSummary> = {}): BulkActionSummary => ({
	action_id: 'a1', actor_user: 'u1', actor_name: 'Ann Lee', collection: 'physical_samples', kind: 'assign_team', params: { team_id: 't1' }, state: 'applied',
	created_at: '2026-10-20T10:00:00Z', undo_until: '2026-10-20T10:01:00Z', revert_of: null, mail_state: 'sent', n_applied: 38, n_skipped: 12, n_failed: 0, ...over,
});

describe('actionWords', () => {
	it('says what each kind did, with the counts of what changed', () => {
		expect(actionWords(line())).toBe('Assigned 38 samples to a team');
		expect(actionWords(line({ kind: 'change_owner', params: { person_id: 'p1' }, n_applied: 1 }))).toBe('Changed the owner of 1 sample');
		expect(actionWords(line({ kind: 'share_access', collection: 'manufacturing_operations', params: { person_id: 'p1', role: 'edit' }, n_applied: 12 }))).toBe(
			'Shared 12 operations with a person (Can edit)',
		);
		expect(actionWords(line({ kind: 'share_access', collection: 'manufacturing_operations', params: { team_id: 't1', role: 'view' }, n_applied: 2 }))).toBe(
			'Shared 2 operations with a team (Can view)',
		);
		expect(actionWords(line({ kind: 'remove_access', collection: 'test_sessions', params: { team_id: 't1' }, n_applied: 3 }))).toBe('Removed access for a team on 3 tests');
		expect(actionWords(line({ kind: 'restrict', params: {}, n_applied: 5 }))).toBe('Restricted 5 samples');
		expect(actionWords(line({ kind: 'unrestrict', collection: 'campaigns', params: {}, n_applied: 1 }))).toBe('Unrestricted 1 campaign');
	});

	it('words a field edit with the value, "Cleared" for null, and never an id for a link', () => {
		const edit = (collection: string, params: Record<string, unknown>, n = 4) => actionWords(line({ kind: 'edit_field', collection, params, n_applied: n }));
		expect(edit('physical_samples', { field: 'current_status', value: 'archived' }, 38)).toBe('Set status to Archived on 38 samples');
		expect(edit('test_sessions', { field: 'status', value: 'pending_processing' })).toBe('Set status to Pending processing on 4 tests');
		expect(edit('physical_samples', { field: 'mounted', value: true })).toBe('Set mounted to Yes on 4 samples');
		expect(edit('manufacturing_operations', { field: 'planned_date', value: '2026-11-03' })).toBe('Set planned date to 3 Nov 2026 on 4 operations');
		expect(edit('manufacturing_operations', { field: 'campaign_id', value: '8c2f0d6e-1111-2222-3333-444455556666' })).toBe('Set campaign on 4 operations');
		expect(edit('campaigns', { field: 'end_date', value: null }, 1)).toBe('Cleared end date on 1 campaign');
		expect(edit('campaigns', { field: 'mystery_field', value: 'x' })).toBe('Set mystery field on 4 campaigns');
	});

	it('keeps what the action was when nothing changed', () => {
		expect(actionWords(line({ n_applied: 0, n_skipped: 12, n_failed: 1 }))).toBe('Assign to team on 13 samples: nothing was changed');
		expect(actionWords(line({ n_applied: 0, n_skipped: 0, kind: 'edit_field', params: { field: 'current_status', value: 'active' } }))).toBe('Edit status: nothing was changed');
	});

	it('says "records" for a collection with no index page', () => {
		expect(actionWords(line({ collection: 'projects', n_applied: 2 }))).toBe('Assigned 2 records to a team');
	});
});

describe('kindLabel', () => {
	it('names the action in a few words', () => {
		expect(kindLabel(line())).toBe('Assign to team');
		expect(kindLabel(line({ kind: 'share_access' }))).toBe('Share or change access');
		expect(kindLabel(line({ kind: 'edit_field', collection: 'campaigns', params: { field: 'start_date' } }))).toBe('Edit start date');
		expect(kindLabel(line({ kind: 'edit_field', params: { field: 'odd_one' } }))).toBe('Edit odd one');
		expect(kindLabel(line({ kind: 'frobnicate' }))).toBe('Frobnicate');
	});
});

describe('headline, revert lines', () => {
	const original = line({ action_id: 'orig' });
	const revert = line({ action_id: 'rev', revert_of: 'orig', n_applied: 30, n_skipped: 8 });
	it('names the original in a revert, when it is among the lines', () => {
		expect(headline(revert, linesById([original, revert]))).toBe('Revert of \u2018Assigned 38 samples to a team\u2019');
		expect(headline(original)).toBe('Assigned 38 samples to a team');
	});
	it('says "an earlier action" when the original is not loaded', () => {
		expect(headline(revert)).toBe('Revert of an earlier action on samples');
		expect(headline(line({ revert_of: 'x', collection: 'projects' }))).toBe('Revert of an earlier action on records');
	});
});

describe('stateBadge', () => {
	it('words each state, and a revert as its own kind of line', () => {
		expect(stateBadge(line())).toEqual({ label: 'Applied', tone: 'ok' });
		expect(stateBadge(line({ state: 'undone' }))).toEqual({ label: 'Undone', tone: 'dim' });
		expect(stateBadge(line({ state: 'reverted' }))).toEqual({ label: 'Reverted', tone: 'dim' });
		expect(stateBadge(line({ state: 'partly_reverted' }))).toEqual({ label: 'Partly reverted', tone: 'warn' });
		expect(stateBadge(line({ state: 'applied', revert_of: 'x' }))).toEqual({ label: 'Revert', tone: 'dim' });
		expect(stateBadge(line({ state: 'weird_state' })).label).toBe('Weird state');
		expect(stateBadge(line({ state: '' })).label).toBe('Unknown');
	});
});

describe('countsText', () => {
	it('counts changed, not changed and failed, leaving zeros out', () => {
		expect(countsText(line())).toBe('38 changed, 12 not changed');
		expect(countsText(line({ n_skipped: 0, n_failed: 2 }))).toBe('38 changed, 2 failed');
		expect(countsText(line({ n_applied: 0, n_skipped: 0 }))).toBe('0 changed');
	});
	it("counts a revert's own rows", () => {
		expect(countsText(line({ revert_of: 'x', n_applied: 5, n_skipped: 2, n_failed: 1 }))).toBe('5 put back, 2 left as they are, 1 failed');
		expect(countsText(line({ revert_of: 'x', n_applied: 5, n_skipped: 1 }))).toBe('5 put back, 1 left as it is');
	});
});

describe('who and when', () => {
	const now = Date.parse('2026-10-20T12:00:00Z');
	it('uses the Home helper for the relative time', () => {
		expect(whenText(line(), now)).toBe('2 h ago');
		expect(whenText(line({ created_at: 'bad' }), now)).toBe('');
	});
	it('gives the exact moment for a tooltip, and nothing for an unreadable one', () => {
		expect(whenTitle('2026-10-20T10:00:00Z')).toMatch(/^20 Oct 2026, \d\d:\d\d$/);
		expect(whenTitle('nope')).toBe('');
	});
	it('says Someone for an actor with no name', () => {
		expect(actorText({ actor_name: ' Ann Lee ' })).toBe('Ann Lee');
		expect(actorText({ actor_name: '' })).toBe('Someone');
	});
});

describe('canRevert', () => {
	it('offers Revert on an applied or partly reverted action that changed something', () => {
		expect(canRevert(line())).toBe(true);
		expect(canRevert(line({ state: 'partly_reverted' }))).toBe(true);
	});
	it('does not offer it on an undone or reverted action, a revert, or an action that changed nothing', () => {
		expect(canRevert(line({ state: 'undone' }))).toBe(false);
		expect(canRevert(line({ state: 'reverted' }))).toBe(false);
		expect(canRevert(line({ revert_of: 'x' }))).toBe(false);
		expect(canRevert(line({ n_applied: 0 }))).toBe(false);
		expect(canRevert(line({ state: 'weird' }))).toBe(false);
	});
});

describe('mergePage', () => {
	it('appends a page and keeps a line that a new action shifted onto it only once', () => {
		const a = (id: string) => line({ action_id: id });
		expect(PAGE_SIZE).toBe(25);
		expect(mergePage([a('1'), a('2')], [a('2'), a('3'), a('3')]).map((x) => x.action_id)).toEqual(['1', '2', '3']);
		expect(mergePage([], [a('1')]).map((x) => x.action_id)).toEqual(['1']);
	});
});

describe('detailLines', () => {
	const row = (over: Partial<BulkActionRow> = {}): BulkActionRow => ({ record_id: 'r1', record_code: 'S-1', outcome: 'applied', revert_outcome: null, ...over });
	it('words the outcome, the reason and what a revert did, per record', () => {
		const lines = detailLines(line(), [
			row(),
			row({ record_id: 'r2', record_code: 'S-2', outcome: 'skipped', reason: 'You are not the owner of this record.' }),
			row({ record_id: 'r3', record_code: 'S-3', outcome: 'noop' }),
			row({ record_id: 'r4', record_code: 'S-4', outcome: 'failed', reason: 'Something went wrong changing this record.' }),
			row({ record_id: 'r5', record_code: 'S-5', revert_outcome: 'reverted' }),
			row({ record_id: 'r6', record_code: 'S-6', revert_outcome: 'changed_since', revert_reason: 'Changed since this action ran, so it was left alone.' }),
			row({ record_id: 'r7', record_code: 'S-7', revert_outcome: 'refused', revert_reason: 'The team that owned this record has no manager now.' }),
		]);
		expect(lines.map((l) => [l.code, l.result.label, l.reason, l.revert?.label ?? null, l.revert?.reason ?? null])).toEqual([
			['S-1', 'Changed', '', null, null],
			['S-2', 'Skipped', 'You are not the owner of this record', null, null],
			['S-3', 'No change needed', '', null, null],
			['S-4', 'Failed', 'Something went wrong changing this record', null, null],
			['S-5', 'Changed', '', 'Reverted', ''],
			['S-6', 'Changed', '', 'Changed since', 'Changed since, so it was left as it is'],
			['S-7', 'Changed', '', 'Refused', 'The team that owned this record has no manager now'],
		]);
	});
	it('words the rows of a revert as put back or left as they are, with no revert column', () => {
		const lines = detailLines(line({ revert_of: 'x' }), [row({ revert_outcome: 'reverted' }), row({ record_id: 'r2', outcome: 'skipped', reason: 'Changed since this action ran, so it was left alone.' })]);
		expect(lines.map((l) => [l.result.label, l.revert])).toEqual([['Put back', null], ['Left as it is', null]]);
		expect(lines[1].reason).toBe('Changed since this action ran, so it was left alone');
	});
});

describe('the revert dialog', () => {
	it('says what is reverted, by whom and when, and the two cautions', () => {
		const c = revertConfirm(line());
		expect(c.title).toBe('Revert this bulk action?');
		expect(c.confirm).toBe('Revert 38 samples');
		expect(c.paragraphs[0]).toMatch(/^Assigned 38 samples to a team, by Ann Lee on 20 Oct 2026, \d\d:\d\d\.$/);
		expect(c.paragraphs[1]).toBe('Reverting puts 38 samples back as they were before.');
		expect(c.paragraphs[2]).toContain('changed since this action ran is skipped and left as it is');
		expect(c.paragraphs[3]).toBe('A revert cannot be reverted. To change the records again, run the action again.');
	});
	it('says a partly reverted action tries again for the rest', () => {
		expect(revertConfirm(line({ state: 'partly_reverted' })).paragraphs[1]).toContain('tries again for the records not yet put back');
	});
	it('words the per-record result, the ones not put back first', () => {
		const results: RevertRow[] = [
			{ id: '1', code: 'S-1', revert_outcome: 'reverted' },
			{ id: '2', code: 'S-2', revert_outcome: 'changed_since' },
			{ id: '3', revert_outcome: 'refused', reason: 'The team that owned this record has no manager now.' },
			{ id: '4', code: 'S-4', revert_outcome: 'failed' },
			{ id: '5', code: 'S-5', revert_outcome: 'reverted' },
		];
		expect(revertLines(results).map((l) => [l.code, l.result.label, l.result.tone, l.reason])).toEqual([
			['S-4', 'Failed', 'bad', 'Could not be undone'],
			['3', 'Refused', 'bad', 'The team that owned this record has no manager now'],
			['S-2', 'Changed since', 'warn', 'Changed since, so it was left as it is'],
			['S-1', 'Reverted', 'ok', ''],
			['S-5', 'Reverted', 'ok', ''],
		]);
		expect(revertSummary(results, 'physical_samples')).toBe('Put back 2 of 5 samples. 1 changed since, 1 refused, 1 failed.');
		expect(revertSummary([{ id: '1', revert_outcome: 'changed_since' }], 'campaigns')).toBe('Nothing was put back. 1 changed since.');
		expect(revertSummary([{ id: '1', revert_outcome: 'reverted' }], 'campaigns')).toBe('Put back 1 of 1 campaign.');
	});
});

describe('failure wording says what failed and what to do next', () => {
	it('adds the stop and the next step', () => {
		expect(listFailedText('Network Error')).toBe('The bulk actions could not be loaded: Network Error. Try Reload in a moment.');
		expect(moreFailedText('Boom.')).toBe('The next bulk actions could not be loaded: Boom. Press Show more to try again.');
		expect(rowsFailedText('Not found')).toContain('Close it and open it again.');
		expect(revertFailedText('A revert cannot be reverted. Run the action again instead.')).toBe(
			'The revert failed: A revert cannot be reverted. Run the action again instead. The list has been reloaded; check it before you try again.',
		);
	});
});
