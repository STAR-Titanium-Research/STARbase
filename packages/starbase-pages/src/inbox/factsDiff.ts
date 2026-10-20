// The facts of two files side by side, for Compare: kV, working distance, magnification, spot, detector, mode, pixel size, when it was taken, and the file's
// size. Each row has the two values as they are shown (the same words as the imaging settings list) and whether they differ. A value one file has and the
// other does not counts as different; a row neither file has a value for is left out.
import type { FoundFile } from './inboxApi';
import { sizeText } from './inboxModel';
import { extractedView, settingRows } from './semSettings';

export interface DiffRow {
	key: string;
	label: string;
	/** What file A shows, or null when it has no value. */
	a: string | null;
	b: string | null;
	differs: boolean;
}

type Facts = Pick<FoundFile, 'extracted' | 'size_bytes'>;

/** The rows, in the order shown. */
const KEYS = ['kv', 'working_distance_mm', 'magnification', 'spot', 'detector', 'mode', 'pixel_size_nm', 'acquired_at', 'size'] as const;

function valuesOf(f: Facts): Map<string, { label: string; text: string | null }> {
	const out = new Map<string, { label: string; text: string | null }>();
	for (const r of settingRows(extractedView(f.extracted))) out.set(r.key, { label: r.label, text: r.text });
	out.set('size', { label: 'size', text: sizeText(f.size_bytes) || null });
	return out;
}

/** The comparison rows for two files. `differs` compares the text as shown (so 15 kV and 15.0 kV are the same). */
export function factsDiff(a: Facts, b: Facts): DiffRow[] {
	const va = valuesOf(a);
	const vb = valuesOf(b);
	const rows: DiffRow[] = [];
	for (const key of KEYS) {
		const x = va.get(key);
		const y = vb.get(key);
		const ta = x?.text ?? null;
		const tb = y?.text ?? null;
		if (ta === null && tb === null) continue;
		rows.push({ key, label: x?.label ?? y?.label ?? key, a: ta, b: tb, differs: ta !== tb });
	}
	return rows;
}
