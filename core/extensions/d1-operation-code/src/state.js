// Pure state logic for the operation-code box (no Vue, no network).
// The database builds the code; the box only decides whether the user has taken over.

const text = (v) => (v === null || v === undefined ? '' : String(v));
const clean = (v) => text(v).trim(); // the trigger btrims written codes, so compare and emit trimmed
const isEmpty = (v) => clean(v) === '';

// New record -> automatic. Existing record -> automatic when it has no code yet (the trigger treats
// a NULL code as automatic) or its saved code is what the rule gives now; otherwise the user wrote
// it: typed.
export function initialMode({ isNew, value, preview }) {
	if (isNew) return 'auto';
	if (isEmpty(value)) return 'auto';
	return clean(value) === clean(preview) ? 'auto' : 'typed';
}

// The mode after a preview arrives. Until the user takes over (types in the box, presses the refresh
// icon, or edits a field of the form) every successful preview re-decides it, so an early answer
// built from a half-loaded form cannot stick; once touched the mode is the user's. `current` is the
// mode in force.
export function nextMode({ touched, isNew, value, preview, current }) {
	if (touched) return current;
	return initialMode({ isNew, value, preview });
}

// Is the form ready to preview? A new item always is. An existing one only when the form holds the
// record: Directus puts the primary key into the values before the rest of the record, so the key
// alone is not enough; `version` (NOT NULL on every operation) proves the load. Relies on
// `operation_id` and `version` being in the values; if they are not, no preview is sent (fails safe).
export function recordLoaded({ isNew, values, primaryKey }) {
	if (isNew) return true;
	return String(values?.operation_id ?? '') === String(primaryKey ?? '') && values?.version != null;
}

// A mode is not decided from a preview while an existing item's value is still undefined (Directus
// passes undefined before the load, null for a record that really has no code).
export function canDecide({ isNew, value }) {
	return isNew || value !== undefined;
}

// A change to a field of the form: the user has taken over, but only once a mode was decided (a
// preview that failed or is still in flight has decided nothing, so the next good one still must).
export function afterFieldChange({ touched, decided }) {
	return touched || decided;
}

// The user edited the box. Empty, or equal to the preview -> automatic and emit null (the database
// builds the code, so no written code can go stale after a later field edit). Anything else ->
// typed, emitted trimmed.
export function onTyped(value, preview) {
	const t = clean(value);
	if (t === '' || t === clean(preview)) return { mode: 'auto', emit: null };
	return { mode: 'typed', emit: t };
}

// The refresh icon: give the code back to the database.
export function onRegenerate() {
	return { mode: 'auto', emit: null };
}

// What the box displays. `error` and `frozen` need no branch: a frozen operation's preview is its
// saved code, and with no preview the box is empty.
export function shown({ mode, value, preview }) {
	return mode === 'typed' ? text(value) : text(preview);
}

// The refresh icon is offered only while typed, and never for a frozen operation.
export function canRegenerate({ mode, frozen }) {
	return mode === 'typed' && !frozen;
}

// The line under the box. noPreview: a decided, successful answer with no code.
export function hint({ mode, frozen, hidden, failed, noPreview, sintering }) {
	if (frozen) return 'Imported from the experiment sheets: this code is fixed (type to rename).';
	if (mode === 'typed') return 'Typed: kept as you wrote it — ↻ to go back to automatic.';
	if (hidden) return 'Automatic: the database builds the code on save.';
	if (failed) return 'Preview unavailable — the database still builds the code on save.';
	if (noPreview && sintering) return 'Set the run number to get a code.';
	return 'Automatic: follows the fields below.';
}
