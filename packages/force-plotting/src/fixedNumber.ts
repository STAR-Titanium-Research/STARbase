/** Fixed-decimal text for a numeric field (blank for unset / non-numeric). Display only: the stored value is untouched. */
export function fmtFixed(v: unknown, digits = 2): string {
	if (v === '' || v == null) return '';
	const n = Number(v);
	return Number.isFinite(n) ? n.toFixed(digits) : '';
}
