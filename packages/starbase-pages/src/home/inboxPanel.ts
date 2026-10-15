// The Inbox panel of Home: which lines it shows for the summary the server gave. Plain functions (no Vue), so they are tested on their own.
// The panel draws nothing when there is nothing to say (no new file, no older file that matches a record), as the other Home blocks do.
import { newFilesText, olderFilesText, type InboxSummary } from '@d1/ui';

export interface InboxLine {
	key: string;
	text: string;
	/** An app route (the Directus form: links.ts maps it per host). */
	to: string;
	/** Which Inbox the line is about: '' for the person's own, the team's name for a team folder. */
	scope: string;
}

const folder = (team: string) => `owner=team:${team}`;

/** The lines of the panel: for the person's own folder, then each team's. A count of zero has no line. */
export function inboxLines(s: InboxSummary | null): InboxLine[] {
	if (!s) return [];
	const lines: InboxLine[] = [];
	if (s.person?.new) lines.push({ key: 'me-new', text: newFilesText(s.person.new), to: '/inbox?owner=me', scope: '' });
	if (s.person?.older_matches) lines.push({ key: 'me-older', text: olderFilesText(s.person.older_matches), to: '/inbox?tab=older&strength=short_id,code&owner=me', scope: '' });
	for (const t of s.teams) {
		if (t.new) lines.push({ key: `${t.team_id}-new`, text: newFilesText(t.new), to: `/inbox?${folder(t.team_id)}`, scope: t.name });
		if (t.older_matches) lines.push({ key: `${t.team_id}-older`, text: olderFilesText(t.older_matches), to: `/inbox?tab=older&strength=short_id,code&${folder(t.team_id)}`, scope: t.name });
	}
	return lines;
}

/** Does Home draw the panel? Only with something to say. */
export const showInboxPanel = (s: InboxSummary | null): boolean => inboxLines(s).length > 0;

/** The heading's count: the files waiting (new, then older), not the lines. */
export const inboxPanelCount = (s: InboxSummary | null): number => (s ? s.newCount + s.olderMatches : 0);
