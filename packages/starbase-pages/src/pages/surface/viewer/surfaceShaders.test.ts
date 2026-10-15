import { describe, expect, it } from 'vitest';
import { parseMeta } from './gridData';
import { prepareScan } from './prepareScan';
import { FRAGMENT_SHADER, UNIFORMS, VERTEX_SHADER } from './surfaceShaders';

describe('surface shaders', () => {
	it('declare every uniform the scene sets, in at least one stage', () => {
		for (const u of UNIFORMS) expect(new RegExp(`uniform\\s+\\w+\\s+${u}\\b`).test(VERTEX_SHADER + FRAGMENT_SHADER), u).toBe(true);
	});
	it('share the grid declarations, so both stages agree on the uniforms', () => {
		for (const src of [VERTEX_SHADER, FRAGMENT_SHADER]) {
			expect(src).toContain('uniform sampler2D uGrid;');
			expect(src).toContain('uniform vec2 uCells;');
			expect(src).toContain('ivec2 cellOf(vec2 uv)');
		}
	});
	it('do the displacement and the normal on the GPU, from the grid texture', () => {
		expect(VERTEX_SHADER).toContain('texelFetch(uGrid');
		expect(VERTEX_SHADER).toContain('uExag');
		expect(VERTEX_SHADER).toContain('gl_Position');
	});
	it('leave holes with discard, and look the colour up in the ramp', () => {
		expect(FRAGMENT_SHADER).toContain('discard');
		expect(FRAGMENT_SHADER).toContain('uRamp');
		expect(FRAGMENT_SHADER).toContain('uColour');
	});
	it('never rely on NaN arithmetic on the GPU', () => {
		expect(VERTEX_SHADER + FRAGMENT_SHADER).not.toMatch(/isnan|isinf/);
	});
});

describe('prepareScan', () => {
	it('gathers the layout, the range and the starting exaggeration for the scene', () => {
		const meta = parseMeta({ width: 3, height: 2, pixel_pitch_x_um: 100, pixel_pitch_y_um: 100, z_min_um: 0, z_max_um: 4 });
		const p = prepareScan(meta, new Float32Array([0, 1, 2, 3, NaN, 4]));
		expect(p.range).toEqual({ min: 0, max: 4 });
		expect(p.stats).toMatchObject({ valid: 5, missing: 1 });
		expect(p.texture.data).toHaveLength(12);
		expect(p.layout.sizeX).toBe(1);
		expect(p.initialExaggeration).toBeGreaterThanOrEqual(1);
	});
});
