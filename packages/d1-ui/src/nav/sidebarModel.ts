// The pure rules of the sidebar (no Vue): its five sections, how pins resolve to entries, how a
// pinned list is reordered and cut, and the window-width rule for rail versus expanded.
import { linkActive } from './navState';
import { NAV_GROUPS, linkForBookmark } from './navConfig';
import type { VisibleNav } from './navConfig';
import type { NavIconName } from './navIcons';
import { PAGES, pageTarget, splitRecordTarget } from '../usage';

export type SectionId = 'records' | 'analysis' | 'inventory' | 'reference' | 'more';

export interface PinRef {
	kind: 'page' | 'view' | 'record';
	target: string;
}

export interface SidebarView {
	id: number;
	label: string;
	to: string;
	pin: PinRef;
}

export interface SidebarLink {
	label: string;
	to: string;
	newTab: boolean;
	icon: NavIconName;
	collection: string | null;
	// null when the page has no page key (Report a bug, Settings, Data Studio, Force Crawler).
	pin: PinRef | null;
	views: SidebarView[];
}

export interface SidebarGroup {
	id: string;
	label: string | null;
	links: SidebarLink[];
}

export interface SidebarSection {
	id: SectionId;
	label: string;
	icon: NavIconName;
	groups: SidebarGroup[];
	// Links in the section, over all its groups.
	count: number;
}

export interface ResolvedPin {
	ref: PinRef;
	label: string;
	hint: string | null;
	to: string;
	icon: NavIconName;
}

export interface RecordLabel {
	code: string;
	to: string;
}

export type ShellLayout =
	| { phone: true; mode: 'expanded'; overlay: false }
	| { phone: false; mode: 'expanded' | 'rail'; overlay: boolean };

// Up to this width the sidebar is the phone drawer.
export const PHONE_MAX_PX = 767;
// From the phone limit up to this width the rail rule applies (when auto-collapse is on).
export const RAIL_RULE_MAX_PX = 999;
// The rail shows this many pins; with more, the last slot is the overflow.
export const RAIL_MAX_PINS = 6;
// The expanded Pinned list shows this many in full; more are cut to PINNED_SOFT_MAX - 2.
export const PINNED_SOFT_MAX = 12;

const SECTIONS: Array<{ id: SectionId; label: string; groups: Array<{ id: string; label: string | null }> }> = [
	{ id: 'records', label: 'Records', groups: [{ id: 'records', label: null }] },
	{ id: 'analysis', label: 'Analysis', groups: [{ id: 'analysis', label: null }] },
	{ id: 'inventory', label: 'Inventory', groups: [{ id: 'inventory', label: null }] },
	{ id: 'reference', label: 'Reference', groups: [{ id: 'reference', label: null }] },
	{ id: 'more', label: 'More', groups: [{ id: 'more', label: null }, { id: 'admin', label: 'Admin' }] },
];

export function sidebarSections(nav: VisibleNav): SidebarSection[] {
	const byId = new Map(nav.groups.map((g) => [g.id as string, g]));
	const out: SidebarSection[] = [];
	for (const def of SECTIONS) {
		const groups: SidebarGroup[] = [];
		for (const g of def.groups) {
			const src = byId.get(g.id);
			if (!src || !src.links.length) continue;
			groups.push({
				id: g.id,
				label: g.label,
				links: src.links.map((l) => {
					const target = pageTarget(l.to);
					return {
						label: l.label,
						to: l.to,
						newTab: !!l.newTab,
						icon: l.icon,
						collection: l.collection ?? null,
						pin: target ? { kind: 'page' as const, target } : null,
						views: l.bookmarks.map((b) => ({
							id: b.id,
							label: b.bookmark,
							to: linkForBookmark(b),
							pin: { kind: 'view' as const, target: String(b.id) },
						})),
					};
				}),
			});
		}
		if (!groups.length) continue;
		out.push({
			id: def.id,
			label: def.label,
			icon: def.id,
			groups,
			count: groups.reduce((n, g) => n + g.links.length, 0),
		});
	}
	return out;
}

// The section of the page at path/query: the one whose entry (or record page under it) it is.
// A saved view's page counts as its list's page, so ?bookmark does not matter here.
export function sectionForPage(sections: SidebarSection[], path: string, query: Record<string, unknown>): SectionId | null {
	void query;
	for (const s of sections) {
		for (const g of s.groups) {
			if (g.links.some((l) => linkActive(l.to, path, {}))) return s.id;
		}
	}
	return null;
}

// Page keys that have a link in the sidebar's configuration (whether or not this person sees it).
// A pin of one of these resolves only through its link, so a page the person cannot see stays hidden.
const NAV_PAGE_KEYS = new Set(NAV_GROUPS.flatMap((g) => g.links).flatMap((l) => pageTarget(l.to) ?? []));

