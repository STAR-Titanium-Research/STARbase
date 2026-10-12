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
	{ id: 'kit', label: 'Kit', icon: '⚙︎', groupIds: ['inventory', 'resources'] },
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
// section is null (nothing on the rail is "current"); the panel then shows Home.
export function activeSection(sections: RailSection[], path: string, query: Record<string, unknown>): RailSectionId | null {
	const links = (s: RailSection) => s.groups.flatMap((g) => g.links);
	for (const s of sections) {
		if (links(s).some((l) => linkActive(l.to, path, query) || l.bookmarks.some((b) => linkActive(linkForBookmark(b), path, query)))) {
			return s.id;
		}
	}
	for (const s of sections) {
		if (links(s).some((l) => linkActive(l.to, path, {}))) return s.id;
	}
	return null;
}

// The section whose panel is shown for the current page: the page's own section, else Home.
export function followPage(sections: RailSection[], path: string, query: Record<string, unknown>): RailSectionId {
	return activeSection(sections, path, query) ?? 'home';
}

// The section remembered from the last visit to Home, if it still exists for this user. Used once,
// when the sidebar first mounts on Home; after that the panel follows the user's clicks on the rail
// and the page they navigate to.
export function restoreSection(sections: RailSection[], stored: string | null): RailSectionId | null {
	return sections.find((s) => s.id === stored)?.id ?? null;
}

// The section the panel opens on when the sidebar mounts: the remembered one when it exists (the
// lists may already be loaded, as when you come back to Home from another page, or arrive later, as
// on a reload), else the page's own. `pending` is what is still to be restored once the sections
// load: null when it was applied here (or there was nothing to apply).
export function startSection(
	sections: RailSection[],
	path: string,
	query: Record<string, unknown>,
	stored: string | null,
): { selected: RailSectionId; pending: string | null } {
	const restored = stored ? restoreSection(sections, stored) : null;
	return { selected: restored ?? followPage(sections, path, query), pending: restored ? null : stored };
}
