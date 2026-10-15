// The two rows the sidebar draws that are not a plain link of a section: Home, and a saved view
// nested under its index page. Plain data, so they can be tested without a DOM.
import type { ResolvedPin, SidebarLink, SidebarView } from './sidebarModel';

// Home is a plain link with no pin (it is always one click away) and no "⋯" menu. It is written as
// the Directus app path, like every link (links.ts), whatever this host calls it.
export const HOME_LINK: SidebarLink = {
	label: 'Home',
	to: '/home',
	newTab: false,
	icon: 'home',
	collection: null,
	pin: null,
	views: [],
};

// The Inbox (found files waiting to be linked): a plain link under Home, outside the five sections, with the count of new files as a
// badge (useInboxSummary). It has no pin and no "⋯" menu, like Home, and is left out when the server has no d1-inbox. `/inbox` is one of
// STARbase's own pages (links.ts LOCAL_PAGES).
export const INBOX_LINK: SidebarLink = {
	label: 'Inbox',
	to: '/inbox',
	newTab: false,
	icon: 'inbox',
	collection: null,
	pin: null,
	views: [],
};

// A saved view under its index page, in the shape of a pin so the row can pin and unpin it: its
// own name, the index page's icon (the row draws none when nested), no grey hint (the index page
// is right above it).
export function viewAsRow(link: SidebarLink, view: SidebarView): ResolvedPin {
	return { ref: view.pin, label: view.label, hint: null, to: view.to, icon: link.icon };
}
