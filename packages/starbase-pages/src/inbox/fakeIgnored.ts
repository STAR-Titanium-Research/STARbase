// The ignored-folder routes of the fake d1-inbox (fakeInboxServer.ts), as the endpoint answers them (core/extensions/d1-inbox/index.js, spec section 15):
//   GET    /d1-inbox/ignored-folders      { data: [{ ignored_id, folder, owner: { kind, id, name }, created_at, can_remove }] }  the caller's rules and their teams'
//   POST   /d1-inbox/ignored-folders      { folder, team_id? } -> { data: { ignored_id, folder, team_id, dismissed } } (the real endpoint's status is 201);
//                                         the owner's open files below the folder are dismissed in the same step; 400 INVALID_PAYLOAD (field 'folder' / 'team_id'),
//                                         403 FORBIDDEN (a team the caller is not in), 409 NO_FOLDER / ALREADY_IGNORED (any letter case) / TOO_MANY_RULES
//   DELETE /d1-inbox/ignored-folders/:id  { data: { ignored_id, folder, rescan_queued } }; 404 NOT_FOUND for a rule that is not the caller's or their team's
// A Lab Viewer (option `viewer`) reads the rules with can_remove false and every write is 403 READ_ONLY_ROLE. Rules are matched on whole path parts,
// ignoring case. Options: `ignoredRules` (the rules to start with), `alias`, `ignoreTeams`, `ignoreLimit`, `viewer`, `noFolder`.
import type { FileOwner, FoundFile } from './inboxApi';

export interface FakeTeam {
	team_id: string;
	name: string;
	share_folder: string;
}
export interface FakeRuleSeed {
	folder: string;
	/** Default: the caller's own folder. */
	owner?: FileOwner;
	ignored_id?: string;
	created_at?: string;
}
export interface FakeIgnoredOptions {
	ignoredRules?: FakeRuleSeed[];
	/** The caller's uni alias: their folder is Users/<alias> (default ab1cd, what the fake's files use). */
	alias?: string;
	/** The teams the caller is an active member of. Default: one per team that owns a file the fake holds (share folder from the file's path). */
	ignoreTeams?: FakeTeam[];
	/** Rules per owner at most (the endpoint's is 200). */
	ignoreLimit?: number;
	/** A Lab Viewer: can_remove false, every write refused. */
	viewer?: boolean;
	/** The person has no folder: POST is 409 NO_FOLDER. */
	noFolder?: boolean;
}

interface Rule {
	ignored_id: string;
	folder: string;
	owner: FileOwner;
	created_at: string;
}

const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
	Object.assign(new Error(`Request failed with status code ${status}`), {
		response: { status, data: { errors: [{ message, extensions: { ...extra, code, source: 'd1-inbox' } }] } },
	});
