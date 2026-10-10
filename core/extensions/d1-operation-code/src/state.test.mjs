import test from 'node:test';
import assert from 'node:assert/strict';
import { decideMode, onTyped, onRegenerate, shown, hint, canRegenerate } from './state.js';

test('decideMode: a new item is automatic', () => {
	assert.equal(decideMode({ isNew: true, decided: false, automatic: true, current: 'auto' }), 'auto');
	assert.equal(decideMode({ isNew: true, decided: false, automatic: undefined, current: 'typed' }), 'auto');
});

test("decideMode: an existing item takes the endpoint's automatic flag (the saved row's test)", () => {
	const e = { isNew: false, decided: false, current: 'auto' };
	assert.equal(decideMode({ ...e, automatic: true }), 'auto');
	assert.equal(decideMode({ ...e, automatic: false }), 'typed');
	assert.equal(decideMode({ ...e, automatic: true, current: 'typed' }), 'auto');
});

test('decideMode: the live case: a typed saved code is typed whatever the form-built preview says', () => {
	// op 49eb731a: saved DEMO-TI64-001-F1, rule DEMO-TI64-001-F5-...; the first preview was {code: null}.
	// The preview is not an input at all: only the server's flag counts.
	assert.equal(decideMode({ isNew: false, decided: false, automatic: false, current: 'auto' }), 'typed');
});

test('decideMode: once decided (an earlier answer, typing, or the refresh icon) later answers never change it', () => {
	assert.equal(decideMode({ isNew: false, decided: true, automatic: true, current: 'typed' }), 'typed');
	assert.equal(decideMode({ isNew: false, decided: true, automatic: false, current: 'auto' }), 'auto');
	assert.equal(decideMode({ isNew: true, decided: true, automatic: true, current: 'typed' }), 'typed');
});

test('decideMode: an answer without a boolean automatic (an older endpoint) decides nothing', () => {
	for (const automatic of [undefined, null, 'true', 1]) {
		assert.equal(decideMode({ isNew: false, decided: false, automatic, current: 'auto' }), null, String(automatic));
	}
});

test('decideMode: a frozen operation (automatic: false) is typed: shows its saved code, no refresh icon, frozen hint', () => {
	const mode = decideMode({ isNew: false, decided: false, automatic: false, current: 'auto' });
	assert.equal(mode, 'typed');
	assert.equal(shown({ mode, value: 'IMPORTED', preview: 'IMPORTED' }), 'IMPORTED');
	assert.equal(canRegenerate({ mode, frozen: true }), false);
	assert.match(hint({ mode, frozen: true, hidden: false, failed: false, noPreview: false, sintering: false }), /^Imported from the experiment sheets/);
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
