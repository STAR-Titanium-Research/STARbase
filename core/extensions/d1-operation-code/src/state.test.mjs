import test from 'node:test';
import assert from 'node:assert/strict';
import { initialMode, onTyped, onRegenerate, shown } from './state.js';

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

test('initialMode: empty value against a real preview is typed (nothing to compare)', () => {
	assert.equal(initialMode({ isNew: false, value: '', preview: 'S1-FA1' }), 'typed');
	assert.equal(initialMode({ isNew: false, value: null, preview: 'S1-FA1' }), 'typed');
});

test('initialMode: comparison is exact (case and inner spaces matter)', () => {
	assert.equal(initialMode({ isNew: false, value: 's1-fa1', preview: 'S1-FA1' }), 'typed');
});

test('onTyped: empty input goes back to automatic and emits null', () => {
	assert.deepEqual(onTyped('', 'S1-FA1'), { mode: 'auto', emit: null });
	assert.deepEqual(onTyped(null, 'S1-FA1'), { mode: 'auto', emit: null });
	assert.deepEqual(onTyped(undefined, null), { mode: 'auto', emit: null });
	assert.deepEqual(onTyped('   ', 'S1-FA1'), { mode: 'auto', emit: null });
});

test('onTyped: text equal to the preview stays automatic but is emitted', () => {
	assert.deepEqual(onTyped('S1-FA1', 'S1-FA1'), { mode: 'auto', emit: 'S1-FA1' });
});

test('onTyped: any other text is typed and emitted as written', () => {
	assert.deepEqual(onTyped('MINE', 'S1-FA1'), { mode: 'typed', emit: 'MINE' });
	assert.deepEqual(onTyped('MINE', null), { mode: 'typed', emit: 'MINE' });
	assert.deepEqual(onTyped('MINE', ''), { mode: 'typed', emit: 'MINE' });
	assert.deepEqual(onTyped('S1-FA1 ', 'S1-FA1'), { mode: 'typed', emit: 'S1-FA1 ' });
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
