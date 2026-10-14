// Undo and redo of the draft (E12): stacks of bodies, cap 200, kept for this visit only and cleared on Create, so undo
// never deletes records. Immutable: every function returns a new history. Pure, no Vue.

export const HISTORY_CAP = 200;

export interface History<T> {
	past: T[];
	present: T;
	future: T[];
}

export const createHistory = <T>(present: T): History<T> => ({ past: [], present, future: [] });

/** `next` becomes the present, the old present can be undone, redo is lost. The same value again changes nothing. */
export function push<T>(h: History<T>, next: T): History<T> {
	if (next === h.present) return h;
	const past = [...h.past, h.present];
	return { past: past.length > HISTORY_CAP ? past.slice(past.length - HISTORY_CAP) : past, present: next, future: [] };
}

export const canUndo = <T>(h: History<T>): boolean => h.past.length > 0;
export const canRedo = <T>(h: History<T>): boolean => h.future.length > 0;

export function undo<T>(h: History<T>): History<T> {
	if (!h.past.length) return h;
	return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
}

export function redo<T>(h: History<T>): History<T> {
	if (!h.future.length) return h;
	return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
}

/** A fresh history around `present`: what Create, or reloading the draft after a conflict, does. */
export const clear = <T>(present: T): History<T> => createHistory(present);
