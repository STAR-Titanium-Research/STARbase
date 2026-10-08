// Release notes by category (#137). A changelog entry's `notes` stay a flat string[] -- the release
// job reads them with a regex (.github/scripts/release_plan.py), so they can't become objects --
// and the category is the note's leading prefix:
//
//   "Fixed: ..."     -> Fixed
//   "Security: ..."  -> Fixed (the prefix stays: it is the point of the note)
//   "Improved: ..."  -> Improved
//   "New: ..." or no prefix -> New
//
// release_plan.py groups the GitHub Release notes the same way; keep the two in step
// (tests/scripts/test_release_plan.py fails if the prefix tables drift apart).

export type NoteGroupKey = 'new' | 'improved' | 'fixed';

export interface NoteGroup {
	key: NoteGroupKey;
	/** Sub-heading shown above the notes. */
	label: string;
	notes: string[];
}

/** The prefixes a note may start with. Anything else before a colon is just part of the sentence
 *  ("Plot page: ..."), and the note counts as New. */
export const NOTE_PREFIXES: Record<string, { group: NoteGroupKey; strip: boolean }> = {
	New: { group: 'new', strip: true },
	Improved: { group: 'improved', strip: true },
	Fixed: { group: 'fixed', strip: true },
	Security: { group: 'fixed', strip: false },
};

/** Display order of the groups; the sub-heading is the key capitalised. */
const GROUP_KEYS: readonly NoteGroupKey[] = ['new', 'improved', 'fixed'];

const PREFIX_RE = /^([A-Za-z]+):\s+/;

/** Which group a note belongs to, and the text to show for it (prefix removed where it is only a label). */
function classifyNote(note: string): { group: NoteGroupKey; text: string } {
	const m = PREFIX_RE.exec(note);
	if (m && Object.hasOwn(NOTE_PREFIXES, m[1])) {
		const p = NOTE_PREFIXES[m[1]];
		return { group: p.group, text: p.strip ? note.slice(m[0].length) : note };
	}
	return { group: 'new', text: note };
}

/** The notes split into New / Improved / Fixed, in that order, leaving out empty groups. Each
 *  group keeps the notes' original order. */
export function groupNotes(notes: readonly string[]): NoteGroup[] {
	const buckets: Record<NoteGroupKey, string[]> = { new: [], improved: [], fixed: [] };
	for (const n of notes) {
		const { group, text } = classifyNote(n);
		buckets[group].push(text);
	}
	return GROUP_KEYS.filter((key) => buckets[key].length > 0).map((key) => ({
		key,
		label: key[0].toUpperCase() + key.slice(1),
		notes: buckets[key],
	}));
}
