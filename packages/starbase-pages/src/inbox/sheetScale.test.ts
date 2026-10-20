import { describe, expect, it } from 'vitest';
import { sheetScaleBar, widthUm } from './sheetScale';

describe('the sheet scale bar', () => {
	it('needs a pixel size; with it, the width is pixel size x original width', () => {
		expect(widthUm({})).toBeNull();
		expect(widthUm({ image_width_px: 1024 })).toBeNull();
		expect(widthUm({ pixel_size_nm: 100, image_width_px: 1000 })).toBe(100);
	});

	it('falls back to the field width when the original width is not known', () => {
		expect(widthUm({ pixel_size_nm: 29.14, hfw_um: 59.7 })).toBe(59.7);
		expect(widthUm({ pixel_size_nm: 29.14 })).toBeNull();
	});

	it('draws a round length near a fifth of the picture', () => {
		// 100 µm wide: a fifth is 22 µm, the round length not above it is 20 µm
		expect(sheetScaleBar({ pixel_size_nm: 100, image_width_px: 1000 })).toEqual({ fraction: 0.2, label: '20 µm' });
		// 59.7 µm wide: 13.1 wanted, 10 µm
		const b = sheetScaleBar({ pixel_size_nm: 29.14, hfw_um: 59.7 })!;
		expect(b.label).toBe('10 µm');
		expect(b.fraction).toBeCloseTo(10 / 59.7, 6);
	});

	it('uses nanometres under 1 µm and millimetres from 1000 µm', () => {
		expect(sheetScaleBar({ pixel_size_nm: 1, image_width_px: 2000 })!.label).toBe('200 nm'); // 2 µm wide, 0.44 wanted: 0.2 µm
		expect(sheetScaleBar({ pixel_size_nm: 5000, image_width_px: 1000 })!.label).toBe('1 mm'); // 5 mm wide, 1.1 mm wanted
	});

	it('says nothing for a pixel size that makes no sense', () => {
		expect(sheetScaleBar({ pixel_size_nm: 0, image_width_px: 1000 })).toBeNull();
		expect(sheetScaleBar({ pixel_size_nm: 'x', image_width_px: 1000 })).toBeNull();
	});
});
