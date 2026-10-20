// How a record page is shown, the settings of its View rail (DESIGN.md section 5), remembered per
// kind of record and per device: every Sample page shares one, every Project page another. Like the
// list prefs (index/listPrefs.ts) they are preferences of the person, not of the record, so they live
// in localStorage under `d1.view.<kind>`. Pure: the composable that provides them to a page is
// composables/useRecordView.ts.

import type { ActivityWindow } from '../activity';
import { DENSITIES } from '../index/listPrefs';
import { browserStorage } from '../storage';
import type { Density } from '../index/listPrefs';

export type ActivityRange = '30d' | '6mo' | 'all';
export type EmptySections = 'show' | 'hide';

export interface RecordView {
	/** Panels in one stack or two independent stacks side by side. */
	panels: 1 | 2;
	/** Row height of every table in the panels. */
	density: Density;
	/** Hidden sections are not drawn and "On this page" counts them. */
	empty: EmptySections;
	/** How far back a Project's activity chart looks (Project only). */
	range: ActivityRange;
}

export const DEFAULT_RECORD_VIEW: Readonly<RecordView> = { panels: 1, density: 'normal', empty: 'show', range: '6mo' };

export const ACTIVITY_RANGES: readonly { value: ActivityRange; label: string }[] = [
	{ value: '30d', label: '30 d' },
	{ value: '6mo', label: '6 mo' },
	{ value: 'all', label: 'All' },
];

/** The chart's window: 30 d is 5 weeks (the bins are ISO weeks), 6 mo the default 26, all everything on record. */
export function activityWindow(range: ActivityRange): ActivityWindow {
	return range === '30d' ? 5 : range === 'all' ? 'all' : 26;
}

/** "in the last 30 days": the end of "No operations or tests ..." (nothing for All). */
export function activityPeriod(range: ActivityRange): string {
	return range === '30d' ? ' in the last 30 days' : range === 'all' ? '' : ' in the last 6 months';
}

export const recordViewKey = (kind: string): string => `d1.view.${kind}`;

// The stored value is a JSON object; each field is checked on its own, so a good one survives a bad
// one. Nothing stored, a broken value or blocked storage gives the default.
export function readRecordView(kind: string, storage: Storage | null = browserStorage()): RecordView {
	const view: RecordView = { ...DEFAULT_RECORD_VIEW };
	try {
		const raw = storage?.getItem(recordViewKey(kind));
		if (!raw) return view;
		const v: unknown = JSON.parse(raw);
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			const { panels, density, empty, range } = v as Record<string, unknown>;
			if (panels === 1 || panels === 2) view.panels = panels;
			if (DENSITIES.includes(density as Density)) view.density = density as Density;
			if (empty === 'show' || empty === 'hide') view.empty = empty;
			if (ACTIVITY_RANGES.some((r) => r.value === range)) view.range = range as ActivityRange;
		}
	} catch {
		// broken value or blocked storage: the default stands
	}
	return view;
}

export function writeRecordView(kind: string, view: RecordView, storage: Storage | null = browserStorage()): void {
	try {
		const { panels, density, empty, range } = view;
		storage?.setItem(recordViewKey(kind), JSON.stringify({ panels, density, empty, range }));
	} catch {
		// private mode or blocked storage: the choice just is not remembered
	}
}

/** True when anything differs from the default: the dot on the collapsed rail. */
export function isChanged(view: RecordView): boolean {
	return (Object.keys(DEFAULT_RECORD_VIEW) as (keyof RecordView)[]).some((k) => view[k] !== DEFAULT_RECORD_VIEW[k]);
}

export const DENSITY_OPTIONS: readonly { value: Density; label: string }[] = [
	{ value: 'compact', label: 'Compact' },
	{ value: 'normal', label: 'Normal' },
	{ value: 'roomy', label: 'Roomy' },
];

/** The collapsed tab's text after "View": "1 column · Normal", with what is not the default added ("Empty hidden", "30 d"). */
export function viewSummary(view: RecordView, withRange: boolean): string {
	const parts = [view.panels === 2 ? '2 columns' : '1 column', DENSITY_OPTIONS.find((o) => o.value === view.density)!.label];
	if (view.empty === 'hide') parts.push('Empty hidden');
	if (withRange && view.range !== DEFAULT_RECORD_VIEW.range) parts.push(ACTIVITY_RANGES.find((r) => r.value === view.range)!.label);
	return parts.join(' · ');
}

/**
 * "On this page" with empty sections hidden: the entries still shown and how many were left out. A count of 0
 * is exactly an empty Section (nothing to show, and no error): a page gives null while a read loads or when it
 * failed, so a panel that is drawn with its error stays in the list.
 */
export function withoutEmpty<T extends { count: number | null }>(entries: T[], hide: boolean): { shown: T[]; hidden: number } {
	if (!hide) return { shown: entries, hidden: 0 };
	const shown = entries.filter((e) => e.count !== 0);
	return { shown, hidden: entries.length - shown.length };
}
