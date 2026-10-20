import { describe, expect, it } from 'vitest';
import { canCommonScale, commonScaleWidths, fieldUm } from './commonScale';

const A = { pixel_size_nm: 100, image_width_px: 1000 }; // 100 µm wide
const B = { pixel_size_nm: 50, image_width_px: 1000 }; // 50 µm wide

describe('common scale', () => {
	it('needs the pixel size and the width of both files', () => {
		expect(fieldUm(A)).toBe(100);
		expect(fieldUm({ pixel_size_nm: 100 })).toBeNull();
		expect(fieldUm({ pixel_size_nm: 100, hfw_um: 50 })).toBe(50); // the field width itself, when the file gave no width
		expect(canCommonScale(A, B)).toBe(true);
		expect(canCommonScale(A, {})).toBe(false);
		expect(canCommonScale(null, B)).toBe(false);
	});

	it('at Fit, draws the wider field across the pane and the other in proportion', () => {
		const w = commonScaleWidths(A, B, 'fit', 500)!;
		expect(w.widthA).toBeCloseTo(500, 9);
		expect(w.widthB).toBeCloseTo(250, 9);
		// the same micrometres per screen pixel in both
		expect(100 / w.widthA).toBeCloseTo(50 / w.widthB, 12);
		expect(w.umPerPx).toBeCloseTo(0.2, 12);
		// the other way round
		const r = commonScaleWidths(B, A, 'fit', 500)!;
		expect(r.widthA).toBeCloseTo(250, 9);
		expect(r.widthB).toBeCloseTo(500, 9);
	});

	it('at 1:1, draws the finer pixel size one original pixel per screen pixel and the other in proportion', () => {
		const w = commonScaleWidths(A, B, 'actual', 0)!; // the pane's width does not matter at 1:1
		expect(w.widthB).toBe(1000);
		expect(w.widthA).toBe(2000);
		expect(w.umPerPx).toBeCloseTo(0.05, 12);
	});

	it('is null when either file lacks its scale, or at Fit when the pane has no width yet', () => {
		expect(commonScaleWidths(A, {}, 'fit', 500)).toBeNull();
		expect(commonScaleWidths({}, B, 'actual', 500)).toBeNull();
		expect(commonScaleWidths(A, B, 'fit', 0)).toBeNull();
	});
});
