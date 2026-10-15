// What the Sample page shows beside and inside its panels, built from the records the page already
// loads: the rail's kind line and key facts, the "Material and details" panel's remaining facts and
// the normalised dimensions the drawing and the mass estimate share. Pure and tested here (the
// extension has no test runner); see operationFacts.ts for the Operation page's twin.

import { asRecord, formatDate, formatNumber } from '../format';
import { estimateMassGrams } from '../mass';
import { recordRoute } from '../recordRoute';
import { choiceLabel } from '../choiceLabels';
import { projectFact, type HiddenLinks } from './operationFacts';
import { ownerName, type Fact } from './facts';

type Rec = Record<string, any>;

/** The sample's shape fields as numbers: the input of the drawing, `dimsText` and the mass estimate.
 *  Structurally the geometry engine's `Dims`. */
export interface SampleDims {
	form: string | null;
	diameter_mm: number | null;
	inner_diameter_mm: number | null;
	length_mm: number | null;
	width_mm: number | null;
	thickness_mm: number | null;
	gauge_length_mm: number | null;
	gauge_width_mm: number | null;
}

// Directus may send numeric columns as strings; the drawing and the estimate want numbers.
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

export function sampleDims(sample: Rec | null | undefined): SampleDims {
	return {
		form: sample?.form ?? null,
		diameter_mm: num(sample?.diameter_mm),
		inner_diameter_mm: num(sample?.inner_diameter_mm),
		length_mm: num(sample?.length_mm),
		width_mm: num(sample?.width_mm),
		thickness_mm: num(sample?.thickness_mm),
		gauge_length_mm: num(sample?.gauge_length_mm),
		gauge_width_mm: num(sample?.gauge_width_mm),
	};
}

/** "Sample · Round bar"; a plain "Sample" when it has no form. */
export function sampleKind(sample: Rec | null | undefined): string {
	return sample?.form ? `Sample · ${choiceLabel('geometry', sample.form)}` : 'Sample';
}

/** The measured mass, else an estimate from the dimensions and the material's density (marked as one). */
export function sampleMassText(sample: Rec | null | undefined): string {
	if (!sample) return '';
	const measured = num(sample.mass_grams);
	if (measured !== null) return formatNumber(measured, 'g');
	const est = estimateMassGrams(sampleDims(sample), num(asRecord(sample.material_id)?.density_g_per_cm3));
	return est === null ? '' : `≈ ${formatNumber(est, 'g', est >= 100 ? 0 : 2)} (estimated)`;
}

/** The campaigns a sample belongs to, from its `campaign_samples` rows: the campaigns the user may
 *  read, and how many links came back with no campaign (hidden by row-level visibility, ADR-0011). */
/** The label of the one hidden-campaign entry: never a number (how many campaigns a reader may not see is itself restricted information). */
export const HIDDEN_CAMPAIGNS_LABEL = 'Some campaigns';

export function sampleCampaigns(rows: Rec[]): { campaigns: Rec[]; hidden: number } {
	const campaigns = rows.map((r) => asRecord(r?.campaign_id)).filter((c): c is Rec => !!c?.campaign_id);
	return { campaigns, hidden: rows.length - campaigns.length };
}

/** The co-owners' names, comma separated. */
export function coOwnerText(sample: Rec | null | undefined): string {
	const list = Array.isArray(sample?.co_owners) ? sample.co_owners : [];
	return list
		.map((c: any) => [c?.user_id?.first_name, c?.user_id?.last_name].filter(Boolean).join(' '))
		.filter(Boolean)
		.join(', ');
}

/**
 * The rail's key facts: the material, the dimensions (the form is in the kind line), mass, location,
 * the old header's meta line (owner, co-owners) and the links up the tree (project, campaigns as one
 * list). `dimensions` is the drawing engine's `dimsText`, which lives with that engine in the
 * extension; `campaignRows` are the `campaign_samples` rows.
 */
export function sampleRailFacts(sample: Rec | null | undefined, dimensions: string, campaignRows: Rec[], hidden: HiddenLinks): Fact[] {
	if (!sample) return [];
	const material = asRecord(sample.material_id);
	const project = asRecord(sample.project_id);
	const { campaigns, hidden: hiddenCampaigns } = sampleCampaigns(campaignRows);
	// A campaign without a code is named by its free-text name.
	const campaignList: NonNullable<Fact['list']> = campaigns.map((c) => ({
		label: c.campaign_code ? `Campaign ${c.campaign_code}` : c.name || 'Campaign',
		to: recordRoute('campaigns', c.campaign_id),
	}));
	if (hiddenCampaigns > 0) campaignList.push({ label: HIDDEN_CAMPAIGNS_LABEL, hidden: true });
	return [
		{ label: 'Material', value: material?.common_name || material?.alloy_code },
		{ label: 'Dimensions', value: dimensions },
		{ label: 'Mass', value: sampleMassText(sample) },
		{ label: 'Location', value: sample.location },
		{ label: 'Owner', value: ownerName(sample) },
		{ label: 'Co-owners', value: coOwnerText(sample) },
		// A project link that came back as a bare id was not readable: hidden, like a missing one.
		projectFact(project, hidden.project_id || (!!sample.project_id && !project)),
		{ label: 'Campaigns', value: null, list: campaignList },
	];
}

/** The sample's own values for the "Material and details" panel (the rail's facts left out). */
export function sampleDetailBase(sample: Rec | null | undefined): Fact[] {
	if (!sample) return [];
	return [
		{ label: 'Project name', value: asRecord(sample.project_id)?.project_name },
		{ label: 'Manufacturing method', value: asRecord(sample.primary_method_id)?.method_name },
		{ label: 'Manufacturing route', value: sample.manufacturing_route },
		{ label: 'Manufactured', value: formatDate(sample.manufactured_date) },
		{ label: 'Surface finish', value: choiceLabel('surfaceFinish', sample.surface_finish) },
		{ label: 'Item type', value: sample.item_type },
		{ label: 'Stock category', value: sample.stock_category },
		{ label: 'Mounted', value: sample.mounted ? sample.mounting_method || 'Yes' : '' },
	];
}
