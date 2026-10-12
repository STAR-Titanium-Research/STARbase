import { linkActive } from './navState';
import { linkForBookmark } from './navConfig';
import type { NavGroup, VisibleNav } from './navConfig';

// The icon rail (N1b decision 1): the five sections that pick what the panel beside it shows. As
// data, with the pure rules (which sections exist for this user, which holds the current page) so
// they are tested without a DOM. The groups themselves stay in navConfig.ts; a section only says
// which of them it holds.

export type RailSectionId = 'home' | 'records' | 'analysis' | 'kit' | 'tools';

export type RailGroup = VisibleNav['groups'][number];

export interface RailSection {
	id: RailSectionId;
	label: string;
	// One glyph (plain text, no host icon component), so the kit renders the same anywhere.
	icon: string;
	groups: RailGroup[];
}

export const RAIL_SECTIONS: Array<{ id: RailSectionId; label: string; icon: string; groupIds: NavGroup['id'][] }> = [
	{ id: 'home', label: 'Home', icon: '⌂', groupIds: ['main'] },
	{ id: 'records', label: 'Records', icon: '▦', groupIds: ['records'] },
	{ id: 'analysis', label: 'Analysis', icon: '∿', groupIds: ['dashboards'] },
	{ id: 'kit', label: 'Kit', icon: '⚙', groupIds: ['inventory', 'resources'] },
	{ id: 'tools', label: 'Tools', icon: '☰', groupIds: ['tools'] },
];

// The sections this user has something to open in, each with its visible groups. A section none of
// whose groups survived buildNav (no readable collection, not an admin) is left out of the rail.
export function railSections(nav: VisibleNav): RailSection[] {
	const out: RailSection[] = [];
	for (const def of RAIL_SECTIONS) {
		const groups = def.groupIds
			.map((id) => nav.groups.find((g) => g.id === id))
			.filter((g): g is RailGroup => !!g && g.links.length > 0);
		if (groups.length) out.push({ id: def.id, label: def.label, icon: def.icon, groups });
	}
	return out;
}

// The section holding the page at path/query: the one with the lit link (or lit saved view), as the
// panel would show it. A saved view that is not listed (someone else's, or the views have not
// loaded) still belongs to its list's section: second pass, the query ignored. A page in no
// section is Home.
export function activeSection(sections: RailSection[], path: string, query: Record<string, unknown>): RailSectionId {
	const links = (s: RailSection) => s.groups.flatMap((g) => g.links);
	for (const s of sections) {
		if (links(s).some((l) => linkActive(l.to, path, query) || l.bookmarks.some((b) => linkActive(linkForBookmark(b), path, query)))) {
			return s.id;
		}
	}
	for (const s of sections) {
		if (links(s).some((l) => linkActive(l.to, path, {}))) return s.id;
	}
	return 'home';
}

// The section the panel shows when the page changes. Everywhere but on Home it follows the page.
// On Home itself the user may have been browsing another section (the rail switches the panel
// without navigating), and that choice, `stored`, is shown again if that section still exists.
export function resolveSection(sections: RailSection[], path: string, query: Record<string, unknown>, stored: string | null): RailSectionId {
	const current = activeSection(sections, path, query);
	if (path !== '/home') return current;
	const kept = sections.find((s) => s.id === stored);
	return kept ? kept.id : current;
}
