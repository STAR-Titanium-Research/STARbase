// What the Project page shows in its rail and "On this page" list, built from the records the page
// already loads. Pure and tested here (the extension has no test runner); operationFacts.ts is the
// Operation page's twin.
//
// The counts are PLAIN TEXT, not links, except "Campaigns". The page counts samples, operations and
// tests by the shared project rule (projectScope.ts: the record's own project_id, else its campaign's;
// samples also by being in one of the project's campaigns), but the Explorer index pages filter on the
// record's own `project_id` column only, so a link would open a list that can be shorter than the
// number clicked. The spec forbids that (decision 4); a scope-aware index filter would lift it.

import { formatDate } from '../format';
import type { Fact } from './facts';
import type { ContentsEntry } from './contents';

type Rec = Record<string, any>;

/** "5 Jan 2024 to 9 Mar 2025", "From 5 Jan 2024", "Until 9 Mar 2025"; empty when neither is set. */
export function dateRangeText(start: string | null | undefined, end: string | null | undefined): string {
	const a = formatDate(start);
	const b = formatDate(end);
	return a && b ? `${a} to ${b}` : a ? `From ${a}` : b ? `Until ${b}` : '';
}

export interface ProjectCounts {
	samples: number | null;
	operations: number | null;
	tests: number | null;
	campaigns: number | null;
}

const num = (n: number): string => n.toLocaleString('en-GB');

/** A count as a fact value: left out while it loads, a dash when the read finished without a number
 *  (the role cannot read that collection: never a wrong 0). */
const countValue = (n: number | null, loading: boolean): string | null => (loading ? null : n === null ? '–' : num(n));

/**
 * The rail's key facts: the old header's meta line (dates, PI, investigators, document number;
 * "Export controlled" is the page's own red line under the facts) and the totals the stat tiles
 * showed. `countsLoading` leaves the counts out until the read has answered.
 */
export function projectRailFacts(project: Rec | null | undefined, investigators: string[], counts: ProjectCounts, countsLoading: boolean): Fact[] {
	if (!project) return [];
	const campaigns = countValue(counts.campaigns, countsLoading);
	return [
		{ label: 'Dates', value: dateRangeText(project.start_date, project.end_date) },
		{ label: 'PI', value: project.principal_investigator_person?.full_name || 'not set' },
		{ label: 'Investigators', value: null, list: investigators.map((name) => ({ label: name })) },
		{ label: 'Document', value: project.document_number },
		{ label: 'Samples', value: countValue(counts.samples, countsLoading) },
		{ label: 'Operations', value: countValue(counts.operations, countsLoading) },
		{ label: 'Tests', value: countValue(counts.tests, countsLoading) },
		// The one count that points somewhere: the Campaigns panel on this page (a dash has no panel to go to).
		{ label: 'Campaigns', value: campaigns, anchor: campaigns !== null && campaigns !== '–' ? 'campaigns' : undefined },
	];
}

export interface ProjectContentsInput {
	hasDescription: boolean;
	/** Rows each panel shows; null while its read is loading. */
	campaigns: number | null;
	samples: number | null;
	operations: number | null;
	tests: number | null;
	equipment: number | null;
}

/** "On this page": the Project page's panels in page order (ids are the Sections'). */
export function projectContents(i: ProjectContentsInput): ContentsEntry[] {
	const entries: ContentsEntry[] = [];
	if (i.hasDescription) entries.push({ id: 'description', title: 'Description', count: null });
	entries.push(
		{ id: 'campaigns', title: 'Campaigns', count: i.campaigns },
		{ id: 'unassigned-samples', title: 'Samples not in a campaign', count: i.samples },
		{ id: 'unassigned-operations', title: 'Operations not in a campaign', count: i.operations },
		{ id: 'unassigned-tests', title: 'Tests not in a campaign', count: i.tests },
		{ id: 'activity', title: 'Activity', count: null },
		{ id: 'equipment', title: 'Equipment used', count: i.equipment },
	);
	return entries;
}
