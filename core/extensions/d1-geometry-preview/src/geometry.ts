// Parametric isometric geometry engine for the sample creator.
//
// Draws a scaled 3-D (isometric, z-up) view of a specimen from its real dimensions,
// with dimension markers like a technical drawing. The shape stretches with the
// measurements (a long thin plate looks long and thin), and standard test coupons
// (ASTM E8 tensile, bend bar) start from standard dimensions that stay editable.

export interface Dims {
	form: string | null;
	diameter_mm?: number | null;
	length_mm?: number | null;
	width_mm?: number | null;
	thickness_mm?: number | null;
	gauge_length_mm?: number | null;
	gauge_width_mm?: number | null;
}

// Standard presets. Tensile = ASTM E8/E8M sheet-type (12.5 mm wide reduced section,
// 50 mm gauge, 200 mm long, 20 mm grip). Bend/fatigue = a plain rectangular bar.
export const PRESETS: Record<string, Partial<Dims>> = {
	tensile_coupon: { length_mm: 200, width_mm: 20, thickness_mm: 3, gauge_length_mm: 50, gauge_width_mm: 12.5 },
	bend_bar: { length_mm: 100, width_mm: 15, thickness_mm: 10 },
};

// Which dimension inputs are relevant per form.
export const FORM_FIELDS: Record<string, string[]> = {
	disc: ['diameter_mm', 'thickness_mm'],
	cylinder: ['diameter_mm', 'length_mm'],
	bar: ['width_mm', 'thickness_mm', 'length_mm'],
	round_bar: ['diameter_mm', 'length_mm'],
	block: ['width_mm', 'length_mm', 'thickness_mm'],
	plate: ['width_mm', 'length_mm', 'thickness_mm'],
	tensile_coupon: ['length_mm', 'width_mm', 'thickness_mm', 'gauge_length_mm', 'gauge_width_mm'],
	bend_bar: ['length_mm', 'width_mm', 'thickness_mm'],
	powder: [],
	other: [],
};

const LABELS: Record<string, string> = {
	diameter_mm: 'Ø Diameter (mm)', length_mm: 'Length (mm)', width_mm: 'Width (mm)',
	thickness_mm: 'Thickness (mm)', gauge_length_mm: 'Gauge length (mm)', gauge_width_mm: 'Gauge width (mm)',
};
export const fieldLabel = (k: string) => LABELS[k] || k;

export const FORMS = [
	{ text: 'Disc', value: 'disc' },
	{ text: 'Cylinder', value: 'cylinder' },
	{ text: 'Block', value: 'block' },
	{ text: 'Plate', value: 'plate' },
	{ text: 'Bar', value: 'bar' },
	{ text: 'Round bar', value: 'round_bar' },
	{ text: 'Tensile coupon (ASTM E8)', value: 'tensile_coupon' },
	{ text: 'Bend / fatigue bar', value: 'bend_bar' },
	{ text: 'Powder / compact', value: 'powder' },
	{ text: 'Other', value: 'other' },
];

// ── isometric projection (z up) ────────────────────────────────────────────────
const A = Math.PI / 6, CA = Math.cos(A), SA = Math.sin(A), R2 = Math.SQRT2;
type P3 = [number, number, number];
type P2 = [number, number];
const iso = (x: number, y: number, z: number): P2 => [(x - y) * CA, (x + y) * SA - z];

interface Face { pts: P3[]; cls: string }
// `ext` = the two points on the object the dimension measures; extension lines run from them to a/b.
interface Dim { a: P3; b: P3; label: string; ext?: [P3, P3] }
interface Pad { l?: number; r?: number; t?: number; b?: number }
interface Circle { cx: number; cy: number; cz: number; r: number }

const VW = 260, VH = 210, PAD = 24;

// Dimension-label font size in viewBox units. The default suits the ~240px-wide form preview;
// a caller that shrinks the drawing (the printed report) passes a larger `labelSize` so the
// labels stay legible. Read synchronously by the draw helpers, set per buildGeometry call.
const DEFAULT_LABEL = 8;
let labelPx = DEFAULT_LABEL;
const lk = () => labelPx / DEFAULT_LABEL; // scale for label offsets and boxes


