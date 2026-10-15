import { describe, expect, it } from 'vitest';
import { parseSelectionQuery } from '@d1/ui';
import { LABELS_LINK_CAP, createdText, labelsLink, labelsPath, missingLabel, moreLabelsText, printLabelsText } from './createText';

describe('createText', () => {
	it('says what is missing', () => {
		expect(missingLabel(1)).toBe('1 thing missing');
		expect(missingLabel(3)).toBe('3 things missing');
	});

	it('says what was created', () => {
		expect(createdText(1)).toBe('Created 1 record');
		expect(createdText(6)).toBe('Created 6 records');
	});

	it('offers labels for the new samples', () => {
		expect(printLabelsText(1)).toBe('Print labels for 1 new sample');
		expect(printLabelsText(4)).toBe('Print labels for 4 new samples');
	});
});

describe('labelsPath', () => {
	const A = '0b9c5a3e-1f2d-4c6b-8a7e-123456789abc';
	const B = '1c0d6b4f-2a3e-4d7c-9b8f-23456789abcd';

	it('is the labels page with the ids, comma separated', () => {
		expect(labelsPath([A, B])).toBe(`/home/labels?ids=${A},${B}`);
	});

	it('drops blanks and repeats, keeps the order', () => {
		expect(labelsPath([B, '', A, B])).toBe(`/home/labels?ids=${B},${A}`);
	});

	it('is null for no samples', () => {
		expect(labelsPath([])).toBeNull();
		expect(labelsPath([''])).toBeNull();
	});

	it('carries at most 200 samples and says how many more there were', () => {
		const ids = Array.from({ length: 217 }, (_, i) => `id-${i}`);
		const link = labelsLink(ids);
		expect(LABELS_LINK_CAP).toBe(200);
		expect(link.ids).toHaveLength(200);
		expect(link.more).toBe(17);
		expect(labelsPath(ids)!.split('=')[1].split(',')).toHaveLength(200);
		expect(labelsLink(ids.slice(0, 200)).more).toBe(0);
		expect(moreLabelsText(17)).toBe('and 17 more are not in this link: pick them on the Labels page');
		expect(moreLabelsText(1)).toBe('and 1 more is not in this link: pick it on the Labels page');
	});

	it('is what the labels page reads back', () => {
		const q = new URL(`http://x${labelsPath([A, B])}`).searchParams.get('ids');
		expect(parseSelectionQuery({ ids: q }).ids).toEqual([A, B]);
	});
});
