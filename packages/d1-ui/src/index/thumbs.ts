// Which pictures a list can show per row, and what to ask for. Three kinds: the sample's own drawing
// (geometry: drawn from its form and dimensions, the same component the Sample page uses), a photo or
// logo from a file field (image: served by Directus as a small WebP), and the force figure of a
// machining operation (force: needs the second request of the list page; until a row carries it the
// slot shows a placeholder). Pure: no Vue, no network.

type Row = Record<string, unknown>;

export type ThumbKind = 'geometry' | 'image' | 'force' | null;

/** The sample columns the drawing reads (the same ones `sampleDims` does). */
const SAMPLE_DIM_FIELDS = ['diameter_mm', 'length_mm', 'width_mm', 'thickness_mm', 'gauge_length_mm', 'gauge_width_mm'] as const;

/** The file field that holds the picture, per collection (manufacturers' logo is `Logo`, capital L). */
const IMAGE_FIELDS: Record<string, string> = {
	equipment: 'image',
	tools: 'image',
	insert_types: 'image',
	manufacturers: 'Logo',
};

export function thumbKind(collection: string): ThumbKind {
	if (collection === 'physical_samples') return 'geometry';
	if (Object.hasOwn(IMAGE_FIELDS, collection)) return 'image';
	if (collection === 'manufacturing_operations') return 'force';
	return null;
}

/** The file field of an image collection; null for the others. */
export function imageField(collection: string): string | null {
	return Object.hasOwn(IMAGE_FIELDS, collection) ? IMAGE_FIELDS[collection] : null;
}

/** The fields the thumbnail needs on top of the list's columns. */
export function thumbFields(collection: string): string[] {
	if (collection === 'physical_samples') return ['form', ...SAMPLE_DIM_FIELDS];
	const image = imageField(collection);
	return image ? [image] : [];
}

const isPresent = (v: unknown): boolean => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0;

/** True when the sample has a form the engine draws (not empty, not 'other'): a powder always, any other form with at least one dimension. */
export function hasDrawableDims(row: Row | null | undefined): boolean {
	const form = typeof row?.form === 'string' ? row.form.trim().toLowerCase() : '';
	if (!form || form === 'other') return false;
	// The engine draws a powder as a heap whatever the dimensions (or none), exactly as the Sample page does.
	if (form.includes('powder')) return true;
	return SAMPLE_DIM_FIELDS.some((f) => isPresent(row?.[f]));
}

/** The id of a file field's value: a bare id, or an expanded file object. */
export function fileId(value: unknown): string | null {
	if (typeof value === 'string' && value) return value;
	if (typeof value === 'object' && value !== null && typeof (value as Row).id === 'string' && (value as Row).id) return (value as Row).id as string;
	return null;
}

/** A small cropped WebP of a Directus file (the app is same-origin, so the session cookie authenticates the request). */
export function assetThumbUrl(id: string, w = 320, h = 200): string {
	return `/assets/${encodeURIComponent(id)}?width=${w}&height=${h}&fit=cover&format=webp`;
}
