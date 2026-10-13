// Draws a QR module matrix as an inline SVG, so no markup from a QR library (or anyone else) is ever
// inserted into the label document. The shape is what `QRCode.create(payload).modules` returns.

export interface QrModules {
	// modules per side
	size: number;
	// row-major, size * size entries; truthy = dark
	data: ArrayLike<number | boolean>;
}

// Light modules round the code, in modules. The label's padding adds to this.
export const QUIET_MODULES = 2;

// One <path> of horizontal runs of dark modules. Black on the white of the surrounding box. '' when the
// matrix is unusable (the label then simply has no code).
export function qrSvg(m: QrModules): string {
	const n = m?.size;
	if (!Number.isInteger(n) || n < 1 || !m.data || m.data.length < n * n) return '';
	const total = n + 2 * QUIET_MODULES;
	let d = '';
	for (let y = 0; y < n; y++) {
		let x = 0;
		while (x < n) {
			if (!m.data[y * n + x]) {
				x++;
				continue;
			}
			const start = x;
			while (x < n && m.data[y * n + x]) x++;
			const len = x - start;
			d += `M${start + QUIET_MODULES} ${y + QUIET_MODULES}h${len}v1h-${len}z`;
		}
	}
	return `<svg viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet"><path fill="#000" d="${d}"/></svg>`;
}
