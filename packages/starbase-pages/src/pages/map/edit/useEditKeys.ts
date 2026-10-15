// Edit mode's keyboard (spec E21). The decisions are a pure function of the key and what is going on (`keyDecision`), tested without a
// browser; the composable puts one keydown on the window while a draft can be changed and calls what the page gives it.
//
//   Shift+A                        the Add menu, unconnected, at the pointer
//
// Keys are ignored while the person types in a field, while a menu or the sample picker is open, and with a modifier they do not name.

import { getCurrentInstance, onBeforeUnmount, onMounted } from 'vue';

export type EditKeyAction = { do: 'add' };

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
	if (s.typing || s.blocked) return null;
	const mod = !!(e.ctrlKey || e.metaKey);
	if (!mod && !e.altKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) return { do: 'add' };
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
}

export function useEditKeys(o: EditKeysOptions) {
	function onKeydown(e: KeyboardEvent): void {
		if (!o.editing()) return;
		const d = keyDecision(e, { typing: isTyping(e.target), blocked: o.blocked() });
		if (!d) return;
		e.preventDefault();
		if (d.do === 'add') o.add(o.pointer());
	}
	if (getCurrentInstance()) {
		onMounted(() => window.addEventListener('keydown', onKeydown));
		onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
	}
	return { onKeydown };
}
