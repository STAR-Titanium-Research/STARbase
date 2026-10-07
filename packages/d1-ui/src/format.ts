// Small display helpers shared by the pages.

const EN_GB = 'en-GB';

export function formatDate(value: string | null | undefined, fallback = ''): string {
	if (!value) return fallback;
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return fallback;
	return d.toLocaleDateString(EN_GB, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatNumber(value: number | string | null | undefined, unit = '', digits = 3): string {
	if (value === null || value === undefined || value === '') return '';
	const n = Number(value);
	if (!Number.isFinite(n)) return '';
	// toLocaleString rounds, and "20.000" would suggest a precision nobody measured.
	const text = n.toLocaleString(EN_GB, { maximumFractionDigits: digits });
	return unit ? `${text} ${unit}` : text;
}

// Text for a visible error from an Axios/Directus failure.
export function errorText(e: any, fallback = 'Request failed'): string {
	return e?.response?.data?.errors?.[0]?.message || e?.message || fallback;
}

const errCode = (e: any) => e?.response?.data?.errors?.[0]?.extensions?.code;

// The failure predicates of the Directus API. Which one to use:
//   isForbidden  a read of a related list the role may not see (HTTP 403 or the FORBIDDEN code):
//                the section says so, or falls back to a narrower filter. NOT a missing record.
//   isNotVisible the one record a page is about: missing and unreadable look the same on purpose
//                (Directus answers 403 for both, d1-trace 404), so this adds 404.
//   isDuplicate  a unique-constraint violation (the row already exists).
// Network and 5xx errors are none of these; callers must not treat them as "cannot read".
export function isForbidden(e: any): boolean {
	return e?.response?.status === 403 || errCode(e) === 'FORBIDDEN';
}

export function isNotVisible(e: any): boolean {
	const status = e?.response?.status;
	return status === 403 || status === 404;
}

export function isDuplicate(e: any): boolean {
	return errCode(e) === 'RECORD_NOT_UNIQUE';
}

// A measured quantity for display. formatNumber() rounds to a fixed number of decimals, which
// turns a strain rate of 0.000001 into "0"; this keeps the leading digits whatever the size:
// tiny values switch to exponent form, large ones drop the noise decimals, trailing zeros go.
export function formatQuantity(value: number | string | null | undefined): string {
	if (value === null || value === undefined || value === '') return '';
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n)) return '';
	if (n === 0) return '0';
	const abs = Math.abs(n);
	if (abs < 0.001 || abs >= 1e9) return n.toExponential(2).replace(/\.?0+e/, 'e').replace('e+', 'e');
	const digits = abs >= 1000 ? 1 : abs >= 1 ? 3 : 5;
	return n.toLocaleString(EN_GB, { maximumFractionDigits: digits });
}

// A related record read through `fields=rel.field`: an object when the user may read it, the bare
// id (or null) when not. Pages show a link only for the object.
export function asRecord(value: unknown): Record<string, any> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, any>) : null;
}
