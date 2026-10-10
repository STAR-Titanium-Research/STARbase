import test from 'node:test';
import assert from 'node:assert/strict';
import { initialMode, nextMode, recordLoaded, canDecide, afterFieldChange, onTyped, onRegenerate, shown, hint, canRegenerate } from './state.js';

test('initialMode: a new record starts automatic whatever the value', () => {
	assert.equal(initialMode({ isNew: true, value: null, preview: 'A-1' }), 'auto');
	assert.equal(initialMode({ isNew: true, value: 'typed', preview: 'A-1' }), 'auto');
	assert.equal(initialMode({ isNew: true, value: '', preview: null }), 'auto');
});

test('initialMode: existing record whose code equals the preview is automatic', () => {
	assert.equal(initialMode({ isNew: false, value: 'S1-FA1', preview: 'S1-FA1' }), 'auto');
});

test('initialMode: existing record with a different code is typed', () => {
	assert.equal(initialMode({ isNew: false, value: 'MINE', preview: 'S1-FA1' }), 'typed');
	assert.equal(initialMode({ isNew: false, value: 'MINE', preview: null }), 'typed');
	assert.equal(initialMode({ isNew: false, value: 'MINE', preview: '' }), 'typed');
});

test('initialMode: both empty (null / undefined / empty string) is automatic', () => {
	assert.equal(initialMode({ isNew: false, value: null, preview: null }), 'auto');
	assert.equal(initialMode({ isNew: false, value: '', preview: null }), 'auto');
	assert.equal(initialMode({ isNew: false, value: undefined, preview: '' }), 'auto');
	assert.equal(initialMode({ isNew: false, value: null, preview: undefined }), 'auto');
});

test('initialMode: whitespace-only counts as empty', () => {
	assert.equal(initialMode({ isNew: false, value: '  ', preview: null }), 'auto');
	assert.equal(initialMode({ isNew: false, value: null, preview: ' ' }), 'auto');
});

test('initialMode: an existing record with no code is automatic whatever the preview (the trigger builds it)', () => {
	assert.equal(initialMode({ isNew: false, value: '', preview: 'S1-FA1' }), 'auto');
	assert.equal(initialMode({ isNew: false, value: null, preview: 'S1-FA1' }), 'auto');
	assert.equal(initialMode({ isNew: false, value: '  ', preview: 'S1-FA1' }), 'auto');
});

test('initialMode: surrounding whitespace is ignored when comparing', () => {
	assert.equal(initialMode({ isNew: false, value: ' S1-FA1 ', preview: 'S1-FA1' }), 'auto');
	assert.equal(initialMode({ isNew: false, value: 'S1-FA1', preview: ' S1-FA1' }), 'auto');
});

test('initialMode: comparison is exact otherwise (case matters)', () => {
	assert.equal(initialMode({ isNew: false, value: 's1-fa1', preview: 'S1-FA1' }), 'typed');
});

test('onTyped: empty input goes back to automatic and emits null', () => {
	assert.deepEqual(onTyped('', 'S1-FA1'), { mode: 'auto', emit: null });
	assert.deepEqual(onTyped(null, 'S1-FA1'), { mode: 'auto', emit: null });
	assert.deepEqual(onTyped(undefined, null), { mode: 'auto', emit: null });
	assert.deepEqual(onTyped('   ', 'S1-FA1'), { mode: 'auto', emit: null });
});

test('onTyped: text equal to the preview is automatic and emits null (no stale written code)', () => {
	assert.deepEqual(onTyped('S1-FA1', 'S1-FA1'), { mode: 'auto', emit: null });
	assert.deepEqual(onTyped(' S1-FA1 ', 'S1-FA1'), { mode: 'auto', emit: null });
});