const bad = (message: string, field = 'folder') => err(400, 'INVALID_PAYLOAD', message, { field });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createFakeIgnored(ctx: {
	opts: FakeIgnoredOptions;
	files: FoundFile[];
	now: () => number;
	/** The rescan the removal asks for: true when one was queued (the 10-minute limit of POST /rescan decides). */
	queueRescan: () => boolean;
	person: () => FileOwner;
}) {
	const { opts, files } = ctx;
	const alias = opts.alias ?? 'ab1cd';
	const limit = opts.ignoreLimit ?? 200;
	let seq = 0;
	const idOf = () => `1e${String((seq += 1)).padStart(6, '0')}-0000-4000-8000-000000000000`;

	const teams: FakeTeam[] =
		opts.ignoreTeams ??
		[...new Map(files.filter((f) => f.owner.kind === 'team' && f.owner.id).map((f) => [f.owner.id as string, { team_id: f.owner.id as string, name: f.owner.name, share_folder: f.rel_path.split('/')[1] ?? '' }])).values()];
	const me = (): FileOwner => ctx.person();
	const rules: Rule[] = (opts.ignoredRules ?? []).map((r) => ({ ignored_id: r.ignored_id ?? idOf(), folder: r.folder, owner: r.owner ?? me(), created_at: r.created_at ?? '2026-10-16T09:00:00.000Z' }));

	const same = (a: FileOwner, b: FileOwner) => a.kind === b.kind && (a.kind === 'team' ? a.id === b.id : true);
	const mine = (r: Rule) => (r.owner.kind === 'team' ? teams.some((t) => t.team_id === r.owner.id) : true);
	const guardWrite = () => {
		if (opts.viewer) throw err(403, 'READ_ONLY_ROLE', 'The Lab Viewer role is read-only: it can look at everything and cannot change anything.');
	};

	/** The checks parseIgnoredFolder makes, with its words. */
	function check(value: unknown, root: string): string {
		if (typeof value !== 'string') throw bad('Choose the folder to ignore.');
		if (value.trim() === '') throw bad('Choose a folder below your own folder: the whole folder cannot be ignored.');
		if (value.length > 500) throw bad('The folder is too long (at most 500 characters).');
		// eslint-disable-next-line no-control-regex
		if (/[\u0000-\u001f\u007f]/.test(value)) throw bad('The folder contains characters that are not allowed.');
		if (value.includes('\\')) throw bad('Write the folder with / between the names, not \\.');
		if (value.startsWith('/') || value.endsWith('/')) throw bad('The folder must not start or end with a slash.');
		const parts = value.split('/');
		if (parts.some((p) => p === '')) throw bad('The folder has an empty part (two slashes in a row).');
		if (parts.some((p) => p === '.' || p === '..')) throw bad('The folder must not contain . or .. parts.');
		const lower = value.toLowerCase();
		const r = root.toLowerCase();
		if (lower === r || lower.startsWith(`${r}/`)) throw bad(`Give the folder relative to your own folder, without ${root}/.`);
		return value;
	}

	const ruleOut = (r: Rule) => ({ ignored_id: r.ignored_id, folder: r.folder, owner: r.owner, created_at: r.created_at, can_remove: !opts.viewer });

	return {
		rules,
		/** The routes, as handlers over a call's body; `remove` takes the id of the path. */
		list: () => ({
			data: rules.filter(mine).sort((a, b) => a.folder.toLowerCase().localeCompare(b.folder.toLowerCase()) || a.ignored_id.localeCompare(b.ignored_id)).map(ruleOut),
		}),
		add: (c: { body?: unknown }) => {
			guardWrite();
			const body = (c.body ?? {}) as { folder?: unknown; team_id?: unknown };
			let owner: FileOwner;
			let root: string;
			if (body.team_id === undefined || body.team_id === null) {
				if (opts.noFolder) throw err(409, 'NO_FOLDER', 'There is no folder to scan yet. Ask an administrator to set your uni alias.');
				owner = me();
				root = `Users/${alias}`;
			} else {
				if (typeof body.team_id !== 'string' || !UUID.test(body.team_id)) throw bad('team_id must be an id.', 'team_id');
				const team = teams.find((t) => t.team_id === (body.team_id as string).toLowerCase());
				if (!team) throw err(403, 'FORBIDDEN', 'You are not a member of that team.', { field: 'team_id' });
				owner = { kind: 'team', id: team.team_id, name: team.name };
				root = `Shared/${team.share_folder}`;
			}
			const folder = check(body.folder, root);
			const own = rules.filter((r) => same(r.owner, owner));
			if (own.length >= limit) throw err(409, 'TOO_MANY_RULES', `You can ignore at most ${limit} folders. Remove one first.`, { limit });
			if (own.some((r) => r.folder.toLowerCase() === folder.toLowerCase())) throw err(409, 'ALREADY_IGNORED', 'That folder is already ignored.', { field: 'folder', folder });
			const rule: Rule = { ignored_id: idOf(), folder, owner, created_at: new Date(ctx.now()).toISOString() };
			rules.push(rule);
			// the owner's open files below the folder are dismissed (linked and gone files are untouched), as POST /dismiss does it
			const prefix = `${root}/${folder}/`.toLowerCase();
			let dismissed = 0;
			for (const f of files) {
				if (f.state !== 'new' || !same(f.owner, owner) || !f.rel_path.toLowerCase().startsWith(prefix)) continue;
				f.state = 'dismissed';
				f.decided_at = new Date(ctx.now()).toISOString();
				dismissed += 1;
			}
			return { data: { ignored_id: rule.ignored_id, folder, team_id: owner.kind === 'team' ? owner.id : null, dismissed } };
		},
		remove: (id: string) => {
			guardWrite();
			if (!UUID.test(id)) throw bad('The ignored folder id is not valid.', 'ignored_id');
			const at = rules.findIndex((r) => r.ignored_id === id.toLowerCase() && mine(r));
			if (at < 0) throw err(404, 'NOT_FOUND', 'That ignored folder does not exist.');
			const [rule] = rules.splice(at, 1);
			return { data: { ignored_id: rule.ignored_id, folder: rule.folder, rescan_queued: ctx.queueRescan() } };
		},
	};
}
