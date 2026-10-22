// The words and the link of the Create bar and the post-create toast (spec E4, E19). Pure, no Vue.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 to fill in" beside the disabled Create button (K12: the card badges say `3 missing`; the Checks section lists them). */
export const missingLabel = (n: number): string => `${n} to fill in`;

/** "Created 5 records" in the toast. */
export const createdText = (count: number): string => `Created ${plural(count, 'record')}`;

/** "Print labels for 4 new samples". */
export const printLabelsText = (n: number): string => `Print labels for ${plural(n, 'new sample')}`;

/** A draft of hundreds of samples would make an address no server accepts: the link carries this many. */
export const LABELS_LINK_CAP = 200;

const distinct = (ids: readonly string[]) => [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))];

/** The samples the labels link carries, and how many more there were (print those from the Labels page). */
export function labelsLink(sampleIds: readonly string[], cap = LABELS_LINK_CAP): { ids: string[]; more: number } {
	const all = distinct(sampleIds);
	return { ids: all.slice(0, cap), more: Math.max(0, all.length - cap) };
}

/**
 * The labels page with these samples preselected, written as a path of the Directus app (links.ts decides what it means in each
 * host; the page reads `?ids=a,b`): '/home/labels?ids=<comma ids>', the first `cap` of them. An empty list gives no link.
 */
export function labelsPath(sampleIds: readonly string[], cap = LABELS_LINK_CAP): string | null {
	const { ids } = labelsLink(sampleIds, cap);
	return ids.length ? `/home/labels?ids=${ids.map(encodeURIComponent).join(',')}` : null;
}

/** "and 17 more are not in this link: print them from the Labels page". */
export const moreLabelsText = (n: number): string => `and ${n} more ${n === 1 ? 'is' : 'are'} not in this link: pick ${n === 1 ? 'it' : 'them'} on the Labels page`;
