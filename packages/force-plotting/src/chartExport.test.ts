import { describe, expect, it } from 'vitest';
import { buildChartSvg, decimateTrace, escapeXml, yAxisTitle } from './chartExport';

describe('yAxisTitle', () => {
	it('names the quantity and the unit, with no made-up fallback', () => {
		expect(yAxisTitle('env', 'N')).toBe('Force (N)');
		expect(yAxisTitle('env', 'rpm')).toBe('Speed (rpm)');
		expect(yAxisTitle('env', 'σ')).toBe('Residual (σ)');
		expect(yAxisTitle('line', 'N', true)).toBe('Amplitude (log scale) (N rms)');
		expect(yAxisTitle('line', 'N')).toBe('Amplitude (N rms)');
		expect(yAxisTitle('env', 'N')).toBe('Force (N)'); // an envelope is a force, not an rms amplitude
		expect(yAxisTitle('line', '')).toBe('');
	});
});

const env = (n: number) => {
	const t = Array.from({ length: n }, (_, i) => i * 0.1);
	return { t, min: t.map((_, i) => -5 - (i % 7)), max: t.map((_, i) => 5 + (i % 11)) };
};

describe('buildChartSvg', () => {
	it('carries the title, axis titles with units and the viewBox size', () => {
		const svg = buildChartSvg({ opLabel: 'AB-12 / pass 3', title: 'Fx · force', kind: 'env', data: env(50), xUnit: 's', yUnit: 'N', width: 800, height: 400 });
		expect(svg).toContain('viewBox="0 0 800 400"');
		expect(svg).toContain('AB-12 / pass 3 · Fx · force');
		expect(svg).toContain('Time (s)');
		expect(svg).toContain('Force (N)');
		expect(svg).toContain('fill="#fff"');
	});
	it('titles a spectrum with its units', () => {
		const f = Array.from({ length: 40 }, (_, i) => i + 1);
		const svg = buildChartSvg({ title: 'Fz · spectrum', kind: 'line', data: { f, amp: f.map((v) => 100 / v) }, xUnit: 'Hz', yUnit: 'N', logY: true });
		expect(svg).toContain('Frequency (Hz)');
		expect(svg).toContain('Amplitude (log scale) (N rms)');
	});
	it('escapes text from labels', () => {
		const svg = buildChartSvg({
			opLabel: 'A<B> & "C"', title: 'Fx', kind: 'env', data: env(10), yUnit: 'N',
			compare: [{ id: 'x', label: "it's <b>", color: '#f00', data: env(10) }],
		});
		expect(svg).toContain('A&lt;B&gt; &amp; &quot;C&quot;');
		expect(svg).toContain('it&apos;s &lt;b&gt;');
		expect(svg).not.toContain('<b>');
		expect(escapeXml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&apos;');
	});
	it('draws the compare legend and the crop band', () => {
		const svg = buildChartSvg({
			opLabel: 'Pass 1', title: 'Fy · force', kind: 'env', data: env(60), cropStart: 1, cropEnd: 4,
			compare: [{ id: 'a', label: 'Pass 2', color: '#f59e0b', data: env(60) }],
		});
		expect(svg).toContain('Pass 2');
		expect(svg).toContain('stroke="#f59e0b"');
		expect(svg).toContain('stroke-dasharray="5 3"');
	});
	it('renders a no-data figure for an empty series', () => {
		const svg = buildChartSvg({ title: 'Fx · force', kind: 'env', data: null });
		expect(svg).toContain('no data');
		expect(svg.endsWith('</svg>')).toBe(true);
	});
	it('decimates long traces to the point budget', () => {
		const d = env(100000);
		const tr = decimateTrace(d.t, d.min, d.max, d.t[0], d.t[d.t.length - 1], 500);
		expect(tr.x.length).toBeLessThanOrEqual(500);
		expect(Math.max(...tr.hi)).toBe(Math.max(...d.max));
		expect(Math.min(...tr.lo)).toBe(Math.min(...d.min));
		const svg = buildChartSvg({ title: 'Fx', kind: 'env', data: d, maxPoints: 500 });
		expect(svg.length).toBeLessThan(40000);
	});
});

/** The tick label <text> elements (axis titles and the main title are bigger / italic / bold). */
const tickTexts = (svg: string) => [...svg.matchAll(/<text [^>]*?stroke="none">([^<]*)<\/text>/g)].map((m) => m[1]);

describe('exported tick labels', () => {
	const mk = (t0: number, t1: number, lo: number, hi: number, n = 200) => {
		const t = Array.from({ length: n }, (_, i) => t0 + ((t1 - t0) * i) / (n - 1));
		return { t, min: t.map((_, i) => lo + ((hi - lo) * i) / (n - 1)), max: t.map((_, i) => lo + ((hi - lo) * i) / (n - 1)) };
	};
	it('a 12.30-12.45 s window has distinct time labels', () => {
		const svg = buildChartSvg({ title: 'Fx', kind: 'env', data: mk(10, 20, -5, 5), viewStart: 12.3, viewEnd: 12.45, xUnit: 's', yUnit: 'N' });
		const xs = tickTexts(svg).filter((s) => /^12\./.test(s));
		expect(xs.length).toBeGreaterThan(2);
		expect(new Set(xs).size).toBe(xs.length);
	});
	it('a 1195-1205 rpm y range has distinct labels', () => {
		const svg = buildChartSvg({ title: 'Spindle', kind: 'env', data: mk(0, 10, 1195, 1205), xUnit: 's', yUnit: 'rpm' });
		const ys = tickTexts(svg).filter((s) => /^1\d{3}$/.test(s));
		expect(ys.length).toBeGreaterThan(2);
		expect(new Set(ys).size).toBe(ys.length);
	});
	it('a large range keeps the compact labels', () => {
		const svg = buildChartSvg({ title: 'Spindle', kind: 'env', data: mk(0, 10, 0, 5000), xUnit: 's', yUnit: 'rpm' });
		expect(tickTexts(svg)).toEqual(expect.arrayContaining(['1.0k', '2.0k', '5.0k']));
	});
});

describe('chart layout', () => {
	const W = 900;
	const textNodes = (svg: string) => [...svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)].map((m) => ({ attrs: m[1], text: m[2] }));
	const legendEntries = (svg: string) => textNodes(svg).filter((t) => t.attrs.includes('font-size="13"') && t.attrs.includes('fill="#000"') && !t.attrs.includes('stroke="none"'));
	const xOf = (attrs: string) => Number(/x="([\d.]+)"/.exec(attrs)![1]);
	const yOf = (attrs: string) => Number(/ y="([\d.]+)"/.exec(attrs)![1]);
	const series = (n: number, lo: number, hi: number) => {
		const t = Array.from({ length: n }, (_, i) => i * 0.1);
		return { t, min: t.map((_, i) => lo + ((hi - lo) * i) / (n - 1)), max: t.map((_, i) => lo + ((hi - lo) * i) / (n - 1)) };
	};
	const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, label: `Operation number ${i + 1} (pass)`, color: '#f59e0b', data: series(30, 0, 5) }));

	it('wraps a long legend onto more rows and keeps every entry inside the figure', () => {
		const svg = buildChartSvg({ opLabel: 'AB-12 / pass 3', title: 'Fx · force', kind: 'env', data: series(30, 0, 5), yUnit: 'N', compare: many(6), width: W });
		const ents = legendEntries(svg);
		expect(ents).toHaveLength(7);
		expect(new Set(ents.map((e) => yOf(e.attrs))).size).toBeGreaterThan(1);
		for (const e of ents) expect(xOf(e.attrs) + 30 + e.text.length * 6).toBeLessThan(W);
		const H = 420;
		expect(Math.max(...ents.map((e) => yOf(e.attrs)))).toBeLessThan(H);
		// the plot frame ends above the first legend row
		const frame = /<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="([\d.]+)" fill="none" stroke="#000" stroke-width="1.2"\/>/.exec(svg)!;
		const frameY = Number(/<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="[\d.]+" fill="none" stroke="#000" stroke-width="1.2"/.exec(svg)![1]);
		expect(frameY + Number(frame[1]) + 44).toBeLessThan(Math.min(...ents.map((e) => yOf(e.attrs))));
	});
	it('clips one very long legend label', () => {
		const long = 'x'.repeat(300);
		const svg = buildChartSvg({ opLabel: long, title: 'Fx', kind: 'env', data: series(30, 0, 5), yUnit: 'N', compare: many(1), width: W });
		const ents = legendEntries(svg);
		expect(ents[0].text.length).toBeLessThan(120);
		expect(ents[0].text.endsWith('…')).toBe(true);
		expect(xOf(ents[0].attrs) + 30 + ents[0].text.length * 6).toBeLessThan(W);
	});
	it('a one-row legend stays on one row', () => {
		const svg = buildChartSvg({ opLabel: 'Pass 1', title: 'Fx', kind: 'env', data: series(30, 0, 5), yUnit: 'N', compare: many(1), width: W });
		expect(new Set(legendEntries(svg).map((e) => yOf(e.attrs))).size).toBe(1);
	});

	it('the rotated y title clears the widest tick label, however long', () => {
		const rightEdgeOfTitle = (svg: string) => Number(/translate\((\d+) /.exec(svg)![1]) + 6;
		const leftEdgeOfLabels = (svg: string) => {
			const labels = textNodes(svg).filter((t) => t.attrs.includes('text-anchor="end"') && t.attrs.includes('stroke="none"'));
			const x = xOf(labels[0].attrs);
			return x - Math.max(...labels.map((l) => l.text.length)) * 6.5; // real glyphs are narrower than the 7 px estimate
		};
		const wide = buildChartSvg({ title: 'Spindle', kind: 'env', data: series(30, 1195000.5, 1195010.5), yUnit: 'rpm', width: W });
		const narrow = buildChartSvg({ title: 'Fx', kind: 'env', data: series(30, -5, 5), yUnit: 'N', width: W });
		expect(leftEdgeOfLabels(wide)).toBeGreaterThan(rightEdgeOfTitle(wide));
		expect(leftEdgeOfLabels(narrow)).toBeGreaterThan(rightEdgeOfTitle(narrow));
		// short labels keep the original 78 px margin
		expect(narrow).toContain('<rect x="78"');
	});
});
