// The code template of a new sample (`{seq}-{alloy}-{method}-{Y}-{M}-{D}`): the database replaces the leading
// `{seq}` with the next number on insert. Shared by the Register a sample page and the process map's edit mode, so
// both write the same code (plan "Shared contract"). Pure.

export interface SampleCodeParts {
	/** The material's alloy code ("Ti64"). */
	alloyCode: string | null | undefined;
	/** The method's code ("MF"). */
	methodCode: string | null | undefined;
	/** The manufactured date: an ISO date or timestamp, a Date or a number; today when empty. */
	date?: string | number | Date | null;
}

/** The leading `{seq}` the database numbers. */
export const SEQ_PLACEHOLDER = '{seq}';

/** `{seq}-Ti64-MF-2026-10-14` (no zero padding), or '' while the alloy or the method code is not known. */
export function sampleCodeTemplate({ alloyCode, methodCode, date }: SampleCodeParts, num: string = SEQ_PLACEHOLDER): string {
	if (!alloyCode || !methodCode) return '';
	const d = new Date(date || Date.now());
	return `${num}-${alloyCode}-${methodCode}-${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
