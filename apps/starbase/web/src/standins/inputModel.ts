// <v-input>'s value both ways. Directus's v-input gives a number for type="number" and null when the
// box is emptied; any other type stays text.
export const toInputValue = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export function fromInputValue(raw: string, type?: string): string | number | null {
	if (type !== 'number') return raw;
	if (raw.trim() === '') return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
}
