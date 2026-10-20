import { describe, expect, it } from 'vitest';
import { indexDefBySlug } from '../index/indexConfig';
import type { ApplyRow, PreviewRow, RevertRow } from './bulkModel';
import {
	BULK_UNDO_SECONDS, applyLabel, applySkips, beginUndo, bulkEntries, canApply, canClear, deadlineFor, dialogTitle, dismissDelay, enumChoices, groupSkips,
	leftAsTheyAre, menuLabel, notRevertedIds, paramsFor, previewCounts, previewSkips, previewSummary, previewWarnings, recordsText, resultText, ringFraction, secondsLeft,
	skippedQuestion, skipReasonText, startToast, tickToast, toastAnnouncement, undoDone, undoFailed, valueText,
} from './bulkModel';

const samples = indexDefBySlug('samples')!;
const tests = indexDefBySlug('tests')!;
const tools = indexDefBySlug('tools')!;
const status = bulkEntries(samples).find((e) => e.id === 'field:current_status')!;

describe('bulkEntries', () => {
	it('offers samples Print labels, Restrict, Unrestrict and one edit per bulk field, in that order', () => {
		expect(bulkEntries(samples).map((e) => [e.id, e.label])).toEqual([
			['print', 'Print labels'], ['restrict', 'Restrict…'], ['unrestrict', 'Unrestrict…'],
			['field:current_status', 'Edit status…'], ['field:project_id', 'Edit project…'], ['field:export_controlled', 'Edit export control…'],
		]);
	});
	it('offers an ownable page without bulk fields only the restrict pair, and no Print labels', () => {
		expect(bulkEntries(tests).map((e) => e.id)).toEqual(['restrict', 'unrestrict']);
	});
	it('offers a plain page nothing at all', () => {
		expect(bulkEntries(tools)).toEqual([]);
	});
	it('keys the restrict pair off the ownable flag, not the slug', () => {
		expect(bulkEntries({ ...tools, ownable: true }).map((e) => e.id)).toEqual(['restrict', 'unrestrict']);
	});
	it('gives a Lab Viewer only the entries that navigate', () => {
		expect(bulkEntries(samples, { viewer: true }).map((e) => e.id)).toEqual(['print']);
		expect(bulkEntries(tests, { viewer: true })).toEqual([]);
	});
	it('carries the field on an edit entry', () => {
		expect(status.kind).toBe('edit_field');
		expect(status.field?.field).toBe('current_status');
	});
	it('words the menu button by how many are ticked', () => {
		expect(menuLabel(0)).toBe('With selected');
		expect(menuLabel(4)).toBe('With 4 selected');
	});
});

describe('dialog wording', () => {
	it('counts records in the right number', () => {
		expect(recordsText(samples, 38)).toBe('38 samples');
		expect(recordsText(samples, 1)).toBe('1 sample');
		expect(recordsText(indexDefBySlug('campaigns')!, 2)).toBe('2 campaigns');
	});
	it('titles each kind', () => {
		expect(dialogTitle(status, samples, 38)).toBe('Edit status for 38 samples');
		expect(dialogTitle(bulkEntries(tests)[0], tests, 5)).toBe('Restrict 5 tests');
		expect(dialogTitle(bulkEntries(tests)[1], tests, 1)).toBe('Unrestrict 1 test');
	});
	it('asks for params only when the target is known', () => {
		expect(paramsFor(status, null)).toBeNull();
		expect(paramsFor(status, { value: 'archived' })).toEqual({ field: 'current_status', value: 'archived' });
		expect(paramsFor(status, { value: null })).toEqual({ field: 'current_status', value: null });
		expect(paramsFor(bulkEntries(tests)[0], null)).toEqual({});
	});
	it('offers Clear value only on a column that may be empty', () => {
		expect(samples.bulkFields!.map(canClear)).toEqual([false, true, false]);
	});
	it('labels values: sample statuses from the status table, yes / no, a picked link', () => {
		const [stat, project, flag] = samples.bulkFields!;
		expect(enumChoices(samples, stat).map((c) => c.label)).toEqual(['Active', 'Consumed', 'Destroyed', 'Archived']);
		expect(valueText(samples, flag, true)).toBe('Yes');
		expect(valueText(samples, flag, false)).toBe('No');
		expect(valueText(samples, project, 'p1', 'P-100')).toBe('P-100');
		expect(valueText(samples, project, null)).toBe('empty');
	});
});

const pr = (id: string, s: PreviewRow['status'], extra: Partial<PreviewRow> = {}): PreviewRow => ({ id, code: `C-${id}`, status: s, ...extra });

