import { describe, expect, it } from 'vitest';
import { NAV_GROUPS, buildNav, linkForBookmark } from './navConfig';
import type { Bookmark } from './navConfig';
import {
	PINNED_SOFT_MAX, RAIL_MAX_PINS, layoutFor, moveBy, moveTo, pinKey, pinnedListCut, railPins, resolvePins, sectionForPage,
	sidebarSections,
} from './sidebarModel';
import type { PinRef, RecordLabel } from './sidebarModel';
import { pageTarget } from '../usage';

const everything = new Set(NAV_GROUPS.flatMap((g) => g.links).flatMap((l) => (l.collection ? [l.collection] : [])));
const bm = (id: number, name: string, collection: string): Bookmark => ({
	id, bookmark: name, collection, user: null, role: null, filter: null, search: null, layout_query: null,
});
const full = () => sidebarSections(buildNav(everything, [bm(3, 'Failed', 'physical_samples')], true));
const section = (id: string, list = full()) => list.find((s) => s.id === id)!;

describe('sidebarSections', () => {
	it('orders the sections records, analysis, inventory, reference, more', () => {
		expect(full().map((s) => s.id)).toEqual(['records', 'analysis', 'inventory', 'reference', 'more']);
		expect(full().map((s) => s.label)).toEqual(['Records', 'Analysis', 'Inventory', 'Reference', 'More']);
		expect(full().map((s) => s.icon)).toEqual(['records', 'analysis', 'inventory', 'reference', 'more']);
	});

	it('leaves out a section with no visible links', () => {
		const ids = sidebarSections(buildNav(new Set(), [], false)).map((s) => s.id);
		expect(ids).toEqual(['analysis', 'more']);
	});

	it('gives a one-group section a group label of null, and labels More\'s second group Admin', () => {
		for (const id of ['records', 'analysis', 'inventory', 'reference']) {
			expect(section(id).groups.map((g) => g.label)).toEqual([null]);
		}
		expect(section('more').groups.map((g) => [g.id, g.label])).toEqual([['more', null], ['admin', 'Admin']]);
	});

	it('sets count to the number of links', () => {
		expect(section('reference').count).toBe(11);
		expect(section('records').count).toBe(6);
		expect(section('more').count).toBe(5);
	});

	it('sets link.pin to a page pin, or null when the page has no key', () => {
		const links = full().flatMap((s) => s.groups.flatMap((g) => g.links));
		for (const l of links) {
			const t = pageTarget(l.to);
			expect(l.pin, l.label).toEqual(t ? { kind: 'page', target: t } : null);
		}
		for (const label of ['Report a bug', 'Settings', 'Data Studio', 'Force Crawler']) {
			expect(links.find((l) => l.label === label)!.pin, label).toBeNull();
		}
		expect(links.find((l) => l.label === 'Samples')!.pin).toEqual({ kind: 'page', target: 'samples' });
	});

	it('gives a view the pin kind view with its id', () => {
		const samples = section('records').groups[0].links.find((l) => l.label === 'Samples')!;
		expect(samples.views).toEqual([
			{ id: 3, label: 'Failed', to: linkForBookmark(bm(3, 'Failed', 'physical_samples')), pin: { kind: 'view', target: '3' } },
		]);
		expect(samples.collection).toBe('physical_samples');
	});
});

describe('sectionForPage', () => {
	it('finds the section of a page', () => {
		const s = full();
		expect(sectionForPage(s, '/home/operations', {})).toBe('records');
		expect(sectionForPage(s, '/home/samples', { bookmark: '3' })).toBe('records');
		expect(sectionForPage(s, '/home/equipment', {})).toBe('reference');
		expect(sectionForPage(s, '/home', {})).toBeNull();
	});
});

describe('resolvePins', () => {
	const rec = 'physical_samples:11111111-1111-4111-8111-111111111111';
	const recLabel: RecordLabel = { code: 'S-0001', to: '/home/samples/11111111-1111-4111-8111-111111111111' };
	const pins: PinRef[] = [
		{ kind: 'record', target: rec },
		{ kind: 'page', target: 'tools' },
		{ kind: 'view', target: '3' },
		{ kind: 'view', target: '99' },
		{ kind: 'record', target: 'equipment:22222222-2222-4222-8222-222222222222' },
		{ kind: 'page', target: 'samples' },
	];

	it('splits shown and unavailable, keeping order', () => {
		const sections = sidebarSections(buildNav(new Set(['physical_samples']), [bm(3, 'Failed', 'physical_samples')], false));
		const { shown, unavailable } = resolvePins(pins, sections, new Map([[rec, recLabel]]));
		expect(shown.map((p) => pinKey(p.ref))).toEqual([`record:${rec}`, 'view:3', 'page:samples']);
		expect(unavailable.map(pinKey)).toEqual(['page:tools', 'view:99', 'record:equipment:22222222-2222-4222-8222-222222222222']);
	});

	it('labels a record by code, with its collection\'s link icon; a view carries its page as hint', () => {
		const { shown } = resolvePins(pins, full(), new Map([[rec, recLabel]]));
		const samples = section('records').groups[0].links.find((l) => l.label === 'Samples')!;
		expect(shown[0]).toEqual({ ref: pins[0], label: 'S-0001', hint: null, to: recLabel.to, icon: samples.icon });
		const view = shown.find((p) => p.ref.kind === 'view')!;
		expect(view.label).toBe('Failed');
		expect(view.hint).toBe('Samples');
		const page = shown.find((p) => p.ref.kind === 'page' && p.ref.target === 'samples')!;
		expect(page).toMatchObject({ label: 'Samples', hint: null, to: '/home/samples', icon: samples.icon });
	});
});

