// What the palette and the add search remember of one person (redesign R1): the entries they added lately (listed first), and whether the
// palette is folded. Kept in localStorage per person (the key has their id), so a shared browser does not mix two people up. Storage can be
// missing (node), blocked or full: every access is guarded, and the page works without it.

import type { MenuChoice, MenuEntry } from './menuModel';

export const RECENTS_KEY = 'd1.map.add.recent.v1';
export const PALETTE_KEY = 'd1.map.palette.v1';
/** How many recents are kept. */
export const MAX_RECENTS = 6;

/** The entries worth remembering: the things the catalog adds (a method, a test type, a new sample), not the sub-choices of a socket. */
export const isRecentable = (e: Pick<MenuEntry, 'id'>): boolean => e.id.startsWith('op:') || e.id.startsWith('test:') || e.id === 'sample:new';

/** The entry id a choice of the catalog is remembered under, or null for a choice that is not one of its things (Same sample, a wire...). */
export function recentIdOf(choice: MenuChoice): string | null {
	// A template is its own list at the top of both surfaces; it is not a recent (its entry can be renamed or gone).
	if ((choice.kind === 'operation' || choice.kind === 'test') && choice.template) return null;
	// A blank operation or test (the palette's Operation and Test) is no method or type to come back to.
	if (choice.kind === 'newOperation' || choice.kind === 'newTest') return null;
	if (choice.kind === 'operation') return `op:${choice.methodId}`;
	if (choice.kind === 'test') return `test:${choice.testType}`;
	return choice.kind === 'newSample' ? 'sample:new' : null;
}

function browserStorage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.localStorage;
	} catch {
		return null; // reading the property itself can throw when site data is blocked
	}
}

const keyOf = (base: string, person: string | null | undefined): string => `${base}.${person || 'anon'}`;

/** The remembered entry ids, most recent first. */
export function readRecents(person: string | null | undefined, storage: Storage | null = browserStorage()): string[] {
	try {
		const parsed: unknown = JSON.parse(storage?.getItem(keyOf(RECENTS_KEY, person)) ?? 'null');
		return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENTS) : [];
	} catch {
		return [];
	}
}

/** `id` goes to the front; returns the new list (also when it could not be stored). */
export function pushRecent(person: string | null | undefined, id: string, storage: Storage | null = browserStorage()): string[] {
	const next = [id, ...readRecents(person, storage).filter((x) => x !== id)].slice(0, MAX_RECENTS);
	try {
		storage?.setItem(keyOf(RECENTS_KEY, person), JSON.stringify(next));
	} catch {
		/* not remembered across visits; the list still holds for this one */
	}
	return next;
}

/** Whether the palette is folded to its rail (unfolded when nothing is stored). */
export function readFolded(person: string | null | undefined, storage: Storage | null = browserStorage()): boolean {
	try {
		return storage?.getItem(keyOf(PALETTE_KEY, person)) === 'folded';
	} catch {
		return false;
	}
}

export function writeFolded(person: string | null | undefined, folded: boolean, storage: Storage | null = browserStorage()): void {
	try {
		storage?.setItem(keyOf(PALETTE_KEY, person), folded ? 'folded' : 'open');
	} catch {
		/* not remembered */
	}
}