test('onTyped: any other text is typed and emitted trimmed', () => {
	assert.deepEqual(onTyped('MINE', 'S1-FA1'), { mode: 'typed', emit: 'MINE' });
	assert.deepEqual(onTyped('MINE', null), { mode: 'typed', emit: 'MINE' });
	assert.deepEqual(onTyped('MINE', ''), { mode: 'typed', emit: 'MINE' });
	assert.deepEqual(onTyped('  MINE  ', 'S1-FA1'), { mode: 'typed', emit: 'MINE' }); // the trigger btrims
	assert.deepEqual(onTyped('s1-fa1', 'S1-FA1'), { mode: 'typed', emit: 's1-fa1' });
});

test('onRegenerate: automatic, emits null', () => {
	assert.deepEqual(onRegenerate(), { mode: 'auto', emit: null });
});

test('shown: auto shows the preview, or empty text when there is none', () => {
	assert.equal(shown({ mode: 'auto', value: 'OLD', preview: 'S1-FA1', error: false }), 'S1-FA1');
	assert.equal(shown({ mode: 'auto', value: 'OLD', preview: null, error: false }), '');
	assert.equal(shown({ mode: 'auto', value: 'OLD', preview: undefined, error: true }), '');
	assert.equal(shown({ mode: 'auto', value: null, preview: '', error: false }), '');
});

test('shown: typed shows the value', () => {
	assert.equal(shown({ mode: 'typed', value: 'MINE', preview: 'S1-FA1', error: false }), 'MINE');
	assert.equal(shown({ mode: 'typed', value: null, preview: 'S1-FA1', error: false }), '');
	assert.equal(shown({ mode: 'typed', value: undefined, preview: null, error: true }), '');
});

test('shown: a frozen op (its preview is its saved code) shows that code in auto and what was typed in typed', () => {
	assert.equal(shown({ mode: 'auto', value: 'OLD', preview: 'OLD', error: false, frozen: true }), 'OLD');
	assert.equal(shown({ mode: 'typed', value: 'NEW', preview: 'OLD', error: false, frozen: true }), 'NEW');
});

test('canRegenerate: the refresh icon only in typed mode, never for a frozen op', () => {
	assert.equal(canRegenerate({ mode: 'typed', frozen: false }), true);
	assert.equal(canRegenerate({ mode: 'auto', frozen: false }), false);
	assert.equal(canRegenerate({ mode: 'typed', frozen: true }), false);
	assert.equal(canRegenerate({ mode: 'auto', frozen: true }), false);
});

const TYPED = 'Typed: kept as you wrote it — ↻ to go back to automatic.';
const base = { mode: 'auto', frozen: false, hidden: false, failed: false, noPreview: false, sintering: false };
test('hint: the brief strings', () => {
	assert.equal(hint(base), 'Automatic: follows the fields below.');
	assert.equal(hint({ ...base, mode: 'typed' }), TYPED);
	assert.equal(hint({ ...base, hidden: true }), 'Automatic: the database builds the code on save.');
	assert.equal(hint({ ...base, failed: true }), 'Preview unavailable — the database still builds the code on save.');
	assert.equal(hint({ ...base, noPreview: true, sintering: true }), 'Set the run number to get a code.');
	assert.equal(hint({ ...base, noPreview: true }), 'Automatic: follows the fields below.');
});

test('hint: frozen wins over everything, typed or not', () => {
	const f = 'Imported from the experiment sheets: this code is fixed (type to rename).';
	assert.equal(hint({ ...base, frozen: true }), f);
	assert.equal(hint({ ...base, frozen: true, mode: 'typed' }), f);
	assert.equal(hint({ ...base, frozen: true, failed: true }), f);
});

test('hint: typed beats the preview-state hints', () => {
	assert.equal(hint({ ...base, mode: 'typed', hidden: true }), TYPED);
});

