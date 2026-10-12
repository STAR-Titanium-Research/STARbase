// What the Campaign page shows in its rail and "On this page" list, built from the records the page
// already loads. Pure and tested here (the extension has no test runner); projectFacts.ts is the
// Project page's twin.
//
// Operations and tests link to their Explorer index filtered by this campaign (`f.campaign_id`): the
// page reads exactly those rows (`campaign_id = this campaign`, as the signed-in user), so the number
// equals the list's. Samples are plain text: they join a campaign through `campaign_samples`, which
// no single-field index filter can express (and the count includes samples reached only through an
// operation or test).

import { campaignTypeLabel } from '../campaign/campaignType';
import { asRecord } from '../format';
import { indexRoute, recordRoute } from '../recordRoute';
import type { Fact } from './facts';
import type { ContentsEntry } from './contents';
import type { HiddenLinks } from './operationFacts';
import { dateRangeText } from './projectFacts';

type Rec = Record<string, any>;

export interface CampaignCounts {
	samples: number;
	/** Sample-list entries whose sample the reader may not see (they are not in `samples`). */
	hiddenSamples: number;
	operations: number;
	tests: number;
}

const num = (n: number): string => n.toLocaleString('en-GB');

/** Which of the page's reads failed: a count behind a failed read is unknown, never a wrong 0. The
 *  samples count is built from all three lists (the sample list, operations and tests). */
export interface CampaignCountErrors {
	samples?: boolean;
	operations?: boolean;
	tests?: boolean;
}

/** The campaign's own code, else its free-text name: what it is called everywhere else. */
export const campaignCode = (c: Rec | null | undefined): string => c?.campaign_code || c?.name || 'Campaign';

/** The project as the old header showed it: its name, with the code that links up the tree. */
function campaignProjectFact(project: Rec | null, hidden?: boolean): Fact {
	if (project) {
		const code = project.project_code ? `Project ${project.project_code}` : '';
		const value = [code, project.project_name].filter(Boolean).join(' · ') || 'Project';
		return { label: 'Project', value, to: recordRoute('projects', project.project_id) };
	}
	return hidden ? { label: 'Project', value: null, hidden: true } : { label: 'Project', value: null };
}

/**
 * The rail's key facts: the old header's meta line (project name, owner, dates, default machine and
 * material) and the three totals the stat tiles showed. `counts` is null while the page's reads load:
 * the counts are left out until then. A count whose read failed (`failed`) shows a dash and no link
 * (the same rule as the Project page's counts).
 */
export function campaignRailFacts(campaign: Rec | null | undefined, hidden: HiddenLinks, counts: CampaignCounts | null, failed: CampaignCountErrors = {}): Fact[] {
	if (!campaign) return [];
	const id = String(campaign.campaign_id);
	const countFacts: Fact[] = counts
		? [
				// Samples you may not see sit in the list but not in the number: said once, after it.
				failed.samples
					? { label: 'Samples', value: '–' }
					: { label: 'Samples', value: num(counts.samples), unit: counts.hiddenSamples ? `+ ${counts.hiddenSamples} not visible to you` : undefined },
				failed.operations
					? { label: 'Operations', value: '–' }
					: { label: 'Operations', value: num(counts.operations), to: indexRoute('manufacturing_operations', { query: { 'f.campaign_id': id } }) },
				failed.tests
					? { label: 'Test sessions', value: '–' }
					: { label: 'Test sessions', value: num(counts.tests), to: indexRoute('test_sessions', { query: { 'f.campaign_id': id } }) },
			]
		: [];
	return [
		{ label: 'Type', value: campaignTypeLabel(campaign.campaign_type) },
		{ label: 'Owner', value: asRecord(campaign.owner_person_id)?.full_name },
		{ label: 'Dates', value: dateRangeText(campaign.start_date, campaign.end_date) },
		{ label: 'Machine', value: asRecord(campaign.default_equipment_id)?.equipment_name },
		{ label: 'Material', value: asRecord(campaign.default_material_id)?.common_name },
		campaignProjectFact(asRecord(campaign.project_id), hidden.project_id),
		...countFacts,
	];
}

export interface CampaignContentsInput {
	hasNotes: boolean;
	/** Rows each panel shows; null while its read is loading. */
	matrix: number | null;
	samples: number | null;
	tests: number | null;
	operations: number | null;
}

/** "On this page": the Campaign page's panels in page order (ids are the Sections'). */
export function campaignContents(i: CampaignContentsInput): ContentsEntry[] {
	const entries: ContentsEntry[] = [];
	if (i.hasNotes) entries.push({ id: 'notes', title: 'Notes', count: null });
	entries.push(
		{ id: 'matrix', title: 'Samples and steps', count: i.matrix },
		{ id: 'samples', title: 'Samples', count: i.samples },
		{ id: 'test-sessions', title: 'Test sessions', count: i.tests },
		{ id: 'operations', title: 'Operations and force analysis', count: i.operations },
	);
	return entries;
}
