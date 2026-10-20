import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS } from './inboxModel';
import { actualWidthPx, boxScaleBar, listBase, listPath, neighbours, partnerOf, positionText, swapCandidate, viewBoxPath } from './viewBoxModel';

describe('the view box addresses', () => {
	it('carry the list filters and leave out the defaults', () => {
		expect(listPath(DEFAULT_FILTERS)).toBe('/inbox');
		expect(viewBoxPath('c1', DEFAULT_FILTERS)).toBe('/inbox/file/c1');
		expect(listPath({ ...DEFAULT_FILTERS, kind: 'sem_image', tab: 'older', folder: 'a b' })).toBe('/inbox?tab=older&kind=sem_image&folder=a+b');
		expect(viewBoxPath('c 1', { ...DEFAULT_FILTERS, strength: 'short_id,code' })).toBe('/inbox/file/c%201?strength=short_id%2Ccode');
	});
	it('swap the file in a route path, keeping what the host mounts the pages under', () => {
		expect(swapCandidate('/inbox/file/a', 'b')).toBe('/inbox/file/b');
		expect(swapCandidate('/home/inbox/file/a/', 'b c')).toBe('/home/inbox/file/b%20c');
		expect(listBase('/inbox/file/a')).toBe('/inbox');
		expect(listBase('/home/inbox/file/a')).toBe('/home/inbox');
	});
});

describe('the compare partner in the address', () => {
	it('is added as ?with= after the filters, and never names the file itself', () => {
		expect(viewBoxPath('c1', DEFAULT_FILTERS, 'c2')).toBe('/inbox/file/c1?with=c2');
		expect(viewBoxPath('c1', { ...DEFAULT_FILTERS, kind: 'sem_image' }, 'c 2')).toBe('/inbox/file/c1?kind=sem_image&with=c+2');
		expect(viewBoxPath('c1', DEFAULT_FILTERS, 'c1')).toBe('/inbox/file/c1');
		expect(viewBoxPath('c1', DEFAULT_FILTERS, null)).toBe('/inbox/file/c1');
	});
	it('is read from the query: the first value, nothing for an empty one or the open file', () => {
		expect(partnerOf({ with: 'c2' }, 'c1')).toBe('c2');
		expect(partnerOf({ with: ['c2', 'c3'] }, 'c1')).toBe('c2');
		expect(partnerOf({ with: '' }, 'c1')).toBe('');
		expect(partnerOf({ with: 'c1' }, 'c1')).toBe('');
		expect(partnerOf({}, 'c1')).toBe('');
		expect(partnerOf({ with: 5 }, 'c1')).toBe('');
	});
});

describe('neighbours', () => {
	const ids = ['a', 'b', 'c'];
	it('finds the file and the ones around it', () => {
		expect(neighbours(ids, 'b')).toEqual({ index: 1, prev: 'a', next: 'c' });
		expect(neighbours(ids, 'a')).toEqual({ index: 0, prev: null, next: 'b' });
		expect(neighbours(ids, 'c')).toEqual({ index: 2, prev: 'b', next: null });
		expect(neighbours(['a'], 'a')).toEqual({ index: 0, prev: null, next: null });
	});
	it('is null for a file that is not in the list: no guess', () => {
		expect(neighbours(ids, 'z')).toBeNull();
		expect(neighbours([], 'a')).toBeNull();
	});
	it('says "n of m", never less than n', () => {
		expect(positionText(0, 120)).toBe('1 of 120');
		expect(positionText(4, 3)).toBe('5 of 5');
	});
});

describe('1:1 and the scale bar', () => {
	it('draws at the original width when the file says it, else at the preview width, else not at all', () => {
		expect(actualWidthPx({ image_width_px: 4096 }, 1600)).toBe(4096);
		expect(actualWidthPx({}, 1600)).toBe(1600);
		expect(actualWidthPx({ image_width_px: 0 }, null)).toBeNull();
		expect(actualWidthPx({ image_width_px: 'wide' }, 0)).toBeNull();
	});
	it('reads the original width the way Common scale does: a file with only the field width and the pixel size has 1024 px, not the preview width', () => {
		const e = { pixel_size_nm: 194.271, hfw_um: 198.933 }; // 198.933 µm / 194.271 nm = 1024 px
		expect(actualWidthPx(e, 1600)).toBeCloseTo(1024, 0);
		expect(actualWidthPx(e, null)).toBeCloseTo(1024, 0);
		expect(actualWidthPx({ ...e, image_width_px: 2048 }, 1600)).toBe(2048); // a stored width wins
		expect(actualWidthPx({ hfw_um: 198.933 }, 1600)).toBe(1600); // no pixel size: the field width alone says nothing
	});
	it('has no bar without a pixel size', () => {
		expect(boxScaleBar({}, 'fit', null)).toBeNull();
		expect(boxScaleBar({ image_width_px: 1000 }, 'actual', 1000)).toBeNull();
	});
	it('is a round length: about a fifth of the picture at Fit, about 150 screen pixels at 1:1', () => {
		const e = { pixel_size_nm: 100, image_width_px: 1000 }; // 100 µm wide
		expect(boxScaleBar(e, 'fit', null)).toMatchObject({ label: '20 µm', fraction: 0.2 });
		const big = { pixel_size_nm: 10, image_width_px: 4000 }; // 40 µm wide, 4000 px: 1 µm = 100 px
		const bar = boxScaleBar(big, 'actual', 4000)!;
		expect(bar.label).toBe('1 µm');
		expect(bar.fraction * 4000).toBeCloseTo(100);
	});
});
