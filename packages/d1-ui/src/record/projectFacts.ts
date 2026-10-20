// The one helper of the old Project rail that is still shared: the Campaign page's "Dates" fact (campaignFacts.ts). The Project page
// no longer has a rail (its hero is in starbase-pages, with the pure parts in projectHero.ts).

import { formatDate } from '../format';

/** "5 Jan 2024 to 9 Mar 2025", "From 5 Jan 2024", "Until 9 Mar 2025"; empty when neither is set. */
export function dateRangeText(start: string | null | undefined, end: string | null | undefined): string {
	const a = formatDate(start);
	const b = formatDate(end);
	return a && b ? `${a} to ${b}` : a ? `From ${a}` : b ? `Until ${b}` : '';
}
