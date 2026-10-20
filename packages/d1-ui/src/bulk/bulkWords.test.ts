import { describe, expect, it } from 'vitest';
import { indexDefBySlug, INDEX_DEFS } from '../index/indexConfig';
import type { PreviewRow } from './bulkModel';
import { bulkEntries, dialogTitle, paramsFor, resultText, skipReasonText, startToast, toastAnnouncement, dismissDelay, tickToast } from './bulkModel';
import {
	accessSentence, isAccessKind, roleChoices, roleLabel, targetHint, targetKindOf, takesRole, warnedAfter, warnedQuestion, warnedRows, warnedSummary,
} from './bulkWords';

const samples = indexDefBySlug('samples')!;
const operations = indexDefBySlug('operations')!;
const entry = (id: string, def = samples) => bulkEntries(def).find((e) => e.id === id)!;
const ACCESS = ['assign_team', 'change_owner', 'share_access', 'remove_access'];

describe('the access entries per list', () => {
	it('are offered on every ownable list and on no other', () => {
		for (const def of INDEX_DEFS) {
			const ids = bulkEntries(def).map((e) => e.id);
			for (const id of ACCESS) expect(ids.includes(id), `${def.slug} ${id}`).toBe(!!def.ownable);
		}
	});
	it('are not offered to a Lab Viewer', () => {
		expect(bulkEntries(samples, { viewer: true }).some((e) => ACCESS.includes(e.id))).toBe(false);
	});
	it('say which target they need', () => {
		expect(ACCESS.map((k) => targetKindOf(k))).toEqual(['team', 'person', 'either', 'either']);
		expect(targetKindOf('restrict')).toBeNull();
		expect(isAccessKind('share_access')).toBe(true);
		expect(isAccessKind('edit_field')).toBe(false);
		expect(takesRole('share_access')).toBe(true);
		expect(takesRole('remove_access')).toBe(false);
		expect(targetHint('assign_team')).toContain('team');
		expect(targetHint('change_owner')).toContain('person');
	});
});

describe('access params', () => {
	it('wait for a target', () => {
		for (const k of ACCESS) expect(paramsFor(entry(k), null)).toBeNull();
		expect(paramsFor(entry('assign_team'), { value: null })).toBeNull();
	});
	it('name the team or the person the way the endpoint expects', () => {
		expect(paramsFor(entry('assign_team'), { value: 't1', target: 'team' })).toEqual({ team_id: 't1' });
		expect(paramsFor(entry('change_owner'), { value: 'p1', target: 'person' })).toEqual({ person_id: 'p1' });
		expect(paramsFor(entry('remove_access'), { value: 'p1', target: 'person' })).toEqual({ person_id: 'p1' });
		expect(paramsFor(entry('remove_access'), { value: 't1', target: 'team' })).toEqual({ team_id: 't1' });
	});
	it('give Share the access level, Can view until another is chosen', () => {
		expect(paramsFor(entry('share_access'), { value: 'p1', target: 'person' })).toEqual({ person_id: 'p1', role: 'view' });
		expect(paramsFor(entry('share_access'), { value: 'p1', target: 'person' }, 'edit')).toEqual({ person_id: 'p1', role: 'edit' });
		expect(paramsFor(entry('share_access'), { value: 't1', target: 'team' }, 'edit')).toEqual({ team_id: 't1', role: 'edit' });
	});
});

