import { describe, expect, it } from 'vitest';
import { NO_SCALE_REASON, distanceUm, formatLength, lineUm, measureScale, pixelDistance, previewRatio } from './measure';

describe('what Measure needs', () => {
	it('needs both the pixel size and the original width, and no fallback', () => {
		expect(measureScale({ pixel_size_nm: 971.354, image_width_px: 2048 })).toEqual({ pixelSizeNm: 971.354, originalWidthPx: 2048 });
		expect(measureScale({ pixel_size_nm: 971.354 })).toBeNull();
		expect(measureScale({ image_width_px: 2048 })).toBeNull();
		expect(measureScale({ pixel_size_nm: 100, hfw_um: 51.2 })).toEqual({ pixelSizeNm: 100, originalWidthPx: 512 }); // the width follows from the field width and the pixel size
		expect(measureScale({ hfw_um: 50 })).toBeNull(); // no pixel size: no scale
		expect(measureScale({ pixel_size_nm: 0, image_width_px: 2048 })).toBeNull();
		expect(measureScale({ pixel_size_nm: '100', image_width_px: 2048 })).toBeNull();
		expect(measureScale({})).toBeNull();
		expect(measureScale(null)).toBeNull();
		expect(NO_SCALE_REASON).toBe('no scale known for this image');
	});
});

describe('the maths', () => {
	it('is original width over preview width for the ratio', () => {
		expect(previewRatio(2048, 1024)).toBe(2);
		expect(previewRatio(1024, 1024)).toBe(1);
		expect(previewRatio(0, 1024)).toBeNull();
		expect(previewRatio(2048, 0)).toBeNull();
	});

	it('measures a 200 px line at 971.354 nm per pixel as 194.27 µm at ratio 1 and double at ratio 2, within one original pixel', () => {
		const oneOriginalPixelUm = 971.354 / 1000;
		expect(Math.abs(distanceUm(200, 971.354, 1)! - 194.27)).toBeLessThan(oneOriginalPixelUm);
		expect(Math.abs(distanceUm(200, 971.354, 2)! - 388.54)).toBeLessThan(oneOriginalPixelUm);
		expect(distanceUm(200, 971.354, 2)! / distanceUm(200, 971.354, 1)!).toBeCloseTo(2, 10);
	});

	it('is null without a pixel size or a ratio, and for a distance that is not a length', () => {
		expect(distanceUm(200, null, 1)).toBeNull();
		expect(distanceUm(200, 100, null)).toBeNull();
		expect(distanceUm(200, 0, 1)).toBeNull();
		expect(distanceUm(Number.NaN, 100, 1)).toBeNull();
		expect(distanceUm(-1, 100, 1)).toBeNull();
		expect(distanceUm(0, 100, 1)).toBe(0);
	});

	it('takes the straight distance', () => {
		expect(pixelDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
	});

	it('measures a line given as fractions of the picture, on the preview size: a synthetic picture', () => {
		// a 1000 x 800 preview of a 2000 px wide original (ratio 2) at 100 nm per original pixel: a line over a quarter of the width is 250 preview px, 500 original px, 50 µm
		const scale = { pixelSizeNm: 100, originalWidthPx: 2000 };
		const um = lineUm({ x: 0.1, y: 0.5 }, { x: 0.35, y: 0.5 }, { width: 1000, height: 800 }, scale)!;
		expect(Math.abs(um - 50)).toBeLessThan(0.1);
		// the same line drawn at any screen size has the same fractions, so the same length; a diagonal uses the preview's own aspect
		const diag = lineUm({ x: 0, y: 0 }, { x: 0.3, y: 0.375 }, { width: 1000, height: 800 }, scale)!;
		expect(diag).toBeCloseTo((Math.hypot(300, 300) * 2 * 100) / 1000, 6);
		// no scale, or a preview of no size yet: nothing
		expect(lineUm({ x: 0, y: 0 }, { x: 1, y: 0 }, { width: 1000, height: 800 }, null)).toBeNull();
		expect(lineUm({ x: 0, y: 0 }, { x: 1, y: 0 }, { width: 0, height: 0 }, scale)).toBeNull();
	});
});

describe('the length as text', () => {
	it('is in µm from 1 µm up, with two decimals at most', () => {
		expect(formatLength(194.2708)).toBe('194.27 µm');
		expect(formatLength(5)).toBe('5 µm');
		expect(formatLength(1)).toBe('1 µm');
		expect(formatLength(12.5)).toBe('12.5 µm');
		expect(formatLength(1234.5678)).toBe('1,234.57 µm');
	});
	it('is in nm below 1 µm', () => {
		expect(formatLength(0.43)).toBe('430 nm');
		expect(formatLength(0.0085)).toBe('8.5 nm');
		expect(formatLength(0)).toBe('0 nm');
	});
	it('is empty for something that is not a length', () => {
		expect(formatLength(Number.NaN)).toBe('');
		expect(formatLength(-3)).toBe('');
	});
});
