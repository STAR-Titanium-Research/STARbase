// The draft's project and campaign chooser (R12, E16): which campaigns a project offers and what choosing one changes in the draft.
// Pure, no Vue, no host: useProjectChoices reads the lists and DraftScope.vue draws them.

import type { DraftBody } from '@d1/ui';
import type { DraftAction } from './draft';

export interface ProjectOption {
	value: string;
	label: string;
}
export interface CampaignOption extends ProjectOption {
	/** The project the campaign belongs to (a campaign always has one). */
	projectId: string | null;
}

/** The campaigns the chooser offers: those of the chosen project; with no project chosen, all of them (choosing one then sets its project). */
export const campaignOptions = (all: readonly CampaignOption[], projectId: string | null): CampaignOption[] =>
	projectId ? all.filter((c) => c.projectId === projectId) : [...all];

/**
 * Choosing the project (`null` = none): the project, and the campaign cleared when it does not belong to the new project. A campaign the
 * list does not hold (cut at the limit, or one the person cannot read) is cleared too, rather than left under a project it may not be in.
 * One step, so undo puts both back; nothing at all when nothing changes.
 */
export function chooseProject(body: DraftBody, projectId: string | null, campaigns: readonly CampaignOption[]): DraftAction[] {
	if (body.projectId === projectId) return [];
	const actions: DraftAction[] = [{ type: 'setProject', projectId }];
	if (body.campaignId) {
		const campaign = campaigns.find((c) => c.value === body.campaignId);
		if (!projectId || !campaign || campaign.projectId !== projectId) actions.push({ type: 'setCampaign', campaignId: null });
	}
	return actions;
}

/**
 * Choosing the campaign (`null` = none): the campaign, and the project it belongs to when the draft has another or none. A campaign the list
 * does not hold is set as it is (the person cannot have picked it from here; it is what the draft already says).
 */
export function chooseCampaign(body: DraftBody, campaignId: string | null, campaigns: readonly CampaignOption[]): DraftAction[] {
	if (body.campaignId === campaignId) return [];
	const actions: DraftAction[] = [{ type: 'setCampaign', campaignId }];
	const project = campaignId ? campaigns.find((c) => c.value === campaignId)?.projectId : null;
	if (project && body.projectId !== project) actions.unshift({ type: 'setProject', projectId: project });
	return actions;
}

/** "P-1 · Alpha": the code, with the name when it is another word; `fallback` when the record has neither. */
export function optionLabel(code: string | null | undefined, name: string | null | undefined, fallback: string): string {
	if (code && name && name !== code) return `${code} · ${name}`;
	return code || name || fallback;
}

/** `options`, plus the chosen value when the list does not hold it (so a select can show what the draft says). */
export function withListed<T extends ProjectOption>(options: T[], chosen: string | null, label: string): ProjectOption[] {
	return chosen && !options.some((o) => o.value === chosen) ? [...options, { value: chosen, label }] : options;
}
