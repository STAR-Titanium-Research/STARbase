// The words and the link of the Create bar and the post-create toast (spec E4, E19). Pure, no Vue.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 things missing" on the disabled Create button (the same words as Checks' `missingText`, from a count). */
export const missingLabel = (n: number): string => `${plural(n, 'thing')} missing`;

/** "Created 5 records" in the toast. */
export const createdText = (count: number): string => `Created ${plural(count, 'record')}`;

/** "Print labels for 4 new samples". */
export const printLabelsText = (n: number): string => `Print labels for ${plural(n, 'new sample')}`;

/**
 * The labels page with these samples preselected, written as a path of the Directus app (links.ts decides what it means in each
 * host; the page reads `?ids=a,b`): '/home/labels?ids=<comma ids>'. An empty list gives no link.
 */
export function labelsPath(sampleIds: readonly string[]): string | null {
	const ids = [...new Set(sampleIds.filter((id) => typeof id === 'string' && id !== ''))];
	return ids.length ? `/home/labels?ids=${ids.map(encodeURIComponent).join(',')}` : null;
}
