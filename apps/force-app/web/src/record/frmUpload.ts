// Partial GPU upload bookkeeping for LiveFrm's preallocated point buffers.
import type { BufferAttribute } from 'three';

/**
 * Queue point slots [from, to) of `pos` (stride 3) and `val` (stride 1) for upload, as ONE range
 * that also covers whatever is still waiting from earlier frames (#87).
 *
 * three uploads an attribute's updateRanges only when it actually renders the object, then clears
 * them itself (WebGLAttributes.updateBuffer). Replacing the ranges with just this frame's slice —
 * what LiveFrm used to do — silently dropped every slice written while no upload happened (the
 * object culled, or a frame not rendered), and those points never reached the GPU. A non-empty
 * list therefore means "not uploaded yet": the new range starts at the lower of the two starts.
 */
export function queueUpload(pos: BufferAttribute, val: BufferAttribute, from: number, to: number): void {
	if (to <= from) return;
	const pending = val.updateRanges.length ? val.updateRanges[0].start : Infinity;
	const start = Math.min(from, pending);
	pos.clearUpdateRanges(); val.clearUpdateRanges();
	pos.addUpdateRange(start * 3, (to - start) * 3);
	val.addUpdateRange(start, to - start);
	pos.needsUpdate = true; val.needsUpdate = true;
}
