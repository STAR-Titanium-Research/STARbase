// Client-side "formatted FRM" export. Composites the interactive WebGL view (the spiral
// point cloud for the CURRENT zoom/pan) onto a figure that mirrors the MATLAB FRM PNGs:
// a framed axis with x/y (mm) ticks + grid, a viridis colorbar labelled "<axis> (N)", and
// a title + operation subtitle. Instant and offline — no host round-trip — so "Download this
// FRM image" respects the current viewport without losing the report styling.
import { colorizeValues, type ColorScale } from './colorScale';

// "Nice" round tick positions across [lo, hi] (~`target` of them). Exported for ColorBar.vue's
// tick labels too -- it's the same "nice" rounding either way, no reason for a second copy just
// because the caller draws to a <canvas> here and a DOM strip there.
export function niceTicks(lo: number, hi: number, target = 6): number[] {
	const span = hi - lo;
	if (!(span > 0) || !isFinite(span)) return [lo];
	const raw = span / target;
	const mag = Math.pow(10, Math.floor(Math.log10(raw)));
	const norm = raw / mag;
	const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
	const out: number[] = [];
	for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-6; t += step) out.push(Number(t.toFixed(6)));
	return out;
}
export function fmt(v: number): string {
	const a = Math.abs(v);
	if (a === 0) return '0';
	if (a >= 1000) return (v / 1000).toFixed(1) + 'k';
	if (a < 0.1) return v.toFixed(3);
	if (a < 10) return v.toFixed(1);
	return v.toFixed(0);
}
function download(cv: HTMLCanvasElement, filename: string) {
	cv.toBlob((blob) => {
		if (!blob) return;
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url; a.download = filename;
		document.body.appendChild(a); a.click(); a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}, 'image/png');
}

export interface FrmFigureOpts {
	canvas: HTMLCanvasElement;                                   // the live WebGL view (already drawn)
	bounds: { xmin: number; xmax: number; ymin: number; ymax: number }; // world mm the canvas shows
	// The scale the render used (the colorbar reproduces its steps, log mapping and displayed-range
	// grey); cmin/cmax override its saturation range with what the renderer actually applied.
	colorScale: ColorScale;
	cmin: number; cmax: number; axis: string;
	subtitle?: string;                                         // op code, shown under the title
	filename: string;
}

