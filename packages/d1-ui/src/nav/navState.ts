// The small state rules of the sidebar, as plain functions so they can be tested without a DOM:
// which entry is the current page, and which groups the user has collapsed.
import { canonicalPath } from '../links';
import { NAV_GROUPS } from './navConfig';

export const COLLAPSED_KEY = 'd1.nav.collapsed';
// Inventory and Reference start collapsed (spec section 3); a group holding the current page is
// opened by the component regardless.
export const DEFAULT_COLLAPSED: readonly string[] = ['inventory', 'reference'];

// The stored value is a JSON array of group ids. Anything else (nothing stored, a broken value,
// storage blocked) gives the default.
export function parseCollapsed(raw: string | null | undefined): string[] {
	if (!raw) return [...DEFAULT_COLLAPSED];
	try {
		const v = JSON.parse(raw);
		if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
	} catch {
		// fall through to the default
	}
	return [...DEFAULT_COLLAPSED];
}

export function readCollapsed(): string[] {
	try {
		return parseCollapsed(window.localStorage.getItem(COLLAPSED_KEY));
	} catch {
		return [...DEFAULT_COLLAPSED];
	}
}

export function writeCollapsed(ids: string[]): void {
	try {
		window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(ids));
	} catch {
		// private mode or blocked storage: the choice just is not remembered
	}
}

function queryValue(query: Record<string, unknown>, key: string): string | null {
	const v = query[key];
	const first = Array.isArray(v) ? v[0] : v;
	return first === undefined || first === null ? null : String(first);
}

// The pages that have an entry for their edit mode (`?edit=` in its `to`: Build a process on the Process map). While the page is
// being edited, only that entry is lit, not the page's plain one.
const EDITABLE_PAGES: ReadonlySet<string> = new Set(
	NAV_GROUPS.flatMap((g) => g.links).flatMap((l) => (new URLSearchParams(l.to.split('?')[1] ?? '').has('edit') ? [l.to.split('?')[0]] : [])),
);

// Is the sidebar entry `to` (an app route, maybe with ?bookmark=<id> or ?edit=<draft>) the page at `path`/`query`?
//  - a bookmark entry: the same page with the same ?bookmark
//  - an edit entry (?edit=new): the same page while it is in edit mode (any ?edit, a draft's id once it is made); the page's plain
//    entry is not lit then
//  - Home: only /home itself (every Explorer route starts with it)
//  - any other entry: its page, or a record page under it (/home/samples/12 lights up Samples),
//    whether or not a saved view is selected on it (saved views are chips above the table now,
//    not sidebar entries, so the list's own entry stays lit)
export function linkActive(to: string, routePath: string, query: Record<string, unknown>): boolean {
	// `to` is written as a Directus app path; the current route is this host's, so bring it to that form.
	const path = canonicalPath(routePath);
	const [base, qs = ''] = to.split('?');
	const bookmark = new URLSearchParams(qs).get('bookmark');
	if (bookmark !== null) return path === base && queryValue(query, 'bookmark') === bookmark;
	const editing = queryValue(query, 'edit') !== null;
	if (new URLSearchParams(qs).has('edit')) return path === base && editing;
	if (editing && EDITABLE_PAGES.has(base) && (path === base || path.startsWith(`${base}/`))) return false;
	if (base === '/home') return path === base;
	if (path.startsWith(`${base}/`)) return true;
	return path === base;
}