describe('moveTo', () => {
	const [a, b, c] = ['a', 'b', 'c'].map((t): PinRef => ({ kind: 'page', target: t }));
	const keys = (l: PinRef[]) => l.map((p) => p.target).join('');

	it('inserts a new item at index', () => {
		const d: PinRef = { kind: 'page', target: 'd' };
		expect(keys(moveTo([a, b, c], d, 1))).toBe('adbc');
	});
	it('moves an existing item to before index', () => {
		expect(keys(moveTo([a, b, c], a, 2))).toBe('bac');
		expect(keys(moveTo([a, b, c], c, 0))).toBe('cab');
	});
	it('puts the item last at length', () => {
		expect(keys(moveTo([a, b, c], a, 3))).toBe('bca');
	});
	it('does not change the input', () => {
		const list = [a, b, c];
		moveTo(list, a, 3);
		expect(keys(list)).toBe('abc');
	});
});

describe('moveBy', () => {
	const [a, b, c] = ['a', 'b', 'c'].map((t): PinRef => ({ kind: 'page', target: t }));
	const keys = (l: PinRef[]) => l.map((p) => p.target).join('');
	it('swaps with the neighbour', () => {
		expect(keys(moveBy([a, b, c], b, -1))).toBe('bac');
		expect(keys(moveBy([a, b, c], b, 1))).toBe('acb');
	});
	it('does not move the ends', () => {
		expect(keys(moveBy([a, b, c], a, -1))).toBe('abc');
		expect(keys(moveBy([a, b, c], c, 1))).toBe('abc');
	});
});

describe('pinnedListCut', () => {
	const n = (k: number) => Array.from({ length: k }, (_, i) => i);
	it('shows 12 in full, cuts 13 to 10', () => {
		expect(PINNED_SOFT_MAX).toBe(12);
		expect(pinnedListCut(n(12), false)).toEqual({ shown: n(12), hidden: 0 });
		expect(pinnedListCut(n(13), false)).toEqual({ shown: n(10), hidden: 3 });
		expect(pinnedListCut(n(13), true)).toEqual({ shown: n(13), hidden: 0 });
	});
});

describe('railPins', () => {
	const n = (k: number) => Array.from({ length: k }, (_, i) => i);
	it('shows 6, or 5 and an overflow of the rest', () => {
		expect(RAIL_MAX_PINS).toBe(6);
		expect(railPins(n(6))).toEqual({ shown: n(6), overflow: [] });
		expect(railPins(n(7))).toEqual({ shown: n(5), overflow: [5, 6] });
	});
});

describe('layoutFor', () => {
	it('is the phone layout up to 767', () => {
		expect(layoutFor({ width: 767, savedRail: true, autoCollapse: true })).toEqual({ phone: true, mode: 'expanded', overlay: false });
	});
	it('is a rail with an overlay from 768 to 999 when auto-collapse is on', () => {
		const rail = { phone: false, mode: 'rail', overlay: true };
		expect(layoutFor({ width: 768, savedRail: false, autoCollapse: true })).toEqual(rail);
		expect(layoutFor({ width: 999, savedRail: false, autoCollapse: true })).toEqual(rail);
	});
	it('follows the saved choice from 1000', () => {
		expect(layoutFor({ width: 1000, savedRail: false, autoCollapse: true })).toEqual({ phone: false, mode: 'expanded', overlay: false });
		expect(layoutFor({ width: 1000, savedRail: true, autoCollapse: true })).toEqual({ phone: false, mode: 'rail', overlay: false });
	});
	it('follows the saved choice at 900 with auto-collapse off', () => {
		expect(layoutFor({ width: 900, savedRail: true, autoCollapse: false })).toEqual({ phone: false, mode: 'rail', overlay: false });
		expect(layoutFor({ width: 900, savedRail: false, autoCollapse: false })).toEqual({ phone: false, mode: 'expanded', overlay: false });
	});
});
