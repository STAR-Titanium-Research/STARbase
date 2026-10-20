import { describe, expect, it } from 'vitest';
import type { DraftBody } from '@d1/ui';
import { apply, emptyBody, type DraftAction } from './draft';
import { campaignOptions, chooseCampaign, chooseProject, optionLabel, withListed, type CampaignOption } from './projectCampaign';

const CAMPAIGNS: CampaignOption[] = [
	{ value: 'ca', label: 'CA', projectId: 'pa' },
	{ value: 'cb', label: 'CB', projectId: 'pb' },
	{ value: 'ca2', label: 'CA2', projectId: 'pa' },
];
const run = (actions: DraftAction[], from: DraftBody): DraftBody => actions.reduce((b, a) => apply(b, a), from);

describe('campaignOptions', () => {
	it('lists the campaigns of the chosen project only; with no project, every campaign', () => {
		expect(campaignOptions(CAMPAIGNS, 'pa').map((c) => c.value)).toEqual(['ca', 'ca2']);
		expect(campaignOptions(CAMPAIGNS, 'pb').map((c) => c.value)).toEqual(['cb']);
		expect(campaignOptions(CAMPAIGNS, 'nobody')).toEqual([]);
		expect(campaignOptions(CAMPAIGNS, null)).toHaveLength(3);
	});
});

describe('chooseProject: changing the project clears a campaign that does not belong to it', () => {
	const body = emptyBody('pa', 'ca');
	it('keeps the campaign when it is in the new project, clears it when it is not', () => {
		expect(run(chooseProject(body, 'pa', CAMPAIGNS), body)).toMatchObject({ projectId: 'pa', campaignId: 'ca' });
		expect(run(chooseProject(body, 'pb', CAMPAIGNS), body)).toMatchObject({ projectId: 'pb', campaignId: null });
		expect(run(chooseProject(body, null, CAMPAIGNS), body)).toMatchObject({ projectId: null, campaignId: null });
	});
	it('clears a campaign it does not know (the list may be cut): the safe side', () => {
		expect(run(chooseProject(emptyBody('pa', 'cX'), 'pb', CAMPAIGNS), emptyBody('pa', 'cX'))).toMatchObject({ projectId: 'pb', campaignId: null });
	});
	it('is no action at all when nothing changes', () => {
		expect(chooseProject(body, 'pa', CAMPAIGNS)).toEqual([]);
	});
	it('is two actions in the order that makes one undo step of them', () => {
		expect(chooseProject(body, 'pb', CAMPAIGNS)).toEqual([{ type: 'setProject', projectId: 'pb' }, { type: 'setCampaign', campaignId: null }]);
	});
});

describe('chooseCampaign', () => {
	it('sets the campaign, and the project it belongs to when the draft has another or none', () => {
		expect(run(chooseCampaign(emptyBody(), 'cb', CAMPAIGNS), emptyBody())).toMatchObject({ projectId: 'pb', campaignId: 'cb' });
		expect(run(chooseCampaign(emptyBody('pa'), 'ca2', CAMPAIGNS), emptyBody('pa'))).toMatchObject({ projectId: 'pa', campaignId: 'ca2' });
		expect(chooseCampaign(emptyBody('pa'), 'ca2', CAMPAIGNS)).toEqual([{ type: 'setCampaign', campaignId: 'ca2' }]);
		expect(run(chooseCampaign(emptyBody('pa'), 'cb', CAMPAIGNS), emptyBody('pa'))).toMatchObject({ projectId: 'pb', campaignId: 'cb' });
	});
	it('None clears the campaign and leaves the project', () => {
		expect(run(chooseCampaign(emptyBody('pa', 'ca'), null, CAMPAIGNS), emptyBody('pa', 'ca'))).toMatchObject({ projectId: 'pa', campaignId: null });
		expect(chooseCampaign(emptyBody('pa'), null, CAMPAIGNS)).toEqual([]);
	});
	it('a campaign the list does not know is set as it is', () => {
		expect(chooseCampaign(emptyBody('pa'), 'cX', CAMPAIGNS)).toEqual([{ type: 'setCampaign', campaignId: 'cX' }]);
	});
});

describe('labels', () => {
	it('shows the code, with the name when it adds something', () => {
		expect(optionLabel('P-1', 'Alpha', 'Project')).toBe('P-1 · Alpha');
		expect(optionLabel('P-1', 'P-1', 'Project')).toBe('P-1');
		expect(optionLabel(null, 'Alpha', 'Project')).toBe('Alpha');
		expect(optionLabel(null, null, 'Project')).toBe('Project');
	});
	it('withListed adds a chosen value the list does not hold, so the select can show it', () => {
		const opts = [{ value: 'a', label: 'A' }];
		expect(withListed(opts, 'a', 'Other')).toBe(opts);
		expect(withListed(opts, null, 'Other')).toBe(opts);
		expect(withListed(opts, 'z', 'Other')).toEqual([...opts, { value: 'z', label: 'Other' }]);
	});
});