export function exportFrmFigure(o: FrmFigureOpts): boolean {
	const { canvas, bounds } = o;
	const pw = canvas.width, ph = canvas.height;
	if (!pw || !ph) return false;
	const cmin = o.cmin, cmax = o.cmax > o.cmin ? o.cmax : o.cmin + 1;

	// Scale figure furniture to the plot's device-pixel size so text stays proportionate.
	const k = Math.max(1, ph / 830);
	const mL = 92 * k, mR = 150 * k, mT = 90 * k, mB = 78 * k;
	const W = pw + mL + mR, H = ph + mT + mB;
	const cv = document.createElement('canvas'); cv.width = Math.round(W); cv.height = Math.round(H);
	const g = cv.getContext('2d'); if (!g) return false;
	const serif = (px: number, style = '') => `${style} ${Math.round(px * k)}px "Times New Roman", Georgia, serif`.trim();

	g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
	g.drawImage(canvas, mL, mT, pw, ph);

	const xt = niceTicks(bounds.xmin, bounds.xmax), yt = niceTicks(bounds.ymin, bounds.ymax);
	const xToPx = (t: number) => mL + ((t - bounds.xmin) / (bounds.xmax - bounds.xmin)) * pw;
	const yToPx = (t: number) => mT + ph - ((t - bounds.ymin) / (bounds.ymax - bounds.ymin)) * ph;

	// faint grid over the points (MATLAB draws the grid on top)
	g.strokeStyle = 'rgba(90,90,90,0.28)'; g.lineWidth = 1;
	for (const t of xt) { const x = xToPx(t); g.beginPath(); g.moveTo(x, mT); g.lineTo(x, mT + ph); g.stroke(); }
	for (const t of yt) { const y = yToPx(t); g.beginPath(); g.moveTo(mL, y); g.lineTo(mL + pw, y); g.stroke(); }

	// axis frame + ticks + numbers
	g.strokeStyle = '#000'; g.lineWidth = 1.4 * k; g.strokeRect(mL, mT, pw, ph);
	g.fillStyle = '#000'; g.font = serif(19);
	g.textAlign = 'center'; g.textBaseline = 'top';
	for (const t of xt) { const x = xToPx(t); g.beginPath(); g.moveTo(x, mT + ph); g.lineTo(x, mT + ph + 7 * k); g.stroke(); g.fillText(fmt(t), x, mT + ph + 10 * k); }
	g.textAlign = 'right'; g.textBaseline = 'middle';
	for (const t of yt) { const y = yToPx(t); g.beginPath(); g.moveTo(mL, y); g.lineTo(mL - 7 * k, y); g.stroke(); g.fillText(fmt(t), mL - 10 * k, y); }

	// axis labels
	g.fillStyle = '#000'; g.font = serif(21, 'italic'); g.textAlign = 'center'; g.textBaseline = 'alphabetic';
	g.fillText('x (mm)', mL + pw / 2, H - 22 * k);
	g.save(); g.translate(24 * k, mT + ph / 2); g.rotate(-Math.PI / 2); g.textBaseline = 'alphabetic'; g.fillText('y (mm)', 0, 0); g.restore();

	// colorbar
	const cbx = mL + pw + 30 * k, cbw = 22 * k, cbH = ph;
	// One row per value, coloured exactly as the renderer colours a point of that value.
	const rows = Math.max(1, Math.round(cbH));
	const vals = new Float32Array(rows);
	for (let i = 0; i < rows; i++) vals[i] = cmin + ((i + 0.5) / rows) * (cmax - cmin);
	const rgba = new Uint8Array(rows * 4);
	colorizeValues(vals, rows, { ...o.colorScale, satMin: cmin, satMax: cmax }, rgba);
	for (let i = 0; i < rows; i++) {
		if (!rgba[i * 4 + 3]) continue;   // hidden values leave the bar blank
		g.fillStyle = `rgb(${rgba[i * 4]},${rgba[i * 4 + 1]},${rgba[i * 4 + 2]})`;
		g.fillRect(cbx, mT + cbH - ((i + 1) / rows) * cbH, cbw, cbH / rows + 0.5);
	}
	g.strokeStyle = '#000'; g.lineWidth = 1; g.strokeRect(cbx, mT, cbw, cbH);
	g.fillStyle = '#000'; g.font = serif(17); g.textAlign = 'left'; g.textBaseline = 'middle';
	for (const t of niceTicks(cmin, cmax, 5)) {
		if (t < cmin - 1e-9 || t > cmax + 1e-9) continue;
		const y = mT + cbH - ((t - cmin) / (cmax - cmin)) * cbH;
		g.beginPath(); g.moveTo(cbx + cbw, y); g.lineTo(cbx + cbw + 6 * k, y); g.stroke();
		g.fillText(fmt(t), cbx + cbw + 9 * k, y);
	}
	g.save(); g.translate(cbx + cbw + 60 * k, mT + cbH / 2); g.rotate(-Math.PI / 2);
	g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.font = serif(20, 'italic'); g.fillText(`${o.axis} (N)`, 0, 0); g.restore();

	// title + subtitle
	g.fillStyle = '#000'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = serif(26, 'bold');
	g.fillText(`FRM plot in ${o.axis} direction`, W / 2, 34 * k);
	if (o.subtitle) { g.fillStyle = '#777'; g.font = serif(16); g.fillText(o.subtitle, W / 2, 62 * k); }

	download(cv, o.filename);
	return true;
}
