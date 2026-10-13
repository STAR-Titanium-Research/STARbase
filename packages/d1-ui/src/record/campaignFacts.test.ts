import { describe, expect, it } from 'vitest';
import { campaignCode, campaignContents, campaignRailFacts, type CampaignCounts } from './campaignFacts';
import { visibleFacts } from './facts';

const campaign = {
	campaign_id: 'c1',
	campaign_code: 'C-6',
	name: 'Turning trial',
	campaign_type: 'machining_trial',
	start_date: '2024-01-05',
	end_date: null,
	owner_person_id: { full_name: 'Ada Owner' },
	default_equipment_id: { equipment_name: 'NLX 2500' },
	default_material_id: { common_name: 'Ti-6Al-4V' },
	project_id: { project_id: 'p1', project_code: '10', project_name: 'Aero' },
};
const counts: CampaignCounts = { samples: 12, hiddenSamples: 0, operations: 30, tests: 4 };
const byLabel = (facts: ReturnType<typeof campaignRailFacts>, label: string) => facts.find((f) => f.label === label);

describe('campaignCode', () => {
	it('is the code, else the name, else "Campaign"', () => {
		expect(campaignCode(campaign)).toBe('C-6');
		expect(campaignCode({ name: 'Free text' })).toBe('Free text');
		expect(campaignCode(null)).toBe('Campaign');
	});
});

describe('campaignRailFacts', () => {
	it('has the old meta line, the project and the counts, in order', () => {
		const facts = campaignRailFacts(campaign, {}, counts);
		expect(visibleFacts(facts).map((f) => f.label)).toEqual(['Type', 'Owner', 'Dates', 'Machine', 'Material', 'Project', 'Samples', 'Operations', 'Test sessions']);
		expect(byLabel(facts, 'Type')?.value).toBe('Machining trial');
		expect(byLabel(facts, 'Owner')?.value).toBe('Ada Owner');
		expect(byLabel(facts, 'Dates')?.value).toBe('From 5 Jan 2024');
		expect(byLabel(facts, 'Machine')?.value).toBe('NLX 2500');
		expect(byLabel(facts, 'Material')?.value).toBe('Ti-6Al-4V');
	});

	it('links the project, with its name beside the code', () => {
		expect(byLabel(campaignRailFacts(campaign, {}, counts), 'Project')).toMatchObject({ value: 'Project 10 · Aero', to: '/home/projects/p1' });
	});

	it('marks a hidden project instead of leaving it blank, and omits a missing one', () => {
		expect(byLabel(campaignRailFacts({ ...campaign, project_id: null }, { project_id: true }, counts), 'Project')).toMatchObject({ hidden: true, value: null });
		const none = byLabel(campaignRailFacts({ ...campaign, project_id: null }, {}, counts), 'Project');
		expect(none?.value).toBeNull();
		expect(none?.hidden).toBeUndefined();
	});

	it('links the operations and tests counts to the index filtered by this campaign', () => {
		const facts = campaignRailFacts(campaign, {}, counts);
		expect(byLabel(facts, 'Operations')).toMatchObject({ value: '30', to: '/home/operations?f.campaign_id=c1' });
		expect(byLabel(facts, 'Test sessions')).toMatchObject({ value: '4', to: '/home/tests?f.campaign_id=c1' });
	});

	it('shows the samples count as plain text, with the hidden ones noted after it', () => {
		const plain = byLabel(campaignRailFacts(campaign, {}, counts), 'Samples');
		expect(plain).toMatchObject({ value: '12' });
		expect(plain?.to).toBeUndefined();
		expect(plain?.unit).toBeUndefined();
		const hidden = byLabel(campaignRailFacts(campaign, {}, { ...counts, hiddenSamples: 2 }), 'Samples');
		expect(hidden).toMatchObject({ value: '12', unit: '+ some hidden' });
	});

	it('shows a dash with no link for a count whose read failed, never a wrong 0', () => {
		const facts = campaignRailFacts(campaign, {}, { ...counts, operations: 0 }, { operations: true });
		expect(byLabel(facts, 'Operations')).toEqual({ label: 'Operations', value: '–' });
		expect(byLabel(facts, 'Test sessions')).toMatchObject({ value: '4', to: '/home/tests?f.campaign_id=c1' });
		const all = campaignRailFacts(campaign, {}, counts, { samples: true, operations: true, tests: true });
		expect(['Samples', 'Operations', 'Test sessions'].map((l) => byLabel(all, l))).toEqual([
			{ label: 'Samples', value: '–' },
			{ label: 'Operations', value: '–' },
			{ label: 'Test sessions', value: '–' },
		]);
	});

	it('leaves the counts out while the page still loads them', () => {
		expect(visibleFacts(campaignRailFacts(campaign, {}, null)).map((f) => f.label)).toEqual(['Type', 'Owner', 'Dates', 'Machine', 'Material', 'Project']);
	});

	it('is empty without a campaign', () => {
		expect(campaignRailFacts(null, {}, counts)).toEqual([]);
	});
});

describe('campaignContents', () => {
	const rows = { matrix: 12, samples: 12, tests: null, operations: 30 };
	it('lists the panels in page order with the ids the sections carry', () => {
		const entries = campaignContents({ hasNotes: true, ...rows });
		expect(entries.map((e) => e.id)).toEqual(['notes', 'matrix', 'samples', 'test-sessions', 'operations']);
		expect(entries.find((e) => e.id === 'operations')?.count).toBe(30);
		expect(entries.find((e) => e.id === 'test-sessions')?.count).toBeNull();
	});

	it('leaves out Notes when there are none', () => {
		expect(campaignContents({ hasNotes: false, ...rows }).map((e) => e.id)).toEqual(['matrix', 'samples', 'test-sessions', 'operations']);
	});
});
