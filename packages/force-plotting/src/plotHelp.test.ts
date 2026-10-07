import { describe, expect, it } from 'vitest';
import { PLOT_HELP } from './plotHelp';

describe('PLOT_HELP', () => {
	it('covers the gestures the dashboard promises', () => {
		const text = JSON.stringify(PLOT_HELP).toLowerCase();
		for (const k of ['right-click', 'crop handle', 'rectangular zoom', 'show position in time', 'compare', 'difference', 'copy link', 'csv', 'png']) {
			expect(text).toContain(k);
		}
	});
	it('has no empty entries', () => {
		for (const s of PLOT_HELP) for (const g of s.items) { expect(g.gesture).toBeTruthy(); expect(g.does).toBeTruthy(); }
	});
});
