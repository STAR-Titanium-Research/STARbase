<script setup lang="ts">
import { computed } from 'vue';
import { useWorkspace } from '../workspace';
import { RAW_BYTES_PER_SAMPLE, RAW_COLUMNS } from '../liveClient';
import { railedNames, shownRailed } from '../railing';
import { formatBandwidth, formatDuration, formatMegabytes } from '../../format';
const w = useWorkspace();
const st = w.st;
const ROW_BYTES = RAW_COLUMNS * RAW_BYTES_PER_SAMPLE;

// Sub-second precision under a minute is a deliberate choice for this live tile (ticking
// "3.42s" reads as more alive than "0:03" while a cut is still short) — everything else here
// delegates to the shared formatter so a fix to the mm:ss/h:mm:ss logic doesn't need to be found
// and re-applied in three near-identical local copies.
function fmtTime(s: number): string {
	if (!Number.isFinite(s) || s < 0) return '—';
	if (s < 60) return s.toFixed(2) + 's';
	return formatDuration(s);
}

const estSizeMb = computed(() => {
	if (st.nTotal === 0) return 0;
	return st.nTotal * ROW_BYTES / 1e6;
});

const bandwidth = computed(() => {
	if (st.tSec <= 0 || st.nTotal === 0) return '—';
	return formatBandwidth((st.nTotal * ROW_BYTES) / st.tSec);
});

const railed = computed(() => railedNames(shownRailed(w.mode.value, st.railed)).join(', '));

const eta = computed(() => {
	if (w.source.value === 'sim' && w.cfg.duration_sec > 0 && st.state === 'recording') {
		const remaining = w.cfg.duration_sec - st.tSec;
		return remaining > 0 ? fmtTime(remaining) : '0s';
	}
	return null;
});
</script>

<template>
	<div class="overview">
		<div class="grid">
			<!-- title: the full value, for when a narrow panel ellipsizes it. -->
			<div class="ro" :title="`State: ${st.state}`"><span>State</span><b :class="st.state">{{ st.state }}</b></div>
			<div class="ro" :title="`Elapsed: ${fmtTime(st.tSec)}`"><span>Elapsed</span><b>{{ fmtTime(st.tSec) }}</b></div>
			<div class="ro" v-if="eta !== null" :title="`ETA: ${eta}`"><span>ETA</span><b class="eta">{{ eta }}</b></div>
			<div class="ro" :title="`Cut start: ${st.cutStartSec !== null ? fmtTime(st.cutStartSec) : 'not detected'}`"><span>Cut</span><b :class="{ cut: st.cutStartSec !== null }">{{ st.cutStartSec !== null ? fmtTime(st.cutStartSec) : '—' }}</b></div>
			<div class="ro" :title="`Samples: ${st.nTotal.toLocaleString()}`"><span>Samples</span><b>{{ st.nTotal.toLocaleString() }}</b></div>
			<div class="ro" :title="`File size: ${formatMegabytes(estSizeMb)}`"><span>File size</span><b>{{ formatMegabytes(estSizeMb) }}</b></div>
			<div class="ro" :title="`Bandwidth: ${bandwidth}`"><span>Bandwidth</span><b>{{ bandwidth }}</b></div>
			<div v-if="railed" class="ro railed" :title="`Railed (full scale): ${railed}`" data-testid="overview-railed"><span>Railed</span><b>{{ railed }}</b></div>
			<div class="ro" :title="`Fx peak: ${st.peaks.Fx.toFixed(1)} N`"><span>Fx</span><b class="fx">{{ st.peaks.Fx.toFixed(1) }}</b></div>
			<div class="ro" :title="`Fy peak: ${st.peaks.Fy.toFixed(1)} N`"><span>Fy</span><b class="fy">{{ st.peaks.Fy.toFixed(1) }}</b></div>
			<div class="ro" :title="`Fz peak: ${st.peaks.Fz.toFixed(1)} N`"><span>Fz</span><b class="fz">{{ st.peaks.Fz.toFixed(1) }}</b></div>
		</div>
	</div>
</template>

<style scoped>
/* One row that shrinks, never wraps: the panel is ~50px tall, so a wrapped second row (which live
   values like "recording" / "188,000" / "1.00 MB/s" forced at ordinary widths) was clipped, and
   the centring pushed the first row's labels off the top where scrolling can't reach them. */
.overview { display: flex; height: 100%; container-type: inline-size; }
.grid { display: flex; gap: 6px; justify-content: center; width: 100%; margin: auto 0; }
.ro { flex: 1 1 0; max-width: 120px; min-width: 0; display: flex; flex-direction: column; align-items: center; padding: 3px 8px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
.ro span { font-size: var(--fs-xs); color: var(--text-dim); letter-spacing: 0.01em; }
.ro.railed { background: #dc2626; border-color: #dc2626; }
.ro.railed span, .ro.railed b { color: #fff; }
.ro span, .ro b { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ro b { font-size: var(--fs-md); font-variant-numeric: tabular-nums; }
@container (max-width: 760px) {
	.grid { gap: 4px; }
	.ro { padding: 3px 4px; }
	.ro b { font-size: var(--fs-sm); }
}
/* Short panel: at the grid's minimum row height (a ~768px-tall screen) the body is ~30px, so the
   tiles drop their vertical padding and tighten the line height to keep label over value. */
@container panel-body (max-height: 36px) {
	.ro { padding-block: 0; }
	.ro span, .ro b { line-height: 1.15; }
}
/* DESIGN TEST: `cut` is an identifier, not a status, and it was rendered in the Fy green sitting
   three tiles away in this same strip. Plain text -- only State keeps a status hue (a
   traffic light reads as status from context, which an axis identity does not). */
.ro b.recording { color: var(--warn); } .ro b.done { color: var(--ok); } .ro b.error { color: var(--danger); }
.ro b.cut { color: var(--text); }
.ro b.eta { color: var(--warn); }
.ro b.fx { color: var(--fx-ink); } .ro b.fy { color: var(--fy-ink); } .ro b.fz { color: var(--fz-ink); }
</style>
