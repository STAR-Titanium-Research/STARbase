// The one amber note a person's row may carry: shown only when something is off (the row's `attention` is not empty).
import { ATTENTION_LABELS, type PeopleRow } from './peopleQuery';

// Short, per-person wording for each d1_private.people_attention() key (the list's "Needs attention" line counts them; a row names its own).
const NOTES: Record<string, string> = {
	invite_not_accepted: 'Invite not accepted',
	missing_email: 'Missing email',
	possible_duplicate: 'Possible duplicate',
	former_login_active: 'Former, login still active',
	suspended_owns_records: 'Suspended, still owns records',
};

/** The note for a row, or null when nothing is off (a login without a person has its own "Link to a person…" action instead). */
export function rowNote(r: PeopleRow): string | null {
	if (r.kind !== 'person' || !r.attention.length) return null;
	if (r.attention.includes('invite_not_accepted')) return NOTES.invite_not_accepted!;
	if (r.login?.status === 'suspended') return 'Suspended';
	const key = r.attention[0]!;
	return NOTES[key] ?? ATTENTION_LABELS[key]?.(1) ?? key;
}
