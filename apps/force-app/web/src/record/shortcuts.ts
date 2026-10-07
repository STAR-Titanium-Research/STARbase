// R10: keyboard shortcuts for the Record page, as a pure key -> action mapping. RecordPage.vue owns
// the single listener and the context; the actions call the same workspace functions the buttons
// call (requestStart, stop, newRun, ackAlarm), so every gate the buttons have applies here too.
//
// Never Space or Escape for Start/Stop: Space activates whatever button has focus and Escape
// dismisses dialogs, so either would start or stop a cut by accident.

export type ShortcutAction = 'start' | 'stop' | 'acknowledge' | 'new' | 'save';

export interface ShortcutContext {
	/** Record mode (not Replay/playback): Start, Stop and New don't apply in Replay. */
	record: boolean;
	/** The Start button is showing and enabled (same condition as the button). */
	canStart: boolean;
	/** The Stop button is showing and enabled. */
	canStop: boolean;
	/** The alarm overlay is on screen. */
	alarmShowing: boolean;
	/** A cut is finished (the New button is showing) and nothing else is in front of it. */
	canNew: boolean;
	/** The end-of-cut save dialog is open. */
	saveDialogOpen: boolean;
	/** Another modal (the confirm prompt) is open and owns the keyboard. */
	modalOpen: boolean;
}

export interface TargetLike { tagName?: string; type?: string; isContentEditable?: boolean }

export interface KeyLike {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	repeat?: boolean;
	isComposing?: boolean;
	target?: TargetLike | null;
}

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'image', 'color']);

/** Focus is somewhere the operator is typing: input (text-like), textarea, select, contenteditable. */
export function isTypingTarget(t: TargetLike | null | undefined): boolean {
	if (!t) return false;
	if (t.isContentEditable) return true;
	const tag = (t.tagName || '').toUpperCase();
	if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
	if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((t.type || 'text').toLowerCase());
	return false;
}

export function resolveShortcut(e: KeyLike, ctx: ShortcutContext): ShortcutAction | null {
	if (ctx.modalOpen || e.repeat || e.isComposing) return null;
	const key = e.key;
	const mod = e.ctrlKey !== e.metaKey; // exactly one of Ctrl / Cmd
	const none = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;

	// Enter confirms the save dialog's primary action, also from a checkbox or a field inside it.
	// A focused button or link keeps its own Enter (it activates itself); textarea/select need it.
	if (ctx.saveDialogOpen && key === 'Enter' && none) {
		const tag = (e.target?.tagName || '').toUpperCase();
		if (tag === 'BUTTON' || tag === 'A' || tag === 'TEXTAREA' || tag === 'SELECT') return null;
		return 'save';
	}

	// Silencing a safety alarm is never blocked by another surface: stop-on-alarm opens the save
	// dialog while the tone is still looping, and A must still work from behind or inside it. The
	// alarm banner sits above the dialog (z-index), so the operator can also click it. Typing in a
	// field is the only exception (an "a" in the notes field is text, not a command).
	if (none && key.toLowerCase() === 'a' && ctx.alarmShowing && !isTypingTarget(e.target)) return 'acknowledge';

	if (isTypingTarget(e.target)) return null;
	if (ctx.saveDialogOpen) return null; // the dialog is modal: nothing behind it is reachable

	if (mod && !e.altKey && !e.shiftKey) {
		if (key === 'Enter') return ctx.record && ctx.canStart ? 'start' : null;
		if (key === '.') return ctx.record && ctx.canStop ? 'stop' : null;
		if (key.toLowerCase() === 'n') return ctx.record && ctx.canNew ? 'new' : null;
		return null;
	}
	if (none && key.toLowerCase() === 'a') return ctx.alarmShowing ? 'acknowledge' : null;
	return null;
}

export interface ShortcutHint { keys: string; label: string }

/** The list shown under Start. `mac` swaps Ctrl for Cmd. */
export function shortcutHints(mac: boolean): ShortcutHint[] {
	const m = mac ? 'Cmd' : 'Ctrl';
	return [
		{ keys: `${m}+Enter`, label: 'Start' },
		{ keys: `${m}+.`, label: 'Stop' },
		{ keys: 'A', label: 'Acknowledge a safety alarm' },
		{ keys: `${m}+N`, label: 'New (after a cut is finished)' },
		{ keys: 'Enter', label: 'Save, in the save dialog' },
	];
}

export function isMacPlatform(): boolean {
	try {
		return typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '');
	} catch { return false; }
}