test('nextMode: before any interaction it follows initialMode on every preview', () => {
	const e = { touched: false, isNew: false, current: 'auto' };
	// first preview null (form not loaded yet), then the real code
	assert.equal(nextMode({ ...e, value: 'S1-FA1', preview: null, current: 'auto' }), 'typed');
	assert.equal(nextMode({ ...e, value: 'S1-FA1', preview: 'S1-FA1', current: 'typed' }), 'auto');
	// a real written code that differs from the rule stays typed
	assert.equal(nextMode({ ...e, value: 'MINE', preview: 'S1-FA1', current: 'typed' }), 'typed');
	assert.equal(nextMode({ ...e, value: 'MINE', preview: 'S1-FA1', current: 'auto' }), 'typed');
	// no code yet: automatic
	assert.equal(nextMode({ ...e, value: null, preview: 'S1-FA1', current: 'typed' }), 'auto');
});

test('nextMode: a new record is automatic', () => {
	assert.equal(nextMode({ touched: false, isNew: true, value: 'x', preview: 'y', current: 'typed' }), 'auto');
});

test('nextMode: after the user touched the box the mode never flips back', () => {
	assert.equal(nextMode({ touched: true, isNew: false, value: 'S1-FA1', preview: 'S1-FA1', current: 'typed' }), 'typed');
	assert.equal(nextMode({ touched: true, isNew: false, value: 'MINE', preview: 'S1-FA1', current: 'auto' }), 'auto');
	assert.equal(nextMode({ touched: true, isNew: true, value: null, preview: null, current: 'typed' }), 'typed');
});

test('afterFieldChange: a field edit takes over only once a mode has been decided', () => {
	assert.equal(afterFieldChange({ touched: false, decided: true }), true);
	assert.equal(afterFieldChange({ touched: false, decided: false }), false);
	assert.equal(afterFieldChange({ touched: true, decided: false }), true);
});

test('never decided + field edit: the next good preview still decides the mode', () => {
	// the first preview failed (nothing decided), the user edits a field, then a good preview arrives
	const touched = afterFieldChange({ touched: false, decided: false });
	assert.equal(nextMode({ touched, isNew: false, value: 'MINE', preview: 'S1-FA1', current: 'auto' }), 'typed');
	assert.equal(nextMode({ touched, isNew: false, value: 'S1-FA1', preview: 'S1-FA1', current: 'auto' }), 'auto');
});

test('recordLoaded: a new item is ready at once; an existing one only when its record is in the form', () => {
	assert.equal(recordLoaded({ isNew: true, values: {}, primaryKey: '+' }), true);
	assert.equal(recordLoaded({ isNew: false, values: undefined, primaryKey: 'op-1' }), false);
	assert.equal(recordLoaded({ isNew: false, values: {}, primaryKey: 'op-1' }), false);
	// the primary key alone arrives before the rest of the record
	assert.equal(recordLoaded({ isNew: false, values: { operation_id: 'op-1' }, primaryKey: 'op-1' }), false);
	assert.equal(recordLoaded({ isNew: false, values: { operation_id: 'op-1', version: null }, primaryKey: 'op-1' }), false);
	assert.equal(recordLoaded({ isNew: false, values: { operation_id: 'op-1', version: 3 }, primaryKey: 'op-1' }), true);
	assert.equal(recordLoaded({ isNew: false, values: { operation_id: 'op-1', version: 0 }, primaryKey: 'op-1' }), true);
	// another record's values
	assert.equal(recordLoaded({ isNew: false, values: { operation_id: 'op-2', version: 3 }, primaryKey: 'op-1' }), false);
	// a numeric key against a string one
	assert.equal(recordLoaded({ isNew: false, values: { operation_id: 7, version: 1 }, primaryKey: '7' }), true);
});

test('canDecide: an existing item is not decided while its value is still undefined (not loaded)', () => {
	assert.equal(canDecide({ isNew: false, value: undefined }), false);
	assert.equal(canDecide({ isNew: false, value: null }), true);
	assert.equal(canDecide({ isNew: false, value: 'X' }), true);
	assert.equal(canDecide({ isNew: true, value: undefined }), true);
});
