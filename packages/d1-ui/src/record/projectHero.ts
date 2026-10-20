// The pure parts of the Project page hero (spec docs/superpowers/specs/2026-10-20-project-page-hero-design.md): which campaigns sit
// behind the "complete" fold, the "1 active · 1 planned · 1 on hold" line, campaigns as the timeline reads them, planned dates with
// their counts, and the remembered timeline range. No Vue, no host.

import { statusStyle } from '../status';
import type { PlannedInput, TimelineCampaignInput, TimelineRange } from './projectTimeline';

type CampaignRow = { status?: string | null };

// Planned, active and on hold come first, in that order; any other (free-text) status is open too, after them.
const OPEN_ORDER = ['planned', 'active', 'on_hold'];
const openRank = (status: string | null | undefined): number => {
	const i = OPEN_ORDER.indexOf(status ?? '');
	return i < 0 ? OPEN_ORDER.length : i;
};

/** The campaigns to show first (open ones, by status then in the order given) and the complete ones to put behind the fold. */
export function splitCampaigns<T extends CampaignRow>(campaigns: readonly T[]): { open: T[]; complete: T[] } {
	const complete = campaigns.filter((c) => c.status === 'complete');
	const open = campaigns
		.map((c, i) => ({ c, i }))
		.filter(({ c }) => c.status !== 'complete')
		.sort((a, b) => openRank(a.c.status) - openRank(b.c.status) || a.i - b.i)
		.map(({ c }) => c);
	return { open, complete };
}

/** The open statuses of a project's campaigns, as parts of the totals line: `{ n: 1, label: 'active' }`. Empty when none is open. */
export function campaignStatusParts(counts: Readonly<Record<string, number>>): { n: number; label: string }[] {
	return ['active', 'planned', 'on_hold']
		.filter((status) => (counts[status] ?? 0) > 0)
		.map((status) => ({ n: counts[status], label: (statusStyle('campaign', status)?.label ?? status).toLowerCase() }));
}

/** Campaigns as the timeline takes them (a campaign without a code is shown by its name). */
export function timelineCampaigns(rows: readonly any[]): TimelineCampaignInput[] {
	return rows.map((c) => ({
		id: String(c.campaign_id),
		code: c.campaign_code || c.name || 'Campaign',
		name: c.name ?? '',
		status: c.status ?? '',
		start: c.start_date ?? null,
		end: c.end_date ?? null,
	}));
}

/** `aggregate count groupBy planned_date` as the timeline's planned markers, oldest first. */
export function plannedFromCounts(byDate: ReadonlyMap<string, number>): PlannedInput[] {
	return [...byDate.entries()]
		.filter(([, n]) => n > 0)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, n]) => ({ date, n }));
}

/** Where the page remembers the timeline range, per device. */
export const TIMELINE_RANGE_KEY = 'd1.project.timelineRange';

/** A stored range, or "all" for anything else (nothing stored, a value from another version, storage that threw). */
export function parseTimelineRange(value: unknown): TimelineRange {
	return value === '30d' || value === '6mo' || value === 'all' ? value : 'all';
}
