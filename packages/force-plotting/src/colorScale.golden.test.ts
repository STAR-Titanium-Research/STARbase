// Characterisation test pinning colorScale.ts's LUT maths across the combinatorial surface that
// actually matters here: colormap x steps x symmetrical x logScale. This is exactly the surface a
// later refactor (e.g. changing how symlog or quantisation is computed) is most likely to disturb
// without any single unit test catching it. DO NOT edit the committed snapshot file to make a
// later change pass -- a snapshot diff here means the LUT bytes changed, which is what this guards.
import { describe, expect, it } from 'vitest';
import { buildScaleLUT, defaultScale, denormalize, normalize, type ColorScale } from './colorScale';

function scale(overrides: Partial<ColorScale> = {}): ColorScale {
	return { ...defaultScale(-100, 100), ...overrides };
}

const CASES: [string, Partial<ColorScale>][] = [
	['viridis, linear, full steps', { colormap: 'viridis', steps: 256, logScale: false }],
	['viridis, linear, coarse steps (8)', { colormap: 'viridis', steps: 8, logScale: false }],
	['viridis, symlog, full steps', { colormap: 'viridis', steps: 256, logScale: true }],
	['viridis, symlog, coarse steps (8) -- banded', { colormap: 'viridis', steps: 8, logScale: true }],
	['inferno, symlog, medium steps (32)', { colormap: 'inferno', steps: 32, logScale: true }],
	['grayscale, linear, full steps', { colormap: 'grayscale', steps: 256, logScale: false }],
	['viridis, symmetrical range, symlog', {
		colormap: 'viridis', steps: 16, logScale: true, symmetrical: true, satMin: -30, satMax: 90,
	}],
	['viridis, asymmetric positive-only range, symlog', {
		colormap: 'viridis', steps: 16, logScale: true, satMin: 5, satMax: 500,
	}],
];

describe('buildScaleLUT golden', () => {
	for (const [name, overrides] of CASES) {
		it(name, () => {
			const s = scale(overrides);
			const lut = buildScaleLUT(s, 32);   // narrow width keeps the snapshot readable
			expect(Array.from(lut)).toMatchSnapshot();
		});
	}
});

describe('normalize/denormalize golden', () => {
	const SAMPLE_T = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
	for (const [name, overrides] of CASES) {
		it(name, () => {
			const s = scale(overrides);
			const values = SAMPLE_T.map((t) => Number(denormalize(t, s).toFixed(6)));
			const roundTrip = values.map((v) => Number(normalize(v, s).toFixed(6)));
			expect({ values, roundTrip }).toMatchSnapshot();
		});
	}
});
