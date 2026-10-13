// The small state rules of the sidebar, as plain functions so they can be tested without a DOM:
// which entry is the current page, and which groups the user has collapsed.
import { canonicalPath } from '../links';

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

// Is the sidebar entry `to` (an app route, maybe with ?bookmark=<id>) the page at `path`/`query`?
//  - a bookmark entry: the same page with the same ?bookmark
//  - Home: only /home itself (every Explorer route starts with it)
//  - any other entry: its page, or a record page under it (/home/samples/12 lights up Samples);
//    its own list page lights it up only when no saved view is selected, so that the bookmark
//    entry below it is the one highlighted
export function linkActive(to: string, routePath: string, query: Record<string, unknown>): boolean {
	// `to` is written as a Directus app path; the current route is this host's, so bring it to that form.
	const path = canonicalPath(routePath);
	const [base, qs = ''] = to.split('?');
	const bookmark = new URLSearchParams(qs).get('bookmark');
	if (bookmark !== null) return path === base && queryValue(query, 'bookmark') === bookmark;
	if (base === '/home') return path === base;
	if (path.startsWith(`${base}/`)) return true;
	return path === base && queryValue(query, 'bookmark') === null;
}
