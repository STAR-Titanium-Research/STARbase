// The "My teams" panel of Home: the most recently changed records of the viewer's own teams (GET /d1-teams/mine/recent, readable records
// only), one line each. No Vue, so it is unit-tested. (myTeams.ts is the other file about teams here: the ids of my teams for "Your work".)
import { DEFAULT_TEAM_COLOR, isTeamColor } from '@d1/ui';
import type { RecentTeamRecord, TeamColor } from '@d1/ui';
import { kindLabel } from '../people/personPanel';
import { lastSeen } from '../people/lastSeen';

/** Lines shown at first, and after "Show more" (also what the panel asks the endpoint for). */
export const PANEL_SHOWN = 10;
export const PANEL_MORE = 20;

export interface PanelLine {
	key: string;
	collection: string;
	id: string;
	kind: string;
	code: string;
	title: string;
	/** What TeamTile takes; the logo is not in the payload, so the tile shows the team's initials. */
	team: { name: string; color: TeamColor };
	changed: string;
}

/** "changed 2 h ago", "changed yesterday", then a date once a week old; empty when the time is missing. */
export function changedLabel(iso: string | null | undefined, now: number = Date.now()): string {
	const when = lastSeen(iso, now);
	return when === '—' ? '' : `changed ${when}`;
}

/** The lines to draw, in the server's order (newest change first): the first 10, or up to 20 once expanded. No items: no lines, no panel. */
export function panelLines(items: RecentTeamRecord[] | null | undefined, expanded: boolean, now: number = Date.now()): PanelLine[] {
	if (!Array.isArray(items)) return [];
	return items.slice(0, expanded ? PANEL_MORE : PANEL_SHOWN).map((r) => ({
		key: `${r.collection}:${r.id}`,
		collection: r.collection,
		id: r.id,
		kind: kindLabel(r.kind),
		code: r.code || 'No code',
		title: r.title ?? '',
		team: { name: r.team_name, color: isTeamColor(r.team_color) ? r.team_color : DEFAULT_TEAM_COLOR },
		changed: changedLabel(r.changed_at, now),
	}));
}

/** The label of the button that reveals lines 11 to 20, or null when there is nothing more to reveal. */
export const showMoreLabel = (total: number, expanded: boolean): string | null => (!expanded && total > PANEL_SHOWN ? 'Show more' : null);
