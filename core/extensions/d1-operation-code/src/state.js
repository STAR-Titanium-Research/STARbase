// Pure state logic for the operation-code box (no Vue, no network).
// The database builds the code; the box only decides whether the user has taken over.

const text = (v) => (v === null || v === undefined ? '' : String(v));
const clean = (v) => text(v).trim(); // the trigger btrims written codes, so compare and emit trimmed

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
