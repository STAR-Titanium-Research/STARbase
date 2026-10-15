// Edit mode's keyboard (spec E21). The decisions are a pure function of the key and what is going on (`keyDecision`), tested without a
// browser; the composable puts one keydown on the window while a draft can be changed and calls what the page gives it.
//
//   Shift+A                        the Add menu, unconnected, at the pointer
//   Delete, Backspace              remove the selected draft item
//   Shift+D, Ctrl/⌘+D              duplicate it; Shift+Ctrl/⌘+D asks how many copies
//   Ctrl/⌘+Z                       undo; Ctrl/⌘+Shift+Z (or Ctrl+Y) redo
//
// (Enter on a focused socket opens its menu and C on one opens "Connect to…": those are the socket's own keys, useEditCanvas.)
// Keys are ignored while the person types in a field, while a menu or the sample picker is open, and with a modifier they do not name.
// A key that has nothing to act on (Delete with nothing selected) is left to the browser.

import { getCurrentInstance, onBeforeUnmount, onMounted } from 'vue';

export type EditKeyAction = { do: 'add' } | { do: 'undo' } | { do: 'redo' } | { do: 'remove' } | { do: 'duplicate' } | { do: 'duplicateMany' };

export interface KeyEvent {
	key: string;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
}

export interface KeyState {
	/** A text field (or a select, or something editable) has focus: it takes the key. */
	typing: boolean;
	/** A menu, dialog or the sample picker is open: they have their own keys. */
	blocked: boolean;
}

export function keyDecision(e: KeyEvent, s: KeyState): EditKeyAction | null {
	if (s.typing || s.blocked || e.altKey) return null;
	const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
	if (e.ctrlKey || e.metaKey) {
		if (key === 'z') return e.shiftKey ? { do: 'redo' } : { do: 'undo' };
		if (key === 'y' && !e.shiftKey) return { do: 'redo' };
		if (key === 'd') return e.shiftKey ? { do: 'duplicateMany' } : { do: 'duplicate' };
		return null;
	}
	if (e.shiftKey) {
		if (key === 'a') return { do: 'add' };
		if (key === 'd') return { do: 'duplicate' };
		return null;
	}
	if (key === 'Delete' || key === 'Backspace') return { do: 'remove' };
	return null;
}

/** True when the focused element takes typed text. */
export function isTyping(target: unknown): boolean {
	const el = target as { tagName?: string; isContentEditable?: boolean } | null;
	const tag = el?.tagName?.toLowerCase();
	return tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable === true;
}

export interface EditKeysOptions {
	/** Keys are live only while a draft can be changed. */
	editing: () => boolean;
	/** A menu or dialog is open. */
	blocked: () => boolean;
	/** Where the pointer last was (client pixels), for a menu that opens "at the pointer". */
	pointer: () => { x: number; y: number };
	add: (at: { x: number; y: number }) => void;
	undo: () => void;
	redo: () => void;
	/** Each returns whether there was something to act on (the selected draft item); the key is the browser's when not. */
	remove: () => boolean;
	duplicate: () => boolean;
	duplicateMany: () => boolean;
}

export function useEditKeys(o: EditKeysOptions) {
	function onKeydown(e: KeyboardEvent): void {
		if (!o.editing()) return;
		const d = keyDecision(e, { typing: isTyping(e.target), blocked: o.blocked() });
		if (!d) return;
		let handled = true;
		switch (d.do) {
			case 'add':
				o.add(o.pointer());
				break;
			case 'undo':
				o.undo();
				break;
			case 'redo':
				o.redo();
				break;
			case 'remove':
				handled = o.remove();
				break;
			case 'duplicate':
				handled = o.duplicate();
				break;
			case 'duplicateMany':
				handled = o.duplicateMany();
				break;
		}
		if (handled) e.preventDefault();
	}
	if (getCurrentInstance()) {
		onMounted(() => window.addEventListener('keydown', onKeydown));
		onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
	}
	return { onKeydown };
}
