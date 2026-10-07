// What the campaign pickers send to Directus when a record is put into (or taken out of) a
// campaign. Pure request builders plus one small async helper, unit tested without Vue.
//
// Two rules live here:
//  1. The campaign_id change is conditional (add only where `campaign_id` is still null, remove only
//     where it is this campaign), so two people or tabs cannot take the same record. Directus
//     answers a batch update with the rows it changed; an empty answer means someone got there first.
//  2. A record picked into a campaign also gets the campaign's project when it has none (the
//     d1-project-inherit rule), and a project it already has is never overwritten. That is a second,
//     conditional request (`project_id _null`), because one batch body cannot be per-row.

import { errorText, isForbidden } from '../format';

export interface BatchPatch {
	query: { filter: Record<string, unknown> };
	data: Record<string, unknown>;
}

// Add (`campaign` = this campaign's id) or remove (`campaign` = null) one record.
export function campaignAssignPatch(pk: string, id: string, campaignId: string, campaign: string | null): BatchPatch {
	return {
		query: { filter: { [pk]: { _eq: id }, campaign_id: campaign ? { _null: true } : { _eq: campaignId } } },
		data: { campaign_id: campaign },
	};
}

// Copies `projectId` onto the one record, only where its project_id is still null.
export function projectInheritPatch(pk: string, id: string, projectId: string): BatchPatch {
	return { query: { filter: { [pk]: { _eq: id }, project_id: { _null: true } } }, data: { project_id: projectId } };
}

// The message for a conditional campaign change that touched no row, or null when it changed one.
export function lostRaceMessage(changed: unknown, adding: boolean, label: string): string | null {
	if (!Array.isArray(changed) || changed.length) return null;
	return adding ? `${label} is already in another campaign.` : `${label} is no longer in this campaign.`;
}

interface Api {
	get(url: string, config?: any): Promise<any>;
	patch(url: string, body?: any): Promise<any>;
}

// The project of campaign `campaignId` as the signed-in user sees it; null when it has none or the
// read failed (inheriting is then skipped, the project rule falls back to the campaign anyway).
export async function readCampaignProject(api: Api, campaignId: string): Promise<string | null> {
	try {
		const res = await api.get(`/items/campaigns/${campaignId}`, { params: { fields: 'project_id' } });
		const v = res.data?.data?.project_id;
		return (v && typeof v === 'object' ? v.project_id : v) || null;
	} catch {
		return null;
	}
}

// After `id` was put into the campaign: give it the campaign's project if it has none. Returns an
// error text to show, or '' (nothing to do, done, or the role may not edit that field).
export async function inheritCampaignProject(
	api: Api,
	collection: string,
	pk: string,
	id: string,
	campaignId: string,
	label: string,
): Promise<string> {
	const projectId = await readCampaignProject(api, campaignId);
	if (!projectId) return '';
	try {
		await api.patch(`/items/${collection}`, projectInheritPatch(pk, id, projectId));
		return '';
	} catch (e) {
		// A role that may add the record to the campaign but not edit it: nothing to report.
		return isForbidden(e) ? '' : `${label} was added, but its project could not be set: ${errorText(e)}`;
	}
}
