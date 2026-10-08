/** Max-pool a spectrum's bins down to `rows` values, so a canvas a few hundred pixels tall does not
 *  pay for the ~1024 bins the backend sends. Each output takes the largest source bin in its group,
 *  so a narrow peak keeps its height (the same rule the backend's wire reduction uses). A source with
 *  `rows` bins or fewer is returned as it is, bin for bin. */
export function maxPoolRows(src: ArrayLike<number>, rows: number): ArrayLike<number> {
	const n = src.length;
	if (rows >= n) return src;
	const out = new Float32Array(rows);
	for (let r = 0; r < rows; r++) {
		const lo = Math.floor((r * n) / rows);
		const hi = Math.max(lo + 1, Math.floor(((r + 1) * n) / rows));
		let m = src[lo];
		for (let i = lo + 1; i < hi; i++) if (src[i] > m) m = src[i];
		out[r] = m;
	}
	return out;
}
