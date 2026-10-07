// campaigns.campaign_type (20260710000087_campaign_redesign.sql): label, and which
// manufacturing_operations.process_category the "assign operations" search offers for it.
// null means no restriction (types that do not select manufacturing operations).

export const CAMPAIGN_TYPE_LABEL: Record<string, string> = {
	machining_trial: 'Machining trial',
	testing_campaign: 'Testing campaign',
	imaging_analysis: 'Imaging / analysis',
};

const CATEGORY_FOR_TYPE: Record<string, string | null> = {
	machining_trial: 'machining',
	testing_campaign: null,
	imaging_analysis: null,
};

export function campaignTypeLabel(type: string | null | undefined): string {
	if (!type) return 'Campaign';
	return CAMPAIGN_TYPE_LABEL[type] ?? type.replace(/_/g, ' ');
}

export function operationCategoryFor(type: string | null | undefined): string | null {
	return type ? (CATEGORY_FOR_TYPE[type] ?? null) : null;
}
