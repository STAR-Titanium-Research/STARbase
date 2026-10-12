// Which window is a pop-out. AppShell is the parent route of every section, so a section popped out
// to a second monitor mounts a whole second shell. Anything that must exist exactly once per app
// (the rig-test host: its polling, prompts and desktop toasts) therefore runs in the main window
// only. The marker is a `?popout=1` on the URL the opener builds. It is read once when the window
// loads, and the router puts it back on every navigation inside the window (the desktop shell
// saves a pop-out's current URL at quit and reopens it, so the marker has to stay in the URL).

export const POPOUT_PARAM = 'popout';

/** `path` with the pop-out marker, for window.open. */
export function withPopoutMarker(path: string): string {
	return `${path}${path.includes('?') ? '&' : '?'}${POPOUT_PARAM}=1`;
}

/** Does this query string carry the marker? */
export function hasPopoutMarker(search: string): boolean {
	return new URLSearchParams(search).get(POPOUT_PARAM) === '1';
}

/** True in a window that was opened as a pop-out. Fixed at load: a later navigation can't turn the
 *  main window into a pop-out or the reverse. */
export const isPopoutWindow = typeof location !== 'undefined' && hasPopoutMarker(location.search);

/** The query a navigation inside a pop-out should carry, or null when it already does (or this is
 *  not a pop-out). */
export function queryWithPopoutMarker(popout: boolean, query: Record<string, unknown>): Record<string, unknown> | null {
	return popout && query[POPOUT_PARAM] !== '1' ? { ...query, [POPOUT_PARAM]: '1' } : null;
}
