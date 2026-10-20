// The dialog of the ownership and access actions, server-rendered: the target step of each kind, the access level, the confirming
// sentence, the warnings before Apply, and the toast's warning list. The interactive flow is in starbase-pages/src/bulkActions.dom.test.ts.
import { describe, expect, it } from 'vitest';
import { createSSRApp, reactive, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { EXPLORER_HOST } from '../host';
import { indexDefBySlug } from '../index/indexConfig';
import BulkDialog from './BulkDialog.vue';
import UndoToast from './UndoToast.vue';
import { bulkEntries, startToast } from './bulkModel';
import type { BulkState } from './useBulkActions';

const operations = indexDefBySlug('operations')!;
const entries = bulkEntries(operations);
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const WARN = 'You may lose access to this record';

const TEAMS = [
	{ kind: 'team', team_id: 't1', name: 'Team X', color: 'blue', logo: null, member_count: 4 },
	{ kind: 'team', team_id: 't2', name: 'Team Y', color: 'green', logo: null, member_count: 1 },
];

function state(entryId: string, over: Record<string, unknown> = {}, dialogOver: Record<string, unknown> = {}) {
	const dialog = ref({ entry: entries.find((e) => e.id === entryId)!, ids: ['a', 'b', 'c'], choice: null as any, choiceLabel: undefined as string | undefined, role: 'view', ...dialogOver });
	return reactive({
		dialog, preview: { loading: false, rows: null, error: '' }, applying: false, applyError: '', fieldOptions: [], teamOptions: TEAMS,
		optionsState: { loading: false, error: '' }, toasts: [], counts: { ok: 0, noop: 0, skip: 0 }, summary: '', warnings: [], ready: false,
		open() {}, close() {}, choose() {}, clearChoice() {}, chooseRole() {}, apply() {}, undo() {}, dismiss() {}, ...over,
	}) as unknown as BulkState;
}
async function render(bulk: BulkState): Promise<string> {
	const app = createSSRApp(BulkDialog, { bulk, def: operations, restoreFocus: () => {} });
	app.provide(EXPLORER_HOST, { api: { get: async () => ({ data: {} }), post: async () => ({ data: {} }) } } as any);
	const ctx: { teleports?: Record<string, string> } = {};
	await renderToString(app, ctx);
	return ctx.teleports?.body ?? '';
}

describe('Assign to team', () => {
	it('lists the teams as radios with their tiles and member counts, and asks for one', async () => {
		const html = await render(state('assign_team'));
		expect(text(html)).toContain('Assign 3 operations to a team');
		expect(html.match(/type="radio"/g)).toHaveLength(2);
		expect(html).toContain('d1-team-tile');
		expect(text(html)).toContain('Team X');
		expect(text(html)).toContain('Team · 4 members');
		expect(text(html)).toContain('Team · 1 member');
		expect(text(html)).toContain('Choose a team to see what would change.');
		expect(html).toMatch(/<button[^>]*class="btn primary"[^>]*disabled[^>]*>Apply to 0<\/button>/);
	});
	it('marks the chosen team and confirms in words once the check has run', async () => {
		const html = await render(state(
			'assign_team',
			{ preview: { loading: false, rows: [{ id: 'a', code: 'O-1', status: 'ok' }], error: '' }, counts: { ok: 3, noop: 0, skip: 0 }, summary: '3 can be changed', ready: true },
			{ choice: { value: 't1', target: 'team' }, choiceLabel: 'Team X' },
		));
		expect(html).toMatch(/<input[^>]*type="radio"[^>]*checked/);
		expect(text(html)).toContain('Assign 3 operations to Team X');
		expect(text(html)).toContain('3 can be changed');
		expect(html).toMatch(/<button[^>]*class="btn primary"[^>]*>Apply to 3<\/button>/);
	});
	it('says when the teams could not be loaded, as an alert', async () => {
		const html = await render(state('assign_team', { teamOptions: [], optionsState: { loading: false, error: 'Teams are not available.' } }));
		expect(html).toMatch(/<p[^>]*class="err"[^>]*role="alert"[^>]*>The list could not be loaded: Teams are not available\. Close this and try again\./);
	});
});

describe('person targets', () => {
	it('Change owner searches people only', async () => {
		const html = await render(state('change_owner'));
		expect(text(html)).toContain('Change the owner of 3 operations');
		expect(html).toContain('role="combobox"');
		expect(html).toContain('placeholder="Search people by name…"');
		expect(html).not.toContain('Access level');
		expect(text(html)).toContain('Search for a person to see what would change.');
	});
	it('Share searches people and teams and offers Can view and Can edit', async () => {
		const html = await render(state('share_access'));
		expect(html).toContain('placeholder="Search people and teams by name…"');
		expect(text(html)).toContain('Access level');
		expect(text(html)).toContain('Can view');
		expect(text(html)).toContain('Can edit');
	});
	it('Remove access has no access level', async () => {
		const html = await render(state('remove_access'));
		expect(text(html)).toContain('Remove access to 3 operations');
		expect(html).not.toContain('Access level');
	});
	it('writes the chosen person with a Change button instead of the search box, and the sentence with the level', async () => {
		const html = await render(state(
			'share_access',
			{ preview: { loading: false, rows: [{ id: 'a', code: 'O-1', status: 'ok' }], error: '' }, counts: { ok: 3, noop: 0, skip: 0 }, summary: '3 can be changed', ready: true },
			{ choice: { value: 'p1', target: 'person' }, choiceLabel: 'Ann', role: 'edit' },
		));
		expect(html).not.toContain('role="combobox"');
		expect(text(html)).toContain('Ann Person Change');
		expect(text(html)).toContain('Share 3 operations with Ann (Can edit)');
		expect(html).toContain('Access level');
	});
});

describe('warnings before Apply', () => {
	const rows = [
		{ id: 'a', code: 'O-1', status: 'ok', warning: WARN }, { id: 'b', code: 'O-2', status: 'ok', warning: WARN }, { id: 'c', code: 'O-3', status: 'ok' },
		{ id: 'd', code: 'O-4', status: 'skip', reason: 'That team has no manager yet' },
	];
	it('counts the rows that carry one, says it, and lists the rows in a fold', async () => {
		const html = await render(state(
			'assign_team',
			{ preview: { loading: false, rows, error: '' }, counts: { ok: 3, noop: 0, skip: 1 }, summary: '3 can be changed. 1 will be skipped', warnings: [WARN], ready: true },
			{ choice: { value: 't1', target: 'team' }, choiceLabel: 'Team X' },
		));
		expect(text(html)).toContain('Read before you apply: 2 have a warning.');
		expect(html).toMatch(/<p[^>]*class="warn"[^>]*>You may lose access to this record<\/p>/);
		expect(text(html)).toContain('Which 2 have a warning?');
		expect(text(html)).toContain(`${WARN} (2)`);
		expect(text(html)).toContain('O-1');
		expect(text(html)).toContain('Why is 1 skipped?');
		expect(text(html)).toContain('That team has no manager yet (1)');
	});
	it('says nothing about warnings when there are none', async () => {
		const html = await render(state(
			'assign_team',
			{ preview: { loading: false, rows: [{ id: 'a', code: 'O-1', status: 'ok' }], error: '' }, counts: { ok: 1, noop: 0, skip: 0 }, summary: '1 can be changed', ready: true },
			{ choice: { value: 't1', target: 'team' }, choiceLabel: 'Team X' },
		));
		expect(text(html)).not.toContain('warning');
	});
});

describe('the toast of a warned action', () => {
	it('folds the warned rows under "2 had a warning", with the warning as their heading', async () => {
		const warned = [{ id: 'a', code: 'O-1', reason: WARN }, { id: 'b', code: 'O-2', reason: WARN }];
		const t = startToast('a1', 'Assigned 3 operations to Team X', 1_060_000, [], 1_000_000, true, warned);
		const html = await renderToString(createSSRApp(UndoToast, { toast: t }));
		expect(text(html)).toContain('Assigned 3 operations to Team X');
		expect(text(html)).toContain('2 had a warning');
		expect(text(html)).toContain(`${WARN} (2)`);
	});
});
