// Pure state logic for the operation-code box (no Vue, no network).
// The database builds the code; the box only decides whether the user has taken over.

const text = (v) => (v === null || v === undefined ? '' : String(v));
const clean = (v) => text(v).trim(); // the trigger btrims written codes, so compare and emit trimmed

// What the form's primary key says about the item. Directus gives '+' for a new item and the key for
// a saved one; while the form is still setting up the key can be undefined / null, which is neither
// (treating it as new sent the first preview without operation_id, and the endpoint answers
// automatic: true for a new item). 'pending': send nothing and decide nothing until the key arrives.
export function keyState(primaryKey) {
	if (primaryKey === '+') return 'new';
	if (primaryKey === null || primaryKey === undefined || primaryKey === '') return 'pending';
	return 'existing';
}

// Does an answer belong to the item the box shows now? Only when the request was sent with a ready
// key and that key is still the form's key. Anything else (sent while pending, or the key changed
// while it was in flight) is dropped whole: it neither decides the mode nor sets the preview.
export function answerMatches({ sentKey, currentKey }) {
	if (keyState(sentKey) === 'pending') return false;
	return String(sentKey) === String(currentKey);
}

// The form switched from one ready key to another (another item, or '+' -> the saved key without a
// remount): start over, so the next answer for the new key decides the mode. pending -> ready is not a
// switch (nothing was sent before, and a mode the user set by typing meanwhile is kept).
export function keyChangeResets(oldKey, newKey) {
	if (keyState(oldKey) === 'pending' || keyState(newKey) === 'pending') return false;
	return String(oldKey) !== String(newKey);
}

// The mode from a preview answer, or null while it cannot be decided. Once decided (by an earlier
// answer, or by the user typing / pressing the refresh icon) it stays `current`: later answers only
// change the displayed preview. A new item is automatic. An existing one takes the endpoint's
// `automatic`, which the server computes from the SAVED row with the trigger's own test (saved code
// NULL, or equal to the rule's value for the saved row), so it does not depend on how much of the
// record the form holds yet. An answer without a boolean `automatic` (an older endpoint) decides
// nothing: the box keeps showing the saved code.
export function decideMode({ isNew, decided, automatic, current }) {
	if (decided) return current;
	if (isNew) return 'auto';
	if (automatic === true) return 'auto';
	if (automatic === false) return 'typed';
	return null;
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

// What the box displays. `error` and `frozen` need no branch: a frozen operation is typed (shows its
// saved code), and with no preview the box is empty.
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
