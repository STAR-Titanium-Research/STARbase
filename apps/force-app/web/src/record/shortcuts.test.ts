import { describe, expect, it } from 'vitest';
import { isTypingTarget, resolveShortcut, shortcutHints, type KeyLike, type ShortcutContext } from './shortcuts';

const ctx = (o: Partial<ShortcutContext> = {}): ShortcutContext => ({
	record: true, canStart: true, canStop: false, alarmShowing: false, canNew: false, saveDialogOpen: false, modalOpen: false, ...o,
});
const key = (k: string, o: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });

describe('Start', () => {
	it('Ctrl+Enter and Cmd+Enter start when the Start button is usable', () => {
		expect(resolveShortcut(key('Enter', { ctrlKey: true }), ctx())).toBe('start');
		expect(resolveShortcut(key('Enter', { metaKey: true }), ctx())).toBe('start');
	});
	it('does nothing when Start is disabled or hidden, or in Replay', () => {
		expect(resolveShortcut(key('Enter', { ctrlKey: true }), ctx({ canStart: false }))).toBeNull();
		expect(resolveShortcut(key('Enter', { ctrlKey: true }), ctx({ record: false }))).toBeNull();
	});
	it('needs the modifier, and not Alt or Shift as well', () => {
		expect(resolveShortcut(key('Enter'), ctx())).toBeNull();
		expect(resolveShortcut(key('Enter', { ctrlKey: true, shiftKey: true }), ctx())).toBeNull();
		expect(resolveShortcut(key('Enter', { ctrlKey: true, altKey: true }), ctx())).toBeNull();
		expect(resolveShortcut(key('Enter', { ctrlKey: true, metaKey: true }), ctx())).toBeNull();
	});
});

describe('Stop', () => {
	it('Ctrl/Cmd+. stops while the Stop button is usable', () => {
		expect(resolveShortcut(key('.', { ctrlKey: true }), ctx({ canStop: true, canStart: false }))).toBe('stop');
		expect(resolveShortcut(key('.', { metaKey: true }), ctx({ canStop: true }))).toBe('stop');
		expect(resolveShortcut(key('.', { ctrlKey: true }), ctx({ canStop: false }))).toBeNull();
		expect(resolveShortcut(key('.', { ctrlKey: true }), ctx({ canStop: true, record: false }))).toBeNull();
	});
	it('never uses Space or Escape for Start or Stop', () => {
		for (const k of [' ', 'Escape']) {
			for (const mods of [{}, { ctrlKey: true }, { metaKey: true }]) {
				expect(resolveShortcut(key(k, mods), ctx({ canStop: true }))).toBeNull();
			}
		}
	});
});

describe('Acknowledge', () => {
	it('A only while the alarm overlay shows', () => {
		expect(resolveShortcut(key('a'), ctx({ alarmShowing: true }))).toBe('acknowledge');
		expect(resolveShortcut(key('A'), ctx({ alarmShowing: true }))).toBe('acknowledge');
		expect(resolveShortcut(key('a'), ctx())).toBeNull();
	});
	it('ignores A with a modifier (Ctrl+A is select all)', () => {
		expect(resolveShortcut(key('a', { ctrlKey: true }), ctx({ alarmShowing: true }))).toBeNull();
		expect(resolveShortcut(key('a', { metaKey: true }), ctx({ alarmShowing: true }))).toBeNull();
	});
});

describe('New', () => {
	it('Ctrl/Cmd+N only once a cut is done', () => {
		expect(resolveShortcut(key('n', { ctrlKey: true }), ctx({ canNew: true }))).toBe('new');
		expect(resolveShortcut(key('N', { metaKey: true }), ctx({ canNew: true }))).toBe('new');
		expect(resolveShortcut(key('n', { ctrlKey: true }), ctx())).toBeNull();
		expect(resolveShortcut(key('n', { ctrlKey: true }), ctx({ canNew: true, record: false }))).toBeNull();
	});
});

