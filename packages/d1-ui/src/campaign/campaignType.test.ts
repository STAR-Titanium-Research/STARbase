import { describe, expect, it } from 'vitest';
import { campaignTypeLabel, operationCategoryFor } from './campaignType';

describe('campaign type', () => {
	it('a machining trial only offers machining operations, other types offer any', () => {
		expect(operationCategoryFor('machining_trial')).toBe('machining');
		expect(operationCategoryFor('testing_campaign')).toBeNull();
		expect(operationCategoryFor('imaging_analysis')).toBeNull();
		expect(operationCategoryFor('something_new')).toBeNull();
		expect(operationCategoryFor(undefined)).toBeNull();
	});

	it('labels known types and humanises unknown ones', () => {
		expect(campaignTypeLabel('machining_trial')).toBe('Machining trial');
		expect(campaignTypeLabel('imaging_analysis')).toBe('Imaging / analysis');
		expect(campaignTypeLabel('x_y')).toBe('x y');
		expect(campaignTypeLabel(null)).toBe('Campaign');
	});
});
