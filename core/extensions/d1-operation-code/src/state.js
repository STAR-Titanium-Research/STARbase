// Pure state logic for the operation-code box (no Vue, no network).
// The database builds the code; the box only decides whether the user has taken over.

const text = (v) => (v === null || v === undefined ? '' : String(v));
const isEmpty = (v) => text(v).trim() === '';

// New record -> automatic. Existing record -> automatic when its saved code is what the rule
// gives now (or there is nothing on either side), otherwise the user wrote it: typed.
export function initialMode({ isNew, value, preview }) {
	if (isNew) return 'auto';
	if (isEmpty(value) && isEmpty(preview)) return 'auto';
	return text(value) === text(preview) ? 'auto' : 'typed';
}

// The user edited the box. Empty -> back to automatic (emit null so the database builds it).
// Equal to the preview -> still automatic, but the written code is emitted (the database keeps
// a code equal to the rule's as automatic). Anything else -> typed, kept as written.
export function onTyped(value, preview) {
	if (isEmpty(value)) return { mode: 'auto', emit: null };
	const t = text(value);
	if (t === text(preview)) return { mode: 'auto', emit: t };
	return { mode: 'typed', emit: t };
}

// The refresh icon: give the code back to the database.
export function onRegenerate() {
	return { mode: 'auto', emit: null };
}

// What the box displays. `error` is accepted for symmetry; with no preview the box is empty.
export function shown({ mode, value, preview }) {
	return mode === 'typed' ? text(value) : text(preview);
}