describe('the dry run', () => {
	const rows = [
		pr('1', 'ok'), pr('2', 'ok', { warning: 'You may lose access' }), pr('3', 'noop'), pr('4', 'skip', { reason: 'You are not the owner' }),
		pr('5', 'skip', { reason: 'You are not the owner' }), pr('6', 'skip', { reason: 'RESTRICT_ADMIN_ONLY' }), pr('7', 'ok', { warning: 'You may lose access' }),
	];
	it('counts and says it', () => {
		const c = previewCounts(rows);
		expect(c).toEqual({ ok: 3, noop: 1, skip: 3 });
		expect(previewSummary(c)).toBe('3 can be changed. 1 needs no change. 3 will be skipped');
		expect(previewSummary({ ok: 38, noop: 0, skip: 12 })).toBe('38 can be changed. 12 will be skipped');
		expect(previewSummary({ ok: 0, noop: 0, skip: 4 })).toBe('None can be changed. 4 will be skipped');
	});
	it('is right about one: needs, is, it', () => {
		expect(previewSummary({ ok: 1, noop: 1, skip: 1 })).toBe('1 can be changed. 1 needs no change. 1 will be skipped');
		expect(skippedQuestion(1)).toBe('Why is 1 skipped?');
		expect(skippedQuestion(12)).toBe('Why are 12 skipped?');
		expect(leftAsTheyAre(1)).toBe('1 left as it is');
		expect(leftAsTheyAre(3)).toBe('3 left as they are');
	});
	it('applies only when something would change', () => {
		expect(canApply({ ok: 0, noop: 2, skip: 1 })).toBe(false);
		expect(canApply({ ok: 1, noop: 0, skip: 0 })).toBe(true);
		expect(applyLabel(38)).toBe('Apply to 38');
	});
	it('lists each warning once, from the rows that would change', () => {
		expect(previewWarnings(rows)).toEqual(['You may lose access']);
		expect(previewWarnings([pr('1', 'skip', { warning: 'x' })])).toEqual([]);
	});
	it('groups the skipped rows by reason, biggest first, in plain words', () => {
		expect(groupSkips(previewSkips(rows))).toEqual([
			{ reason: 'You are not the owner', rows: [{ id: '4', code: 'C-4' }, { id: '5', code: 'C-5' }] },
			{ reason: 'Only administrators can restrict records yet', rows: [{ id: '6', code: 'C-6' }] },
		]);
	});
});

describe('skipReasonText', () => {
	it('keeps the endpoint words, drops the full stop and capitalises', () => {
		expect(skipReasonText('You are not the owner.')).toBe('You are not the owner');
		expect(skipReasonText('that team has no manager yet')).toBe('That team has no manager yet');
	});
	it('turns an unknown code into words and an empty reason into a sentence', () => {
		expect(skipReasonText('SOME_NEW_CODE')).toBe('Some new code');
		expect(skipReasonText(undefined)).toBe('Could not be changed');
		expect(skipReasonText('  ')).toBe('Could not be changed');
	});
	it('knows the codes the server answers with', () => {
		expect(skipReasonText('RESTRICT_ADMIN_ONLY')).toBe('Only administrators can restrict records yet');
		expect(skipReasonText('NOT_FOUND')).toBe('Not found or not visible to you');
	});
});

describe('apply results', () => {
	const rows: ApplyRow[] = [
		{ id: '1', code: 'A', outcome: 'applied' }, { id: '2', code: 'B', outcome: 'noop' },
		{ id: '3', code: 'C', outcome: 'skipped', reason: 'You are not the owner' }, { id: '4', code: 'D', outcome: 'failed' },
	];
	it('keeps skipped and failed rows, not the no-op', () => {
		expect(applySkips(rows)).toEqual([{ id: '3', code: 'C', reason: 'You are not the owner' }, { id: '4', code: 'D', reason: '' }]);
	});
	it('words the result', () => {
		expect(resultText(status, samples, 38, { value: 'archived' })).toBe('Set status to Archived on 38 samples');
		const project = bulkEntries(samples).find((e) => e.id === 'field:project_id')!;
		expect(resultText(project, samples, 2, { value: 'p1' }, 'P-100')).toBe('Set project to P-100 on 2 samples');
		expect(resultText(project, samples, 1, { value: null })).toBe('Cleared project on 1 sample');
		expect(resultText(bulkEntries(tests)[0], tests, 5, null)).toBe('Restricted 5 tests');
		expect(resultText(bulkEntries(tests)[1], tests, 1, null)).toBe('Unrestricted 1 test');
		expect(resultText(status, samples, 0, { value: 'x' })).toBe('Nothing was changed');
	});
});

