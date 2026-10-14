import { describe, expect, it } from 'vitest';
import { HIDDEN_CAMPAIGNS_LABEL, coOwnerText, sampleCampaigns, sampleDetailBase, sampleDims, sampleKind, sampleMassText, sampleRailFacts } from './sampleFacts';

const sample = {
	sample_id: 's1',
	sample_code: '10-AA-1',
	form: 'round_bar',
	diameter_mm: '10',
	length_mm: '50',
	location: 'Shelf 3',
	manufactured_date: '2024-05-02',
	mounted: true,
	mounting_method: 'Resin',
	material_id: { common_name: 'Inconel 718', alloy_code: 'IN718', density_g_per_cm3: 8.19 },
	project_id: { project_id: 'p1', project_code: '10', project_name: 'Big project' },
	owner_person_id: { full_name: 'Ada Owner' },
	co_owners: [{ user_id: { first_name: 'Bo', last_name: 'Co' } }, { user_id: { first_name: 'Cy', last_name: null } }],
	primary_method_id: { method_name: 'LPBF' },
};
const camp = (id: string, code: string | null, name = '') => ({ campaign_id: { campaign_id: id, campaign_code: code, name } });
const byLabel = (facts: ReturnType<typeof sampleRailFacts>, label: string) => facts.find((f) => f.label === label);

describe('sampleDims', () => {
	it('turns the numeric strings Directus sends into numbers, and blanks into null', () => {
		expect(sampleDims(sample)).toMatchObject({ form: 'round_bar', diameter_mm: 10, length_mm: 50, width_mm: null, gauge_length_mm: null });
		expect(sampleDims(null).form).toBeNull();
	});
});

describe('sampleKind', () => {
	it('names the form, and is plain without one', () => {
		expect(sampleKind(sample)).toBe('Sample · Round bar');
		expect(sampleKind({ form: null })).toBe('Sample');
		expect(sampleKind(null)).toBe('Sample');
	});
});

describe('sampleMassText', () => {
	it('prefers the measured mass', () => {
		expect(sampleMassText({ ...sample, mass_grams: '12.5' })).toBe('12.5 g');
	});
	it('estimates from the dimensions and the density, and says so', () => {
		// pi * 5^2 * 50 mm3 = 3926.99 mm3 = 3.927 cm3, times 8.19 g/cm3 = 32.16 g
		expect(sampleMassText(sample)).toBe('≈ 32.16 g (estimated)');
	});
	it('is empty when neither is known', () => {
		expect(sampleMassText({ form: 'other' })).toBe('');
		expect(sampleMassText({ ...sample, material_id: null })).toBe('');
	});
});

describe('sampleCampaigns', () => {
	it('splits readable campaigns from links whose campaign came back null', () => {
		const r = sampleCampaigns([camp('c1', 'C-6'), { campaign_id: null }, { campaign_id: null }]);
		expect(r.campaigns).toHaveLength(1);
		expect(r.hidden).toBe(2);
	});
});

describe('coOwnerText', () => {
	it('joins the names it can build', () => {
		expect(coOwnerText(sample)).toBe('Bo Co, Cy');
		expect(coOwnerText({})).toBe('');
	});
});