// `pad` reserves extra screen-space room (viewBox units) for annotations drawn after fitting.
function fitter(faces: Face[], dims: Dim[], circles: Circle[], pad: Pad = {}) {
	const pts: P2[] = [];
	faces.forEach((f) => f.pts.forEach((p) => pts.push(iso(...p))));
	dims.forEach((d) => { pts.push(iso(...d.a), iso(...d.b)); });
	circles.forEach((c) => { for (let t = 0; t < 24; t++) { const th = (t / 24) * 2 * Math.PI; pts.push(iso(c.cx + c.r * Math.cos(th), c.cy + c.r * Math.sin(th), c.cz)); } });
	const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
	const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
	const aw = VW - 2 * PAD - (pad.l || 0) - (pad.r || 0), ah = VH - 2 * PAD - (pad.t || 0) - (pad.b || 0);
	const s = Math.min(aw / ((maxX - minX) || 1), ah / ((maxY - minY) || 1));
	const ox = PAD + (pad.l || 0) - minX * s + (aw - (maxX - minX) * s) / 2;
	const oy = PAD + (pad.t || 0) - minY * s + (ah - (maxY - minY) * s) / 2;
	const to = (p: P3): P2 => { const q = iso(...p); return [q[0] * s + ox, q[1] * s + oy]; };
	return { to, s };
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

// Marker ids must be unique per SVG: several previews can share a page, and url(#id) resolves
// to the first match in the document (which fails if that SVG sits in a hidden container).
const uid = Math.random().toString(36).slice(2, 7);
let svgSeq = 0;

// `extra` = screen-space points (label boxes, arrow tips) the fitter did not reserve room for;
// the viewBox grows to include them so nothing is clipped and nothing spills outside the svg.
function svgWrap(inner: string, extra: P2[] = []) {
	let x0 = 0, y0 = 0, x1 = VW, y1 = VH;
	for (const [x, y] of extra) { x0 = Math.min(x0, x - 2); y0 = Math.min(y0, y - 2); x1 = Math.max(x1, x + 2); y1 = Math.max(y1, y + 2); }
	// Keep the viewBox at the canvas aspect ratio so the rendered height never changes as the
	// content grows (the form below would otherwise reflow while typing); extra room just
	// scales the drawing down a little.
	const aspect = VW / VH;
	let w = x1 - x0, h = y1 - y0;
	if (w / h > aspect) { const nh = w / aspect; y0 -= (nh - h) / 2; h = nh; } else { const nw = h * aspect; x0 -= (nw - w) / 2; w = nw; }
	const id = `${uid}${++svgSeq}`;
	// auto-start-reverse makes the start arrowhead point outward, like the end one.
	return `<svg viewBox="${x0.toFixed(1)} ${y0.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}" xmlns="http://www.w3.org/2000/svg">`
		+ `<defs><marker id="ga-${id}" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto-start-reverse">`
		+ `<path d="M0.5,0.5 L6,3 L0.5,5.5" fill="none" stroke="#475569" stroke-width="1"/></marker>`
		+ `<marker id="gar-${id}" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">`
		+ `<path d="M0,0 L6,3 L0,6 Z" fill="#b91c1c"/></marker></defs>`
		+ inner.replace(/url\(#(gar?)\)/g, (_m, n) => `url(#${n}-${id})`) + `</svg>`;
}

const f1 = (v: number) => v.toFixed(1);

// Rough bounding box of a dimension label (bold, ~0.625 em per glyph) for viewBox growth.
function labelBox(x: number, y: number, text: string, sink?: P2[]) {
	const w = text.length * 0.625 * labelPx + 2, hh = 0.625 * labelPx;
	sink?.push([x - w / 2, y - hh], [x + w / 2, y + hh]);
}

// A dimension label; the size is only inlined when it differs from the stylesheet default.
const dimText = (x: number, y: number, text: string, extra = '') =>
	`<text x="${f1(x)}" y="${f1(y)}" class="gdimt"${extra}${labelPx === DEFAULT_LABEL ? '' : ` style="font-size:${labelPx}px"`}>${text}</text>`;

// Extension line from a point on the object towards its dimension line (small gap at the
// object, small overshoot past the dimension line).
function extLine(p0: P2, p1: P2): string {
	const dx = p1[0] - p0[0], dy = p1[1] - p0[1], len = Math.hypot(dx, dy);
	if (len < 1) return '';
	const ux = dx / len, uy = dy / len;
	return `<line x1="${f1(p0[0] + ux * 2)}" y1="${f1(p0[1] + uy * 2)}" x2="${f1(p1[0] + ux * 2.5)}" y2="${f1(p1[1] + uy * 2.5)}" class="gext"/>`;
}

// Dimension line with arrowheads. When it is too short to hold two arrowheads, the heads
// go outside pointing in (classic drafting style) instead of overlapping.
function dimLine(a: P2, b: P2): string {
	const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
	const seg = (p: P2, q: P2, m = '') => `<line x1="${f1(p[0])}" y1="${f1(p[1])}" x2="${f1(q[0])}" y2="${f1(q[1])}" class="gdim"${m}/>`;
	if (len >= 16) return seg(a, b, ' marker-start="url(#ga)" marker-end="url(#ga)"');
	const ux = dx / (len || 1), uy = dy / (len || 1), tail = 9;
	return seg(a, b)
		+ seg([a[0] - ux * tail, a[1] - uy * tail], a, ' marker-end="url(#ga)"')
		+ seg([b[0] + ux * tail, b[1] + uy * tail], b, ' marker-end="url(#ga)"');
}

function drawDims(dims: Dim[], to: (p: P3) => P2, sink?: P2[]): string {
	const cx = VW / 2, cy = VH / 2;
	return dims.map((d) => {
		const a = to(d.a), b = to(d.b);
		const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
		// Offset the label along the line's normal, away from the drawing centre, so it
		// sits beside the dimension line rather than on top of it.
		let nx = -(b[1] - a[1]), ny = b[0] - a[0];
		const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
		if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
		const lx = mx + nx * 11 * lk(), ly = my + ny * 11 * lk();
		const ext = d.ext ? extLine(to(d.ext[0]), a) + extLine(to(d.ext[1]), b) : '';
		labelBox(lx, ly, d.label, sink);
		return ext + dimLine(a, b)
			+ dimText(lx, ly, d.label, ' dominant-baseline="middle"');
	}).join('');
}

function faceSvg(f: Face, to: (p: P3) => P2): string {
	return `<polygon points="${f.pts.map(to).map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}" class="${f.cls}"/>`;
}

// Box W(x) × L(y) × H(z) with the three viewer-facing faces (top, y=L, x=W — they
// meet at the near vertical edge) + W/L/H dimension markers along the visible edges.
function boxFacesDims(W: number, L: number, H: number, off: number) {
	const faces: Face[] = [
		{ cls: 'gt', pts: [[0, 0, H], [W, 0, H], [W, L, H], [0, L, H]] }, // top
		{ cls: 'gl', pts: [[0, L, 0], [W, L, 0], [W, L, H], [0, L, H]] }, // front-left (y=L)
		{ cls: 'gr', pts: [[W, 0, 0], [W, L, 0], [W, L, H], [W, 0, H]] }, // front-right (x=W)
	];
	// Three dimension lines fan out from three different directions so none of them share an
	// endpoint: width off the end face (+y), length off the long side (+x), height off the
	// left vertical edge (-x).
	const dims: Dim[] = [
		{ a: [0, L + off, 0], b: [W, L + off, 0], label: `${fmt(W)}`, ext: [[0, L, 0], [W, L, 0]] },
		{ a: [W + off, 0, 0], b: [W + off, L, 0], label: `${fmt(L)}`, ext: [[W, 0, 0], [W, L, 0]] },
		{ a: [-off, L, 0], b: [-off, L, H], label: `${fmt(H)}`, ext: [[0, L, 0], [0, L, H]] },
	];
	return { faces, dims };
}

function boxSvg(W: number, L: number, H: number): string {
	const off = 0.16 * Math.max(W, L, H);
	const { faces, dims } = boxFacesDims(W, L, H, off);
	const { to } = fitter(faces, dims, []);
	const sink: P2[] = [];
	return svgWrap(faces.map((f) => faceSvg(f, to)).join('') + drawDims(dims, to, sink), sink);
}

// Round solid (cylinder / disc): diameter D, height H along z.
function cylSvg(D: number, H: number): string {
	const Rr = D / 2;
	const circles: Circle[] = [{ cx: Rr, cy: Rr, cz: 0, r: Rr }, { cx: Rr, cy: Rr, cz: H, r: Rr }];
	// Both markers are drawn in screen space against the silhouette, so reserve room for them.
	const sink: P2[] = [];
	const { to, s } = fitter([], [], circles, { l: 26 * lk(), t: 22 * lk() });
	const topC = to([Rr, Rr, H]), botC = to([Rr, Rr, 0]);
	const rx = Rr * CA * R2 * s, ry = Rr * SA * R2 * s;
	const left = topC[0] - rx, right = topC[0] + rx;
	const body = `<path d="M${f1(left)} ${f1(topC[1])} L${f1(left)} ${f1(botC[1])} `
		+ `A${f1(rx)} ${f1(ry)} 0 0 0 ${f1(right)} ${f1(botC[1])} `
		+ `L${f1(right)} ${f1(topC[1])} Z" class="gl"/>`;
	const top = `<ellipse cx="${f1(topC[0])}" cy="${f1(topC[1])}" rx="${f1(rx)}" ry="${f1(ry)}" class="gt"/>`;
	// Diameter: across the top, above the ellipse, with vertical extension lines off its extremes.
	const dy = topC[1] - ry - 10 * lk();
	const dimD = extLine([left, topC[1]], [left, dy]) + extLine([right, topC[1]], [right, dy])
		+ dimLine([left, dy], [right, dy])
		+ dimText(topC[0], dy - 4 * lk(), `Ø${fmt(D)}`);
	labelBox(topC[0], dy - 4 * lk(), `Ø${fmt(D)}`, sink);
	// Height: beside the left wall, between the top and bottom ellipse centre-lines.
	const hx = left - 12 * lk();
	const dimH = extLine([left, topC[1]], [hx, topC[1]]) + extLine([left, botC[1]], [hx, botC[1]])
		+ dimLine([hx, topC[1]], [hx, botC[1]])
		+ dimText(hx - 8 * lk(), (topC[1] + botC[1]) / 2, fmt(H), ' dominant-baseline="middle"');
	labelBox(hx - 8 * lk(), (topC[1] + botC[1]) / 2, fmt(H), sink);
	return svgWrap(body + top + dimD + dimH, sink);
}

// Round bar: a cylinder lying along the length (y) axis. The near end cap (y = L) is an
// ellipse in the x-z plane; the body is the convex hull of both end caps, which is the
// silhouette a cylinder has in any projection.
function roundBarSvg(D: number, L: number): string {
	const R = D / 2, N = 96;
	const cap = (y: number): P3[] => Array.from({ length: N }, (_, i) => {
		const th = (i / N) * 2 * Math.PI;
		return [R + R * Math.cos(th), y, R + R * Math.sin(th)] as P3;
	});
	const near = cap(L), far = cap(0);
	// Tangent point of the lower-right silhouette (the side facing the length dimension).
	const tx = R * (1 + Math.SQRT1_2), tz = R * (1 - Math.SQRT1_2);
	const off = 0.16 * Math.max(D, L);
	const dims: Dim[] = [
		{ a: [0, L + off, R], b: [D, L + off, R], label: `Ø${fmt(D)}`, ext: [[0, L, R], [D, L, R]] },
		{ a: [tx + off, 0, tz], b: [tx + off, L, tz], label: `${fmt(L)}`, ext: [[tx, 0, tz], [tx, L, tz]] },
	];
	const { to } = fitter([{ cls: 'gl', pts: [...near, ...far] }], dims, []);
	const hull = convexHull([...near, ...far].map(to));
	const path = (pts: P2[]) => `M${pts.map((p) => `${f1(p[0])},${f1(p[1])}`).join(' L')} Z`;
	const sink: P2[] = [];
	return svgWrap(`<path d="${path(hull)}" class="gr"/><path d="${path(near.map(to))}" class="gl"/>` + drawDims(dims, to, sink), sink);
}

// Andrew's monotone chain.
function convexHull(pts: P2[]): P2[] {
	const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const half = (seq: P2[]) => {
		const h: P2[] = [];
		for (const q of seq) {
			while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop();
			h.push(q);
		}
		h.pop();
		return h;
	};
	return [...half(p), ...half([...p].reverse())];
}

// Flat tensile dogbone: overall L(y) × grip W(x) × thickness T(z), reduced to gauge
// width Wg over gauge length Lg with straight fillet tapers. Extruded for thickness.
function couponSvg(L: number, W: number, T: number, Lg: number, Wg: number): string {
	const cx = W / 2, gh = Wg / 2, wh = W / 2;
	const y1 = (L - Lg) / 2, y2 = (L + Lg) / 2;             // reduced-section span
	const fil = Math.min((L - Lg) / 2 * 0.6, W);            // taper length
	// right-hand outline, bottom→top (x offset from centre, y along length)
	const right: P2[] = [
		[cx + wh, 0], [cx + wh, y1 - fil], [cx + gh, y1], [cx + gh, y2], [cx + wh, y2 + fil], [cx + wh, L],
	];
	// counter-clockwise in plan view (x right, y up), so an edge (dx,dy) has outward normal (dy,-dx)
	const outline: P2[] = [...right, ...right.map((p) => [W - p[0], p[1]] as P2).reverse()];
	const off = 0.14 * L, lift = 0.09 * L;
	// All dimensions sit in the top plane (z = T) so they hang off visible edges.
	const dims: Dim[] = [
		{ a: [-off, 0, T], b: [-off, L, T], label: `${fmt(L)}`, ext: [[0, 0, T], [0, L, T]] },                        // overall length
		{ a: [cx - gh, L / 2, T + lift], b: [cx + gh, L / 2, T + lift], label: `${fmt(Wg)}`, ext: [[cx - gh, L / 2, T], [cx + gh, L / 2, T]] }, // gauge width, lifted clear of the face
		{ a: [W + off, y1, T], b: [W + off, y2, T], label: `G ${fmt(Lg)}`, ext: [[cx + gh, y1, T], [cx + gh, y2, T]] }, // gauge length
	];
	const top: Face = { cls: 'gt', pts: outline.map((p) => [p[0], p[1], T]) };
	// Extruded walls: drop the back-facing ones (the camera looks from +x,+y) and paint the
	// rest far-to-near, shading x-facing walls darker than y-facing ones like the box faces.
	const walls: Face[] = [];
	for (let i = 0; i < outline.length; i++) {
		const p = outline[i], q = outline[(i + 1) % outline.length];
		const nx = q[1] - p[1], ny = -(q[0] - p[0]);
		if (nx + ny <= 1e-9) continue;
		walls.push({ cls: Math.abs(nx) >= Math.abs(ny) ? 'gr' : 'gl', pts: [[p[0], p[1], 0], [q[0], q[1], 0], [q[0], q[1], T], [p[0], p[1], T]] });
	}
	const depth = (f: Face) => (f.pts[0][0] + f.pts[0][1] + f.pts[1][0] + f.pts[1][1]) / 2;
	walls.sort((a, b) => depth(a) - depth(b));
	const { to } = fitter([top, ...walls], dims, []);
	const sink: P2[] = [];
	return svgWrap(walls.map((w) => faceSvg(w, to)).join('') + faceSvg(top, to) + drawDims(dims, to, sink), sink);
}

// Bend / fatigue bar: a long box with two supports and a central load arrow (3-pt).
function bendSvg(L: number, W: number, H: number): string {
	const off = 0.16 * Math.max(L, W, H);
	const { faces, dims } = boxFacesDims(W, L, H, off);
	const { to } = fitter(faces, dims, []);
	const sink: P2[] = [];
	let markers = '';
	// supports under the visible long side's bottom edge at 1/6 and 5/6 of the length
	for (const fy of [1 / 6, 5 / 6]) {
		const b = to([W, fy * L, 0]);
		markers += `<path d="M${f1(b[0])} ${f1(b[1] + 1)} L${f1(b[0] - 5)} ${f1(b[1] + 10)} L${f1(b[0] + 5)} ${f1(b[1] + 10)} Z" class="gsupport"/>`;
	}
	// central downward load arrow onto the top face
	const c = to([W / 2, L / 2, H]);
	markers += `<line x1="${f1(c[0])}" y1="${f1(c[1] - 22)}" x2="${f1(c[0])}" y2="${f1(c[1] - 2)}" class="gload" marker-end="url(#gar)"/>`;
	sink.push([c[0], c[1] - 24]);
	return svgWrap(faces.map((f) => faceSvg(f, to)).join('') + drawDims(dims, to, sink) + markers, sink);
}

function powderSvg(): string {
	const dots = ['33,62', '45,64', '57,63', '69,64', '39,56', '51,54', '63,57', '50,48']
		.map((p) => { const [x, y] = p.split(','); return `<circle cx="${x}" cy="${y}" r="2.4" class="gh"/>`; }).join('');
	return `<svg viewBox="-7 0 114 92" xmlns="http://www.w3.org/2000/svg">`
		+ `<ellipse cx="50" cy="70" rx="34" ry="13" class="gl"/><path d="M18 70 Q50 30 82 70 Z" class="gt"/>${dots}</svg>`;
}

const num = (v: any, def: number): number => {
	const x = typeof v === 'string' ? parseFloat(v) : v;
	return typeof x === 'number' && !Number.isNaN(x) && x > 0 ? x : def;
};

// Shared by the drawing here and the volume estimate in GeometryPreview.vue, so the two never
// disagree about what counts as a cylinder. Legacy free-text forms ('cylindrical', 'rod', …)
// are matched loosely; the newer vocabulary values exactly.
export const isRoundBar = (g: string) => g === 'round_bar';
export const isUprightCylinder = (g: string) => /cylind|rod/.test(g);

export function buildGeometry(d: Dims, opts: { labelSize?: number } = {}): string {
	labelPx = opts.labelSize && opts.labelSize > 0 ? opts.labelSize : DEFAULT_LABEL;
	try { return drawGeometry(d); } finally { labelPx = DEFAULT_LABEL; }
}

function drawGeometry(d: Dims): string {
	const g = (d.form || '').toLowerCase();
	if (!g || g === 'other') return '';
	if (g.includes('powder')) return powderSvg();
	if (g.includes('disc')) return cylSvg(num(d.diameter_mm, 30), num(d.thickness_mm ?? d.length_mm, 8));
	if (isRoundBar(g)) return roundBarSvg(num(d.diameter_mm, 20), num(d.length_mm, 100));
	if (isUprightCylinder(g)) return cylSvg(num(d.diameter_mm, 25), num(d.length_mm, 50));
	if (g.includes('tensile') || g.includes('coupon')) {
		const L = num(d.length_mm, 200), W = num(d.width_mm, 20), T = num(d.thickness_mm, 3);
		const Lg = Math.min(num(d.gauge_length_mm, 50), L * 0.9);
		const Wg = Math.min(num(d.gauge_width_mm, 12.5), W * 0.95);
		return couponSvg(L, W, T, Lg, Wg);
	}
	if (g.includes('bend')) return bendSvg(num(d.length_mm, 100), num(d.width_mm, 15), num(d.thickness_mm, 10));
	// block / plate / bar → box
	return boxSvg(num(d.width_mm, 24), num(d.length_mm, 40), num(d.thickness_mm, g.includes('plate') ? 5 : 20));
}

export function dimsText(d: Dims): string {
	const g = (d.form || '').toLowerCase();
	const keys = FORM_FIELDS[g] || [];
	const short: Record<string, string> = { diameter_mm: 'Ø', length_mm: 'L', width_mm: 'W', thickness_mm: 't', gauge_length_mm: 'G', gauge_width_mm: 'Wg' };
	const parts = keys.filter((k) => (d as any)[k]).map((k) => `${short[k]}${(d as any)[k]}`);
	return parts.length ? parts.join(' · ') + ' mm' : '';
}
