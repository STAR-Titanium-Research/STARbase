// Shared display formatters. Elapsed-time readouts used to have three near-identical local copies
// (OverviewPanel.vue, TransportBar.vue, AppShell.vue's recording banner) — a future fix (e.g.
// supporting hour-long recordings everywhere) had to be found and applied in each one separately.

/** m:ss, or h:mm:ss once past an hour. For plain elapsed-time readouts; OverviewPanel's live tile
 *  additionally shows sub-second precision under a minute, which is a deliberate visual choice for
 *  that one tile rather than something every caller needs. */
export function formatDuration(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) return '0:00';
	const s = Math.floor(sec);
	const m = Math.floor(s / 60);
	const rem = s % 60;
	if (m < 60) return `${m}:${String(rem).padStart(2, '0')}`;
	const h = Math.floor(m / 60);
	return `${h}:${String(m % 60).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

/** Bytes/sec as B/s, KB/s or MB/s. Compares the ALREADY-ROUNDED value against each unit's
 *  threshold rather than the raw one -- a live rate hovering right at 1e3 or 1e6 would otherwise
 *  flicker: e.g. 999,950 B/s takes the KB branch but *displays* as "1000.0 KB/s" (already at the
 *  value that should have promoted it to MB), then the next tick nudges past 1e6 and shows "1.00
 *  MB/s", then back. Rounding first means the unit only flips once the digits shown actually
 *  cross the line, so a reading near the boundary settles instead of oscillating every update. */
export function formatBandwidth(bytesPerSec: number): string {
	const kb = Math.round((bytesPerSec / 1e3) * 10) / 10;
	if (kb < 1) return bytesPerSec.toFixed(0) + ' B/s';
	if (kb < 1000) return kb.toFixed(1) + ' KB/s';
	return (bytesPerSec / 1e6).toFixed(2) + ' MB/s';
}

/** A size given in MB, shown as KB, MB or GB. */
export function formatMegabytes(mb: number): string {
	if (mb < 1) return `${(mb * 1000).toFixed(0)} KB`;
	if (mb < 1000) return `${mb.toFixed(1)} MB`;
	return `${(mb / 1000).toFixed(2)} GB`;
}