describe('sampleRailFacts', () => {
	it('shows the owning team as the Owner of a team-owned sample', () => {
		const facts = sampleRailFacts({ ...sample, owner_person_id: null, owner_team_id: { team_id: 't1', name: 'Additive', color: 'teal', logo: null } }, '', [], {});
		expect(byLabel(facts, 'Owner')?.value).toBe('Additive');
	});

	it('has material, dimensions, mass, location, owners, project and campaigns, in order', () => {
		const facts = sampleRailFacts(sample, 'Ø10 · L50 mm', [camp('c1', 'C-6')], {});
		expect(facts.map((f) => f.label)).toEqual(['Material', 'Dimensions', 'Mass', 'Location', 'Owner', 'Co-owners', 'Project', 'Campaigns']);
		expect(byLabel(facts, 'Material')?.value).toBe('Inconel 718');
		expect(byLabel(facts, 'Dimensions')?.value).toBe('Ø10 · L50 mm');
		expect(byLabel(facts, 'Project')).toMatchObject({ value: '10', to: '/home/projects/p1' });
		expect(byLabel(facts, 'Campaigns')?.list).toEqual([{ label: 'Campaign C-6', to: '/home/campaigns/c1' }]);
	});

	it('falls back to the alloy code, and to the campaign name when it has no code', () => {
		const facts = sampleRailFacts({ ...sample, material_id: { alloy_code: 'IN718' } }, '', [camp('c2', null, 'Spring run')], {});
		expect(byLabel(facts, 'Material')?.value).toBe('IN718');
		expect(byLabel(facts, 'Campaigns')?.list?.[0].label).toBe('Spring run');
	});

	it('lists every campaign (the rail caps the display) and counts hidden ones', () => {
		const rows = Array.from({ length: 8 }, (_, i) => camp(`c${i}`, `C-${i}`));
		const facts = sampleRailFacts(sample, '', [...rows, { campaign_id: null }], {});
		const f = byLabel(facts, 'Campaigns');
		expect(f?.list).toHaveLength(9);
		expect(f?.list?.[8]).toEqual({ label: 'Some campaigns', hidden: true });
		// One list entry standing for two hidden links: no number, however many are hidden.
		const two = byLabel(sampleRailFacts(sample, '', [{ campaign_id: null }, { campaign_id: null }], {}), 'Campaigns');
		expect(two?.list).toEqual([{ label: 'Some campaigns', hidden: true }]);
		expect(HIDDEN_CAMPAIGNS_LABEL).not.toMatch(/\d/);
	});

	it('marks a hidden project, and a project that came back as a bare id', () => {
		expect(byLabel(sampleRailFacts({ ...sample, project_id: null }, '', [], { project_id: true }), 'Project')).toMatchObject({ hidden: true, value: null });
		expect(byLabel(sampleRailFacts({ ...sample, project_id: 'p9' }, '', [], {}), 'Project')?.hidden).toBe(true);
	});

	it('has an empty campaign list (left out by the list) when there are none', () => {
		const f = byLabel(sampleRailFacts(sample, '', [], {}), 'Campaigns');
		expect(f?.list).toEqual([]);
		expect(f?.value).toBeNull();
	});

	it('leaves the project out when there is none and nothing is hidden', () => {
		const p = byLabel(sampleRailFacts({ ...sample, project_id: null }, '', [], {}), 'Project');
		expect(p?.value).toBeNull();
		expect(p?.hidden).toBeUndefined();
	});

	it('is empty without a record', () => {
		expect(sampleRailFacts(null, '', [], {})).toEqual([]);
	});
});

describe('sampleDetailBase', () => {
	it('has the old overview values the rail does not, plus the project name', () => {
		const facts = sampleDetailBase({ ...sample, manufacturing_route: 'AM', surface_finish: 'As built', item_type: 'specimen', stock_category: 'S' });
		expect(facts.map((f) => f.label)).toEqual([
			'Project name', 'Manufacturing method', 'Manufacturing route', 'Manufactured', 'Surface finish', 'Item type', 'Stock category', 'Mounted',
		]);
		expect(facts.find((f) => f.label === 'Manufactured')?.value).toBe('2 May 2024');
		expect(facts.find((f) => f.label === 'Mounted')?.value).toBe('Resin');
		expect(sampleDetailBase({ ...sample, mounted: true, mounting_method: null }).find((f) => f.label === 'Mounted')?.value).toBe('Yes');
		expect(sampleDetailBase({ ...sample, mounted: false }).find((f) => f.label === 'Mounted')?.value).toBe('');
	});
});
