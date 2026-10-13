// What the sidebar's row "⋯" menu holds (spec decision 6), and the two actions that touch the
// browser. The item lists are plain data so they can be tested without a DOM.
import type { NavIconName } from './navIcons';

export type RowMenuAction = 'pin' | 'unpin' | 'up' | 'down' | 'new-tab' | 'copy';

export interface RowMenuItem {
	id: RowMenuAction;
	label: string;
	icon: NavIconName;
	hint?: string;
	disabled?: boolean;
}

export interface RowMenuOptions {
	// A row in the Pinned list, or a row of a section (or Home).
	kind: 'section' | 'pinned';
	pinned: boolean;
	// False for pages with no page key (Settings, Data Studio, ...) and while the pins have not loaded:
	// the menu then has only Open in new tab and Copy link.
	canPin: boolean;
	// A pinned row's place among the rows shown, which decides what Move up / Move down can do.
	index?: number;
	count?: number;
}

export function rowMenuItems(o: RowMenuOptions): RowMenuItem[] {
	const items: RowMenuItem[] = [];
	if (o.canPin && o.kind === 'pinned') {
		items.push({ id: 'unpin', label: 'Unpin', icon: 'pin' });
		items.push({ id: 'up', label: 'Move up', icon: 'arrow-up', hint: 'Alt ↑', disabled: (o.index ?? 0) <= 0 });
		items.push({ id: 'down', label: 'Move down', icon: 'arrow-down', hint: 'Alt ↓', disabled: (o.index ?? 0) >= (o.count ?? 1) - 1 });
	} else if (o.canPin) {
		items.push(o.pinned ? { id: 'unpin', label: 'Unpin', icon: 'pin' } : { id: 'pin', label: 'Pin', icon: 'pin' });
	}
	items.push({ id: 'new-tab', label: 'Open in new tab', icon: 'external-link' });
	items.push({ id: 'copy', label: 'Copy link', icon: 'link' });
	return items;
}

// An address a person can paste: a relative href (the router's, with its base) gets the page's origin.
export function absoluteHref(href: string, origin: string): string {
	if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
	return origin.replace(/\/+$/, '') + (href.startsWith('/') ? href : `/${href}`);
}

export function openInNewTab(href: string): void {
	window.open(href, '_blank', 'noopener');
}

// Copies the absolute address; a blocked clipboard (an insecure page, a denied permission) is not an error.
export async function copyLink(href: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(absoluteHref(href, window.location.origin));
		return true;
	} catch {
		return false;
	}
}