describe('the countdown', () => {
	const t0 = Date.parse('2026-10-20T10:00:00Z');
	const until = '2026-10-20T10:01:00Z';
	it('counts whole seconds left, rounding up, never below 0', () => {
		expect(secondsLeft(until, t0)).toBe(60);
		expect(secondsLeft(until, t0 + 1)).toBe(60);
		expect(secondsLeft(until, t0 + 1000)).toBe(59);
		expect(secondsLeft(until, t0 + 59_001)).toBe(1);
		expect(secondsLeft(until, t0 + 60_000)).toBe(0);
		expect(secondsLeft(until, t0 + 90_000)).toBe(0);
	});
	it('takes ms, a Date or text, and a bad value as over', () => {
		expect(secondsLeft(t0 + 5000, t0)).toBe(5);
		expect(secondsLeft(new Date(t0 + 5000), t0)).toBe(5);
		expect(secondsLeft('soon', t0)).toBe(0);
	});
	it('never shows more than the window, whatever the clock', () => {
		expect(secondsLeft(t0 + 600_000, t0)).toBe(BULK_UNDO_SECONDS);
	});
	it('trusts the server time while the clocks agree, else a full window from arrival', () => {
		expect(deadlineFor(until, t0)).toBe(Date.parse(until));
		expect(deadlineFor(until, t0 + 4000)).toBe(Date.parse(until));
		expect(deadlineFor(until, t0 - 3_600_000)).toBe(t0 - 3_600_000 + 60_000);
		expect(deadlineFor(until, t0 + 3_600_000)).toBe(t0 + 3_600_000 + 60_000);
		expect(deadlineFor('nonsense', t0)).toBe(t0 + 60_000);
	});
	it('gives the ring its fraction', () => {
		expect(ringFraction(60)).toBe(1);
		expect(ringFraction(30)).toBe(0.5);
		expect(ringFraction(-3)).toBe(0);
	});
});

describe('the toast state machine', () => {
	const t0 = 1_000_000;
	const fresh = () => startToast('act-1', 'Set status to Archived on 2 samples', t0 + 60_000, [], t0);
	it('starts pending with the seconds left', () => {
		expect(fresh()).toMatchObject({ phase: 'pending', left: 60, busy: false, error: '' });
	});
	it('starts done when the window is already over', () => {
		expect(startToast('a', 'm', t0 - 1, [], t0).phase).toBe('done');
	});
	it('ticks down and ends as done', () => {
		let t = tickToast(fresh(), t0 + 10_000);
		expect(t).toMatchObject({ phase: 'pending', left: 50 });
		t = tickToast(t, t0 + 60_000);
		expect(t).toMatchObject({ phase: 'done', left: 0 });
		expect(tickToast(t, t0 + 61_000)).toBe(t);
	});
	it('lets an undo in flight finish when the ring runs out', () => {
		const t = tickToast(beginUndo(tickToast(fresh(), t0 + 59_000)), t0 + 60_000);
		expect(t.phase).toBe('pending');
		expect(t.busy).toBe(true);
	});
	it('moves pending to undone with the rows the undo left alone', () => {
		const results: RevertRow[] = [
			{ id: '1', revert_outcome: 'reverted' }, { id: '2', revert_outcome: 'changed_since' },
			{ id: '3', revert_outcome: 'refused', reason: 'The old team has no manager' },
		];
		const t = undoDone(beginUndo(fresh()), results, new Map([['2', 'S-2']]));
		expect(t.phase).toBe('undone');
		expect(t.undoSkipped).toEqual([
			{ id: '2', code: 'S-2', reason: 'Changed since, so it was left as it is' },
			{ id: '3', code: '3', reason: 'The old team has no manager' },
		]);
		expect(notRevertedIds(results)).toEqual(['2', '3']);
		expect(toastAnnouncement(t)).toBe('Undone. 2 left as they are');
		expect(toastAnnouncement(undoDone(fresh(), [{ id: 'x', revert_outcome: 'failed' }], new Map()))).toBe('Undone. 1 left as it is');
	});
	it('keeps the toast and says why when an undo fails', () => {
		const t = undoFailed(beginUndo(fresh()), 'The undo window has closed', t0 + 5000);
		expect(t).toMatchObject({ phase: 'pending', busy: false, error: 'The undo window has closed', left: 55 });
		expect(undoFailed(beginUndo(fresh()), 'late', t0 + 61_000).phase).toBe('done');
	});
	it('does not undo twice or after the end', () => {
		const busy = beginUndo(fresh());
		expect(beginUndo(busy)).toBe(busy);
		const done = tickToast(fresh(), t0 + 60_000);
		expect(beginUndo(done)).toBe(done);
	});
	it('announces the result, then Done', () => {
		const skipped = [{ id: '9', code: 'S-9', reason: 'x' }];
		expect(toastAnnouncement(fresh())).toBe('Set status to Archived on 2 samples');
		expect(toastAnnouncement(startToast('a', 'Restricted 3 tests', t0 + 1000, skipped, t0))).toBe('Restricted 3 tests. 1 skipped');
		expect(toastAnnouncement(tickToast(fresh(), t0 + 60_000))).toBe('Done');
	});
	it('goes by itself unless there is something to read', () => {
		expect(dismissDelay(fresh())).toBeNull();
		expect(dismissDelay(tickToast(fresh(), t0 + 60_000))).toBe(3000);
		expect(dismissDelay(undoDone(fresh(), [], new Map()))).toBe(5000);
		expect(dismissDelay(startToast('a', 'm', t0 - 1, [{ id: '1', code: 'A', reason: '' }], t0))).toBeNull();
	});
});
