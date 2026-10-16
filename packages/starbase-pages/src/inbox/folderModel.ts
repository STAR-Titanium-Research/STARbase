// The two admin fields that tie the share to the lab (migration 193): a person's `uni alias` (their personal folder under Users/) and a team's
// `share folder` (its team folder under Shared/). Validated here the way the database does, so an administrator sees the problem before the
// server says it, and the words for what changing either does. Plain functions (no Vue), unit-tested.

/** The database's rule for people.uni_alias: 2 to 64 of letters, digits, `.`, `_`, `-`, and not starting with a dot (so never only dots). */
export const ALIAS_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{1,63}$/;

/** What an administrator typed, ready to save: surrounding spaces are not part of a folder name. Empty means "no folder". */
export const clean = (v: string | null | undefined): string => (v ?? '').trim();

/** Why this uni alias would be refused, or null when it is fine (or empty: a person may have none). */
export function aliasProblem(value: string | null | undefined): string | null {
	const v = clean(value);
	if (v === '') return null;
	if (v.length < 2) return 'A uni alias is at least 2 characters.';
	if (v.length > 64) return 'A uni alias is at most 64 characters.';
	if (/^\.+$/.test(v)) return 'A uni alias cannot be only dots.';
	if (v.startsWith('.')) return 'A uni alias cannot start with a dot.';
	if (!ALIAS_RE.test(v)) return 'Use letters, digits, dots, underscores and hyphens only.';
	return null;
}

/** Why this share folder would be refused, or null when it is fine (or empty: a team may have none). It is a folder name, not a path. */
export function shareFolderProblem(value: string | null | undefined): string | null {
	const raw = value ?? '';
	if (raw === '') return null;
	if (clean(raw) === '') return 'A share folder cannot be blank.';
	const v = clean(raw);
	if (/[\\/]/.test(v)) return 'A share folder is one folder name: no slashes or backslashes.';
	if (/^\.+$/.test(v)) return 'A share folder cannot be only dots.';
	return null;
}

/** The note under the alias and share-folder fields: changing either starts that folder's Inbox afresh. */
export const FOLDER_CHANGE_NOTE = 'Changing this resets the Inbox for this folder; linked files stay linked.';

export const ALIAS_HINT = 'The name of this person\'s folder under Users on the share. An administrator sets it; leave it empty for no folder.';
export const FORMER_HINT = 'Scan the folder of a Former person too. Off: a person marked Former is not scanned.';
export const SHARE_FOLDER_HINT = 'The name of this team\'s folder under Shared on the share, as it appears there. Leave it empty for no folder.';

/**
 * Is this failure a unique violation of `field` (Directus answers RECORD_NOT_UNIQUE with extensions.field)? It is told by the field, never by the
 * message text: people.user_id is unique too, so a login that is already linked fails the same way and must not read as "alias taken". When the
 * answer names no field, `only` says whether the request changed just this one unique column (then it can only be that one).
 */
export function isDuplicateOf(e: any, field: RegExp, { only = false }: { only?: boolean } = {}): boolean {
	const ext = e?.response?.data?.errors?.[0]?.extensions;
	if (ext?.code !== 'RECORD_NOT_UNIQUE') return false;
	if (typeof ext.field === 'string' && ext.field !== '') return field.test(ext.field);
	return only;
}

const ALIAS_FIELD = /uni_alias/;
const FOLDER_FIELD = /share_folder/;

// The administrator may not be able to see who holds it (a person can be Former and hidden by a filter); the message names no one.
export const ALIAS_TAKEN = 'That alias is already used by another person. Aliases are compared without regard to case.';
export const SHARE_FOLDER_TAKEN = 'That share folder is already used by another team. Folder names are compared without regard to case.';

/** What to show when saving an alias or share folder failed: the duplicate wording when the violation is that field's, else the server's own words. */
export function folderSaveError(e: any, kind: 'alias' | 'share_folder', fallback: string, opts: { only?: boolean } = {}): string {
	if (isDuplicateOf(e, kind === 'alias' ? ALIAS_FIELD : FOLDER_FIELD, opts)) return kind === 'alias' ? ALIAS_TAKEN : SHARE_FOLDER_TAKEN;
	return e?.response?.data?.errors?.[0]?.message || e?.message || fallback;
}

/** The body fields to send: only what changed, empty as null. `current` is what the server holds (null when it is a new row). */
export function folderPatch<K extends string>(field: K, typed: string | null | undefined, current: string | null): Partial<Record<K, string | null>> {
	const next = clean(typed) || null;
	return next === (current ?? null) ? {} : ({ [field]: next } as Partial<Record<K, string | null>>);
}
