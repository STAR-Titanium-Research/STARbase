import { describe, expect, it } from 'vitest';
import { assetThumbUrl, fileId, hasDrawableDims, imageField, thumbFields, thumbKind } from './thumbs';

describe('thumbKind', () => {
	it('knows which collection shows which picture', () => {
		expect(thumbKind('physical_samples')).toBe('geometry');
		for (const c of ['equipment', 'tools', 'insert_types', 'manufacturers']) expect(thumbKind(c)).toBe('image');
		expect(thumbKind('manufacturing_operations')).toBe('force');
		expect(thumbKind('campaigns')).toBeNull();
		expect(thumbKind('test_sessions')).toBeNull();
	});
});

describe('thumbFields', () => {
	it('asks for the form and the six dimensions of a sample', () => {
		expect(thumbFields('physical_samples')).toEqual([
			'form', 'diameter_mm', 'length_mm', 'width_mm', 'thickness_mm', 'gauge_length_mm', 'gauge_width_mm',
		]);
	});
	it('asks for the file field of an image collection (the manufacturer logo has a capital L)', () => {
		expect(thumbFields('equipment')).toEqual(['image']);
		expect(thumbFields('tools')).toEqual(['image']);
		expect(thumbFields('insert_types')).toEqual(['image']);
		expect(thumbFields('manufacturers')).toEqual(['Logo']);
		expect(imageField('manufacturers')).toBe('Logo');
	});
	it('asks for nothing extra for the force thumbnail (the second request supplies it) or other lists', () => {
		expect(thumbFields('manufacturing_operations')).toEqual([]);
		expect(thumbFields('campaigns')).toEqual([]);
		expect(imageField('campaigns')).toBeNull();
	});
});

describe('hasDrawableDims', () => {
	it('is true for a form with dimensions', () => {
		expect(hasDrawableDims({ form: 'round_bar', diameter_mm: 10, length_mm: 50 })).toBe(true);
	});
	it('is true for a disc with only a diameter', () => {
		expect(hasDrawableDims({ form: 'disc', diameter_mm: '30' })).toBe(true);
	});
	it('is false for the form other, an empty form or no form', () => {
		expect(hasDrawableDims({ form: 'other', diameter_mm: 10 })).toBe(false);
		expect(hasDrawableDims({ form: 'Other', diameter_mm: 10 })).toBe(false);
		expect(hasDrawableDims({ form: '', diameter_mm: 10 })).toBe(false);
		expect(hasDrawableDims({ form: null, diameter_mm: 10 })).toBe(false);
		expect(hasDrawableDims({ diameter_mm: 10 })).toBe(false);
	});
	it('is true for a powder with no dimensions at all (the engine draws a heap)', () => {
		expect(hasDrawableDims({ form: 'powder' })).toBe(true);
		expect(hasDrawableDims({ form: 'Metal_Powder' })).toBe(true);
	});
	it('is false for a negative or non-numeric dimension, true for a numeric string', () => {
		expect(hasDrawableDims({ form: 'bar', length_mm: -5 })).toBe(false);
		expect(hasDrawableDims({ form: 'bar', length_mm: 'abc' })).toBe(false);
		expect(hasDrawableDims({ form: 'bar', length_mm: '12.5' })).toBe(true);
	});
	it('is false when no dimension is present', () => {
		expect(hasDrawableDims({ form: 'bar' })).toBe(false);
		expect(hasDrawableDims({ form: 'bar', length_mm: null, width_mm: '', thickness_mm: 0 })).toBe(false);
		expect(hasDrawableDims(null)).toBe(false);
	});
});

describe('assetThumbUrl', () => {
	it('is a cropped WebP of the given size, 320x200 by default', () => {
		expect(assetThumbUrl('abc-123')).toBe('/assets/abc-123?width=320&height=200&fit=contain&format=webp');
		expect(assetThumbUrl('abc', 64, 40)).toBe('/assets/abc?width=64&height=40&fit=contain&format=webp');
	});
});

describe('fileId', () => {
	it('reads a bare id or an expanded file, and nothing else', () => {
		expect(fileId('abc')).toBe('abc');
		expect(fileId({ id: 'abc' })).toBe('abc');
		expect(fileId(null)).toBeNull();
		expect(fileId('')).toBeNull();
		expect(fileId({})).toBeNull();
		expect(fileId({ id: 5 })).toBeNull();
	});
});

describe('collection lookup', () => {
	it('ignores names inherited from Object', () => {
		expect(thumbKind('constructor')).toBeNull();
		expect(imageField('toString')).toBeNull();
	});
});
