import type { HostApi } from '@d1/ui';
import { loadFiles, type FoundFile } from './inboxApi';
import { listPlan, type InboxFilters } from './inboxModel';

// Finding one found file for the view box page. The d1-inbox endpoint has no "one file by id" call and the page must not add one, so the file (and its
// neighbours for prev/next) come from the same filtered list the person came from: the picture rows first, then the Other files part. The list is read in
// pages of the server's largest size and only as far as the file, plus one more page when the file is the last one fetched (so "next" is known).
// A file that is not in the list (a link typed by hand, a file linked or dismissed since, one the person cannot see) is not found, and the page says
// "not found or not visible" rather than guess.

/** The server's largest page (core/extensions/d1-inbox MAX_PAGE); more is a 400. */
export const LOCATE_PAGE = 200;
/** How far down a list the page reads before giving up on a file (10 pages). A direct link to a file deeper than this reads as not found. */
export const LOCATE_MAX_ROWS = 2000;

export interface Located {
	/** The rows of the list part the file is in, from the top, as far as they were read (at least up to the file, and one more when there is one). */
	rows: FoundFile[];
	/** The part's size in all, which can be more than `rows`: the "m" of "n of m". */
	total: number;
	part: 'main' | 'other';
}

/**
 * The list part holding `candidateId` under `filters`, or null when it is in neither. `stale` is asked between pages: a newer request makes this one stop
 * (it then answers null, which the caller ignores). A failed read throws what loadFiles throws.
 */
export async function locateFile(api: HostApi, filters: InboxFilters, candidateId: string, stale: () => boolean = () => false): Promise<Located | null> {
	const plan = listPlan(filters);
	for (const part of ['main', 'other'] as const) {
		const base = plan[part];
		if (!base) continue;
		const rows: FoundFile[] = [];
		let total = 0;
		while (true) {
			const page = await loadFiles(api, { ...base, limit: LOCATE_PAGE, offset: rows.length });
			if (stale()) return null;
			rows.push(...page.rows);
			total = page.total;
			const at = rows.findIndex((f) => f.candidate_id === candidateId);
			// the file is the last one read and the list goes on: one more page, so "next" is known
			if (at >= 0 && !(at === rows.length - 1 && rows.length < total && page.rows.length > 0 && rows.length < LOCATE_MAX_ROWS)) return { rows, total, part };
			if (at < 0 && (page.rows.length === 0 || rows.length >= total || rows.length >= LOCATE_MAX_ROWS)) break;
		}
	}
	return null;
}
