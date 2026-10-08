// The crop the operator set in the final summary, as kept in a capture's summary.json by
// PUT /captures/{id}/crop (#190): sample indices at the recording rate, both sides or neither.
// Local Captures reads it back so the plots and a retried upload use it instead of auto-detection.
import { cropWindowSec as storedWindowSec, type Cache } from '@d1/force-plotting';

export interface CropSummary {
	fs?: number;
	config?: { sample_rate?: number };
	crop_start_idx_override?: number | null;
	crop_end_idx_override?: number | null;
}

function rate(summary: CropSummary | null | undefined): number {
	const fs = Number(summary?.fs ?? summary?.config?.sample_rate);
	return Number.isFinite(fs) && fs > 0 ? fs : 0;
}

/** The window to display: the stored override, else the cache's own detection. `overridden` is
 *  false when nothing usable is stored (or the rate is unknown). */
export function cropWindowSec(
	summary: CropSummary | null | undefined,
	cache: Pick<Cache, 'csSec' | 'ceSec'>,
): { startSec: number; endSec: number; overridden: boolean } {
	const stored = summary && storedWindowSec({
		sample_rate: rate(summary),
		crop_start_idx_override: summary.crop_start_idx_override,
		crop_end_idx_override: summary.crop_end_idx_override,
	});
	return stored
		? { startSec: stored.start, endSec: stored.end, overridden: true }
		: { startSec: cache.csSec, endSec: cache.ceSec, overridden: false };
}

/** The override pair to upload with the analysis row, or null when none is stored. */
export function cropOverrideForUpload(
	summary: CropSummary | null | undefined,
): { start: number; end: number } | null {
	const start = summary?.crop_start_idx_override, end = summary?.crop_end_idx_override;
	return start != null && end != null ? { start, end } : null;
}
