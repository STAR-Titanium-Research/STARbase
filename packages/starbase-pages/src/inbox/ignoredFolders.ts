// Ignored folders (spec 2026-10-15-found-files-inbox-design.md section 15), as plain functions (no Vue, no network): which folder a row's
// "Ignore this folder" means, the same checks the server makes on a typed folder, the folders the page already knows, and the words.
// A rule is a folder path RELATIVE to its owner's root ("World-Ti Paper/Drafts", never "Users/ab1cd/World-Ti Paper/Drafts"), on whole path parts,
// ignoring case; it covers the folder and everything below it.
import type { FoundFile, IgnoredRule } from './inboxApi';

/** The server's limit on a folder's length (MAX_IGNORED_FOLDER in d1-inbox). */
export const MAX_FOLDER_LENGTH = 500;

/** Where a row's "Ignore this folder" leads: the rule's owner and the folder relative to that owner's root. */
export interface IgnoreTarget {
	/** Relative to the owner's root: "World-Ti Paper/Drafts". */
	folder: string;
	/** The team the rule belongs to (a file in a team folder), or null for the person's own folder. */
	teamId: string | null;
	/** The owner's name, for a person who also has a team folder ("Ann Lee", "SEM team"). */
	ownerName: string;
	ownerKind: 'person' | 'team';
}

/**
 * The folder a found file sits in, relative to its owner's root, or null when there is none to ignore: a file directly in the root (the whole root
 * cannot be ignored), or a path that is not under Users/<alias>/ or Shared/<folder>/. A file in a team folder belongs to the team (its owner id).
 */
export function ignoreTarget(file: Pick<FoundFile, 'rel_path' | 'owner'>): IgnoreTarget | null {
	const parts = file.rel_path.split('/');
	if (parts.length < 4 || (parts[0] !== 'Users' && parts[0] !== 'Shared')) return null;
	const folder = parts.slice(2, -1).join('/');
	if (folder === '' || parts.slice(2, -1).some((p) => p === '')) return null;
	const team = parts[0] === 'Shared' || file.owner.kind === 'team';
	if (team && !file.owner.id) return null;
	return { folder, teamId: team ? file.owner.id : null, ownerName: file.owner.name, ownerKind: team ? 'team' : 'person' };
}

/** The key of a rule's owner: 'me' for the person's own folder, else the team's id. The same key for a file and a rule. */
export const ownerKey = (owner: { kind: 'person' | 'team'; id: string | null }): string => (owner.kind === 'team' ? `team:${owner.id}` : 'me');

/** Is `folder` the rule's folder or below it? Whole path parts, ignoring case: "World-Ti Paper" covers "world-ti paper/Drafts" but not "World-Ti Paper 2". */
export function isBelow(folder: string, rule: string): boolean {
	const f = folder.toLowerCase();
	const r = rule.toLowerCase();
	return r !== '' && (f === r || f.startsWith(`${r}/`));
}

/** How many of these rows are open files of the same owner at or below the folder: an ESTIMATE (the page holds one tab and one page of it). */
export function shownBelow(rows: readonly FoundFile[], target: IgnoreTarget): number {
	return rows.filter((f) => {
		if (f.state !== 'new') return false;
		const t = ignoreTarget(f);
		return !!t && t.teamId === target.teamId && isBelow(t.folder, target.folder);
	}).length;
}

/**
 * Why this typed folder would be refused, or null when it is fine. The server's own checks (so a person sees the problem before the round trip),
 * in plain words. The server's message is still what is shown when it refuses something this cannot know (a path that starts with the owner's root).
 */
export function folderProblem(value: string): string | null {
	const v = value.trim();
	if (v === '') return 'Type or choose a folder.';
	if (v.length > MAX_FOLDER_LENGTH) return `The folder is too long (at most ${MAX_FOLDER_LENGTH} characters).`;
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(v)) return 'The folder contains characters that are not allowed.';
	if (v.includes('\\')) return 'Write the folder with / between the names, not \\.';
	if (v.startsWith('/') || v.endsWith('/')) return 'The folder must not start or end with a slash.';
	const parts = v.split('/');
	if (parts.some((p) => p === '')) return 'The folder has an empty part (two slashes in a row).';
	if (parts.some((p) => p === '.' || p === '..')) return 'The folder must not contain . or .. parts.';
	return null;
}

/** The folders the loaded rows sit in (and the folders above them) for one owner, relative to its root, sorted, without those already ignored. */
export function knownFolders(rows: readonly FoundFile[], owner: string, rules: readonly IgnoredRule[], cap = 200): string[] {
	const ignored = new Set(rules.filter((r) => ownerKey(r.owner) === owner).map((r) => r.folder.toLowerCase()));
	const seen = new Map<string, string>();
	for (const f of rows) {
		const t = ignoreTarget(f);
		if (!t || (t.teamId ? `team:${t.teamId}` : 'me') !== owner) continue;
		const parts = t.folder.split('/');
		for (let i = 1; i <= parts.length; i += 1) {
			const path = parts.slice(0, i).join('/');
			if (!seen.has(path.toLowerCase())) seen.set(path.toLowerCase(), path);
		}
	}
	return [...seen.entries()]
		.filter(([key]) => !ignored.has(key))
		.map(([, path]) => path)
		.sort((a, b) => a.localeCompare(b))
		.slice(0, cap);
}

// ---- words ----

const files = (n: number) => `${n} found file${n === 1 ? '' : 's'}`;

/** The confirm of "Ignore this folder": what happens, exactly. `shown` is how many open files below it are on screen (an estimate, so it says "any"). */
export function ignoreConfirm(target: Pick<IgnoreTarget, 'folder'>, shown: number): { title: string; lines: string[] } {
	return {
		title: `Stop scanning ${target.folder}?`,
		lines: [
			'The crawler will leave this folder and everything in it alone.',
			shown > 0
				? `Any found files below it that are still in your Inbox (${files(shown)} shown here) move to Dismissed. You can restore them.`
				: 'Any found files below it that are still in your Inbox move to Dismissed. You can restore them.',
			'Files already linked stay linked. Nothing on the share is changed.',
		],
	};
}

/** The notice after a rule was added: the real count from the server. */
export const ignoredText = (folder: string, dismissed: number): string =>
	`Ignoring ${folder}. ${dismissed === 0 ? 'No found files moved to Dismissed.' : `${files(dismissed)} moved to Dismissed.`}`;

/** The notice after a rule was removed. The files the rule dismissed stay in Dismissed. */
export const unignoredText = (folder: string, rescanQueued: boolean): string =>
	`Stopped ignoring ${folder}. ${rescanQueued ? 'A rescan is queued, so it is listed again soon.' : 'It is listed again at the next scan.'} Files already dismissed stay in Dismissed.`;

export const VIEWER_TEXT = 'You can see these rules but not change them.';
export const IGNORE_HINT = 'The crawler leaves these folders and everything in them alone. Nothing on the share is changed.';
