// Run: node --experimental-strip-types --test core/extensions/d1-geometry-preview/test/geometry.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeometry, FORM_FIELDS, isRoundBar, isUprightCylinder } from '../src/geometry.ts';

const DIMS = [
	{ diameter_mm: 30, length_mm: 100, width_mm: 15, thickness_mm: 10, gauge_length_mm: 50, gauge_width_mm: 12.5 },
	{ diameter_mm: 100, length_mm: 5, width_mm: 100, thickness_mm: 0.5, gauge_length_mm: 1, gauge_width_mm: 1 },   // flat / fat
	{ diameter_mm: 0.5, length_mm: 1234.5, width_mm: 1, thickness_mm: 1000, gauge_length_mm: 900, gauge_width_mm: 30 }, // long / thin
	{ diameter_mm: '25', length_mm: '80' } as any,                                                                   // strings + defaults
	{ diameter_mm: 12345.678, length_mm: 98765.4321, width_mm: 54321.1, thickness_mm: 7777.7, gauge_length_mm: 40000, gauge_width_mm: 9999.9 }, // long labels
	{},                                                                                                              // all defaults
];
const FORMS = Object.keys(FORM_FIELDS).filter((f) => f !== 'other');
// Default label size (form preview) and the larger one the printed report asks for.
const SIZES = [8, 11];
const svgs = SIZES.flatMap((px) => FORMS.flatMap((form) => DIMS.map((d) => ({ form, px, svg: buildGeometry({ form, ...d }, px === 8 ? {} : { labelSize: px }) }))));

test('every form × dimension set draws a finite, non-empty SVG', () => {
	for (const { form, svg } of svgs) {
		assert.ok(svg.startsWith('<svg'), `${form}: no svg`);
		assert.doesNotMatch(svg, /NaN|Infinity|undefined/, form);
	}
});

// Same width estimate the engine uses to grow the viewBox: ~0.625 em per glyph.
test('every label box lies inside the viewBox (nothing clipped)', () => {
	for (const { form, px, svg } of svgs) {
		const [x0, y0, w, h] = svg.match(/viewBox="([^"]+)"/)![1].split(' ').map(Number);
		for (const m of svg.matchAll(/<text x="([-\d.]+)" y="([-\d.]+)"[^>]*>([^<]*)</g)) {
			const x = +m[1], y = +m[2], half = (m[3].length * 0.625 * px + 2) / 2, hh = 0.625 * px;
			assert.ok(x - half >= x0 && x + half <= x0 + w && y - hh >= y0 && y + hh <= y0 + h,
				`${form}: label "${m[3]}" at ${x},${y} outside ${x0} ${y0} ${w} ${h}`);
		}
	}
});

test('viewBox keeps the canvas aspect ratio, so the preview height never changes', () => {
	for (const { form, svg } of svgs) {
		const [, , w, h] = svg.match(/viewBox="([^"]+)"/)![1].split(' ').map(Number);
		assert.ok(Math.abs(w / h - 260 / 210) < 0.01, `${form}: viewBox ${w}x${h}`);
	}
});

test('labelSize is applied inline only when it differs from the default', () => {
	const big = buildGeometry({ form: 'cylinder', diameter_mm: 25, length_mm: 50 }, { labelSize: 11 });
	const small = buildGeometry({ form: 'cylinder', diameter_mm: 25, length_mm: 50 });
	assert.match(big, /style="font-size:11px"/);
	assert.doesNotMatch(small, /font-size/);
	// a later default call is unaffected by an earlier sized one
	assert.doesNotMatch(buildGeometry({ form: 'disc', diameter_mm: 30, thickness_mm: 8 }), /font-size/);
});

test('marker references resolve within their own SVG and ids never repeat across SVGs', () => {
	const seen = new Set<string>();
	for (const { form, svg } of svgs) {
		const defined = [...svg.matchAll(/<marker id="([^"]+)"/g)].map((m) => m[1]);
		if (!defined.length) continue; // powder has no markers
		for (const ref of svg.matchAll(/url\(#([^)]+)\)/g)) assert.ok(defined.includes(ref[1]), `${form}: dangling ${ref[1]}`);
		for (const id of defined) { assert.ok(!seen.has(id), `${form}: duplicate marker id ${id}`); seen.add(id); }
	}
});

test('round bar: Ø and length dimensions, both with extension lines', () => {
	const svg = buildGeometry({ form: 'round_bar', diameter_mm: 20, length_mm: 100 });
	assert.match(svg, />Ø20</);
	assert.match(svg, />100</);
	assert.equal((svg.match(/class="gext"/g) || []).length, 4);
});

test('round bar is matched exactly, not by substring', () => {
	assert.ok(isRoundBar('round_bar'));
	for (const g of ['round_plate', 'ground_plate', 'around', 'round']) assert.ok(!isRoundBar(g), g);
	assert.doesNotMatch(buildGeometry({ form: 'round_plate', width_mm: 10, length_mm: 10, thickness_mm: 5 }), /Ø/);
	assert.ok(!isUprightCylinder('round_bar'));
	assert.ok(isUprightCylinder('cylinder') && isUprightCylinder('Cylindrical'.toLowerCase()));
});

test('tensile coupon: back-facing walls are culled (top + 6 visible walls); all three dims have extension lines', () => {
	const svg = buildGeometry({ form: 'tensile_coupon', length_mm: 200, width_mm: 20, thickness_mm: 3, gauge_length_mm: 50, gauge_width_mm: 12.5 });
	assert.equal((svg.match(/<polygon/g) || []).length, 7);
	assert.equal((svg.match(/class="gext"/g) || []).length, 6);
});

test('bend bar draws two supports and a red load arrow', () => {
	const svg = buildGeometry({ form: 'bend_bar', length_mm: 100, width_mm: 15, thickness_mm: 10 });
	assert.equal((svg.match(/class="gsupport"/g) || []).length, 2);
	assert.match(svg, /class="gload"/);
});