// The quick actions have no link in the sidebar, but Home suggests them and they can be pinned (spec
// decision 5: task screens). They resolve from the kit's page table, with these icons.
const FALLBACK_ICONS: Record<string, NavIconName> = {
	'action:register-sample': 'circle-plus',
	'action:log-operation': 'clipboard-plus',
};

function resolveUnlinkedPage(ref: PinRef): ResolvedPin | null {
	if (NAV_PAGE_KEYS.has(ref.target)) return null;
	const page = PAGES[ref.target];
	if (!page) return null;
	return { ref, label: page.label, hint: null, to: page.to, icon: FALLBACK_ICONS[ref.target] ?? 'more' };
}

export function pinKey(p: PinRef): string {
	return `${p.kind}:${p.target}`;
}

// Turn saved pins into sidebar entries, in their order. A pin whose page, view or record the user
// can no longer see (or that is not loaded) goes to `unavailable`, which the caller shows muted.
export function resolvePins(
	pins: PinRef[],
	sections: SidebarSection[],
	records: Map<string, RecordLabel>,
): { shown: ResolvedPin[]; unavailable: PinRef[] } {
	const links = sections.flatMap((s) => s.groups.flatMap((g) => g.links));
	const shown: ResolvedPin[] = [];
	const unavailable: PinRef[] = [];
	for (const ref of pins) {
		let resolved: ResolvedPin | null = null;
		if (ref.kind === 'page') {
			const link = links.find((l) => l.pin?.target === ref.target);
			if (link) resolved = { ref, label: link.label, hint: null, to: link.to, icon: link.icon };
			else resolved = resolveUnlinkedPage(ref);
		} else if (ref.kind === 'view') {
			for (const link of links) {
				const view = link.views.find((v) => v.pin.target === ref.target);
				if (view) {
					resolved = { ref, label: view.label, hint: link.label, to: view.to, icon: link.icon };
					break;
				}
			}
		} else {
			const rec = records.get(ref.target) ?? records.get(pinKey(ref));
			if (rec) {
				const collection = splitRecordTarget(ref.target)?.collection;
				const link = collection ? links.find((l) => l.collection === collection) : undefined;
				resolved = { ref, label: rec.code, hint: null, to: rec.to, icon: link?.icon ?? 'records' };
			}
		}
		if (resolved) shown.push(resolved);
		else unavailable.push(ref);
	}
	return { shown, unavailable };
}

// Put `item` before position `index` of the list (a position in the list as it is now, so
// `length` means last). An item already in the list is moved; a new one is inserted.
export function moveTo(pins: PinRef[], item: PinRef, index: number): PinRef[] {
	const key = pinKey(item);
	const at = pins.findIndex((p) => pinKey(p) === key);
	const rest = pins.filter((_, i) => i !== at);
	let target = Math.max(0, Math.min(index, pins.length));
	if (at !== -1 && at < target) target -= 1;
	rest.splice(target, 0, item);
	return rest;
}

// One place up (-1) or down (+1); the ends stay where they are.
export function moveBy(pins: PinRef[], item: PinRef, delta: -1 | 1): PinRef[] {
	const key = pinKey(item);
	const at = pins.findIndex((p) => pinKey(p) === key);
	const to = at + delta;
	if (at === -1 || to < 0 || to >= pins.length) return [...pins];
	return moveTo(pins, pins[at], delta === -1 ? to : to + 1);
}

// The expanded Pinned list: up to PINNED_SOFT_MAX in full, else the first PINNED_SOFT_MAX - 2 and
// a "Show N more" row, unless the user has expanded it.
export function pinnedListCut<T>(pins: T[], expanded: boolean): { shown: T[]; hidden: number } {
	if (expanded || pins.length <= PINNED_SOFT_MAX) return { shown: [...pins], hidden: 0 };
	const keep = PINNED_SOFT_MAX - 2;
	return { shown: pins.slice(0, keep), hidden: pins.length - keep };
}

// The rail: up to RAIL_MAX_PINS in full, else one fewer and the rest behind the overflow button.
export function railPins<T>(pins: T[]): { shown: T[]; overflow: T[] } {
	if (pins.length <= RAIL_MAX_PINS) return { shown: [...pins], overflow: [] };
	return { shown: pins.slice(0, RAIL_MAX_PINS - 1), overflow: pins.slice(RAIL_MAX_PINS - 1) };
}

// Phone: the drawer. 768-999 with auto-collapse on: a rail that opens over the page. Otherwise
// the user's saved choice.
export function layoutFor(o: { width: number; savedRail: boolean; autoCollapse: boolean }): ShellLayout {
	if (o.width <= PHONE_MAX_PX) return { phone: true, mode: 'expanded', overlay: false };
	if (o.autoCollapse && o.width <= RAIL_RULE_MAX_PX) return { phone: false, mode: 'rail', overlay: true };
	return { phone: false, mode: o.savedRail ? 'rail' : 'expanded', overlay: false };
}
