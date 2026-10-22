// The maths and the words of the scan progress (GET /d1-inbox/progress): percentages from counts, how a percentage is written, when a folder is complete,
// the tone of a bar. The server sends counts only. Plain functions (no Vue, no network) so they can be tested.
import type { ProgressCounts, ProgressFolder } from './inboxApiTypes';

export type MeasureKey = 'folders' | 'read' | 'thumbs' | 'scale';

export interface Measure {
	key: MeasureKey;
	label: string;
	done: number;
	total: number;
	/** 0 to 100, or null when there is nothing to measure (the denominator is 0). */
	pct: number | null;
}

/** done of total as 0 to 100, or null when total is 0 or less (nothing to measure). Never above 100 or below 0, never NaN. */
export function percent(done: number, total: number): number | null {
	if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
	return Math.min(100, Math.max(0, (done / total) * 100));
}

/**
 * How a percentage is written: a dash for none, "100%" only when everything is done (99.96 is "99.9%", never a rounded-up 100%), one decimal otherwise
 * and none when it is whole ("50%", "99.8%"). Something done is never "0%": a thousandth of the files reads "0.1%".
 */
export function formatPercent(pct: number | null): string {
	if (pct === null || Number.isNaN(pct)) return '—';
	if (pct >= 100) return '100%';
	if (pct <= 0) return '0%';
	const rounded = Math.min(99.9, Math.max(0.1, Math.round(pct * 10) / 10));
	return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/** "12 of 12" for a tooltip or a screen reader. */
export const countText = (m: Pick<Measure, 'done' | 'total'>): string => `${m.done.toLocaleString('en-GB')} of ${m.total.toLocaleString('en-GB')}`;

/** The four measures of a folder, in the order the page shows them. */
export function measuresOf(c: ProgressCounts): Measure[] {
	const m = (key: MeasureKey, label: string, done: number, total: number): Measure => ({ key, label, done, total, pct: percent(done, total) });
	return [
		m('folders', 'Folders listed', c.folders_listed, c.folders_known),
		m('read', 'Images read', c.images_read, c.images),
		m('thumbs', 'Thumbnails', c.images_with_thumb, c.images),
		m('scale', 'SEM images with a scale', c.sem_with_scale, c.sem),
	];
}

/**
 * Is the folder done: the crawler has seen at least one folder in it and every measure that has something to measure is at 100%. A folder it has not seen
 * anything in yet is not complete (it is waiting for its first scan), however empty its measures are.
 */
export function isComplete(c: ProgressCounts): boolean {
	return c.folders_known > 0 && measuresOf(c).every((m) => m.pct === null || m.pct >= 100);
}

/** True when every folder is complete. No folder at all is complete too (there is nothing to wait for; the page hides itself then). */
export const allComplete = (folders: ProgressFolder[]): boolean => folders.every(isComplete);

export type BarTone = 'ok' | 'warn' | 'neutral';

/**
 * The colour of a bar. Colour is for meaning: green at 100%, amber only below 50% once a scan has finished (before that a low number is just a scan that has
 * not got there yet), neutral otherwise, and neutral when there is nothing to measure.
 */
export function barTone(pct: number | null, scanFinished: boolean): BarTone {
	if (pct === null) return 'neutral';
	if (pct >= 100) return 'ok';
	return scanFinished && pct < 50 ? 'warn' : 'neutral';
}

/** Folders largest first (files, then name), as the admin table shows them; the endpoint sends them this way too, the table does not rely on it. */
export const sortFolders = (folders: ProgressFolder[]): ProgressFolder[] =>
	[...folders].sort((a, b) => b.files - a.files || a.owner.name.localeCompare(b.owner.name, 'en-GB') || a.owner.id.localeCompare(b.owner.id));

/** What the owner column says about a person's login: "login", "no login" (scanned, but cannot open the Inbox) or "team folder". */
export const loginText = (f: ProgressFolder): string => (f.owner.kind === 'team' ? 'team folder' : f.owner.has_login ? 'login' : 'no login');

/** The words that say what "folders known" means; shown wherever the numbers are. */
export const FOLDERS_KNOWN_HELP =
	'Folders known are the folders the crawler has seen so far (it cannot know about ones it has not met), so 100% means everything it has seen, not everything that exists.';