describe('access wording', () => {
	it('titles each dialog before a target is chosen', () => {
		expect(dialogTitle(entry('assign_team'), samples, 38)).toBe('Assign 38 samples to a team');
		expect(dialogTitle(entry('change_owner'), samples, 1)).toBe('Change the owner of 1 sample');
		expect(dialogTitle(entry('share_access', operations), operations, 12)).toBe('Share or change access to 12 operations');
		expect(dialogTitle(entry('remove_access'), samples, 2)).toBe('Remove access to 2 samples');
	});
	it('says what the preview confirms once a target is chosen', () => {
		expect(accessSentence('assign_team', samples, 38, 'Team X', 'view')).toBe('Assign 38 samples to Team X');
		expect(accessSentence('change_owner', samples, 3, 'Ann Lee', 'view')).toBe('Change the owner of 3 samples to Ann Lee');
		expect(accessSentence('share_access', operations, 12, 'Ann', 'edit')).toBe('Share 12 operations with Ann (Can edit)');
		expect(accessSentence('share_access', operations, 1, 'Ann', 'view')).toBe('Share 1 operation with Ann (Can view)');
		expect(accessSentence('remove_access', samples, 5, 'Team X', 'view')).toBe("Remove Team X's access to 5 samples");
	});
	it('words the toast', () => {
		expect(resultText(entry('assign_team'), samples, 38, { value: 't1' }, 'Team X')).toBe('Assigned 38 samples to Team X');
		expect(resultText(entry('change_owner'), samples, 1, { value: 'p1' }, 'Ann')).toBe('Changed the owner of 1 sample to Ann');
		expect(resultText(entry('share_access', operations), operations, 12, { value: 'p1' }, 'Ann')).toBe('Shared 12 operations with Ann');
		expect(resultText(entry('remove_access'), samples, 2, { value: 'p1' }, 'Ann')).toBe('Removed access for Ann on 2 samples');
		expect(resultText(entry('assign_team'), samples, 0, { value: 't1' }, 'Team X')).toBe('Nothing was changed');
	});
	it('takes the access levels from the Who has access dialog', () => {
		expect(roleChoices(samples)).toEqual([{ value: 'view', label: 'Can view' }, { value: 'edit', label: 'Can edit' }]);
		expect(roleLabel(samples, 'edit')).toBe('Can edit');
	});
});

describe('skip reasons of the new actions', () => {
	it('pass the endpoint\'s plain words through', () => {
		expect(skipReasonText('That team has no manager to look after the record — add a manager first.')).toBe('That team has no manager to look after the record — add a manager first');
	});
	it('turn the bare codes into plain words', () => {
		expect(skipReasonText('TEAM_HAS_NO_MANAGER')).toBe('That team has no manager yet');
		expect(skipReasonText('NOT_OWNABLE_BY_TEAM')).toBe('This kind of record cannot be owned by a team');
		expect(skipReasonText('TEAM_OWNS_RECORD')).toBe('That team owns this record, so it already has access');
	});
});

const pr = (id: string, status: PreviewRow['status'], extra: Partial<PreviewRow> = {}): PreviewRow => ({ id, code: `C-${id}`, status, ...extra });

describe('warnings', () => {
	const rows = [
		pr('1', 'ok'), pr('2', 'ok', { warning: 'You may lose access to this record' }), pr('3', 'skip', { reason: 'x', warning: 'ignored' }), pr('4', 'ok', { warning: 'You may lose access to this record' }),
	];
	it('lists the rows that would change with a warning, the warning as the reason', () => {
		expect(warnedRows(rows)).toEqual([
			{ id: '2', code: 'C-2', reason: 'You may lose access to this record' }, { id: '4', code: 'C-4', reason: 'You may lose access to this record' },
		]);
	});
	it('counts them in plain words', () => {
		expect(warnedSummary(1)).toBe('1 has a warning');
		expect(warnedSummary(3)).toBe('3 have a warning');
		expect(warnedQuestion(1)).toBe('Which one has a warning?');
		expect(warnedQuestion(3)).toBe('Which 3 have a warning?');
		expect(warnedAfter(2)).toBe('2 had a warning');
	});
	it('stay on the toast: said, listed, and the finished toast does not leave by itself', () => {
		const warned = warnedRows(rows);
		const t = startToast('a', 'Assigned 3 samples to Team X', 70_000, [], 10_000, true, warned);
		expect(t.warned).toHaveLength(2);
		expect(toastAnnouncement(t)).toBe('Assigned 3 samples to Team X. 2 had a warning');
		expect(dismissDelay(tickToast(t, 70_000))).toBeNull();
		expect(dismissDelay({ ...tickToast(t, 70_000), warned: [] })).toBe(3000);
		expect(toastAnnouncement({ ...t, skipped: [{ id: 's', code: 'S', reason: 'r' }] })).toBe('Assigned 3 samples to Team X. 1 skipped. 2 had a warning');
	});
});