describe('typing and modals', () => {
	it('ignores everything while typing in a field', () => {
		for (const target of [{ tagName: 'INPUT', type: 'text' }, { tagName: 'INPUT' }, { tagName: 'INPUT', type: 'number' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
			expect(resolveShortcut(key('Enter', { ctrlKey: true, target }), ctx())).toBeNull();
			expect(resolveShortcut(key('a', { target }), ctx({ alarmShowing: true }))).toBeNull();
			expect(resolveShortcut(key('n', { ctrlKey: true, target }), ctx({ canNew: true }))).toBeNull();
		}
	});
	it('a focused checkbox or button is not typing', () => {
		expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
		expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
		expect(resolveShortcut(key('Enter', { ctrlKey: true, target: { tagName: 'BUTTON' } }), ctx())).toBe('start');
	});
	it('does nothing while the confirm prompt is open, or on key repeat', () => {
		expect(resolveShortcut(key('Enter', { ctrlKey: true }), ctx({ modalOpen: true }))).toBeNull();
		expect(resolveShortcut(key('a'), ctx({ modalOpen: true, alarmShowing: true }))).toBeNull();
		expect(resolveShortcut(key('Enter', { ctrlKey: true, repeat: true }), ctx())).toBeNull();
		expect(resolveShortcut(key('Enter', { ctrlKey: true, isComposing: true }), ctx())).toBeNull();
	});
});

describe('save dialog', () => {
	const open = ctx({ saveDialogOpen: true, canStart: true, canNew: true });
	it('plain Enter confirms, including from a checkbox or a field inside it', () => {
		expect(resolveShortcut(key('Enter'), open)).toBe('save');
		expect(resolveShortcut(key('Enter', { target: { tagName: 'INPUT', type: 'checkbox' } }), open)).toBe('save');
		expect(resolveShortcut(key('Enter', { target: { tagName: 'INPUT', type: 'text' } }), open)).toBe('save');
		expect(resolveShortcut(key('Enter', { target: { tagName: 'DIV' } }), open)).toBe('save');
	});
	it('leaves Enter to a focused button, link, textarea or select', () => {
		for (const tagName of ['BUTTON', 'A', 'TEXTAREA', 'SELECT']) {
			expect(resolveShortcut(key('Enter', { target: { tagName } }), open)).toBeNull();
		}
	});
	it('blocks the page shortcuts behind the modal', () => {
		expect(resolveShortcut(key('Enter', { ctrlKey: true }), open)).toBeNull();
		expect(resolveShortcut(key('n', { ctrlKey: true }), open)).toBeNull();
	});
	it('A still acknowledges a showing alarm while the dialog is open (stop-on-alarm)', () => {
		expect(resolveShortcut(key('a'), { ...open, alarmShowing: true })).toBe('acknowledge');
		expect(resolveShortcut(key('A'), { ...open, alarmShowing: true, canStart: false })).toBe('acknowledge');
		expect(resolveShortcut(key('a', { target: { tagName: 'BUTTON' } }), { ...open, alarmShowing: true })).toBe('acknowledge');
	});
	it('A does nothing in the dialog when no alarm is showing, or while typing in a dialog field', () => {
		expect(resolveShortcut(key('a'), open)).toBeNull();
		expect(resolveShortcut(key('a', { target: { tagName: 'INPUT', type: 'text' } }), { ...open, alarmShowing: true })).toBeNull();
		expect(resolveShortcut(key('a', { target: { tagName: 'TEXTAREA' } }), { ...open, alarmShowing: true })).toBeNull();
	});
	it('a confirm prompt still owns the keyboard even with an alarm showing', () => {
		expect(resolveShortcut(key('a'), { ...open, modalOpen: true, alarmShowing: true })).toBeNull();
	});
	it('plain Enter outside the dialog does nothing', () => {
		expect(resolveShortcut(key('Enter'), ctx())).toBeNull();
	});
});

describe('shortcutHints', () => {
	it('uses Cmd on a Mac and Ctrl elsewhere', () => {
		expect(shortcutHints(true)[0].keys).toBe('Cmd+Enter');
		expect(shortcutHints(false)[0].keys).toBe('Ctrl+Enter');
		expect(shortcutHints(false).map((h) => h.label)).toContain('Stop');
	});
});
