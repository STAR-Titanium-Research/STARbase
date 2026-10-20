<script setup lang="ts">
/*
 * Tab 4, Signal statistics: force statistics over the crop window and whole-signal bit-depth / clipping
 * analysis, computed client-side from the live cache (an explicit compute downloads it when it is not local).
 */
import { useForceCtx } from './forceCtx';

const { detail, sigStats, statsBusy, statsErr, statsCacheMb, computeStats, downloadStatsCsv, copyStatsCsv, statsCopied, statsCopyFailed, fmtStat, STAT_AXES } = useForceCtx();
</script>

<template>
	<div class="fp-title">
		<b>Signal statistics</b><span class="fp-dim">in the crop window</span>
	</div>
	<div v-if="!detail.live_cache_file" class="fp-empty">No signal cache — reprocess this op to enable statistics</div>
	<div v-else-if="statsBusy" class="fp-spin"><v-progress-circular indeterminate small /> computing…</div>
	<div v-else-if="statsErr" class="fp-err">{{ statsErr }}</div>
	<template v-else-if="sigStats">
		<div class="fp-pg win"><span>Window</span><span class="v fp-code">{{ sigStats.windowSec[0].toFixed(1) }}–{{ sigStats.windowSec[1].toFixed(1) }} s
			<button class="fp-btn" title="Download these statistics as CSV" @click="downloadStatsCsv">CSV</button>
			<button class="fp-btn" title="Copy these statistics to the clipboard as CSV" @click="copyStatsCsv">{{ statsCopied ? 'Copied' : statsCopyFailed ? 'Copy failed' : 'Copy' }}</button>
		</span></div>
		<table class="stats">
			<thead><tr><th></th><th>Fx</th><th>Fy</th><th>Fz</th></tr></thead>
			<tbody>
				<tr><td>Mean <span class="fp-dim">N</span></td><td v-for="a in STAT_AXES" :key="'m' + a">{{ fmtStat(sigStats.axes[a].mean) }}</td></tr>
				<tr><td>RMS <span class="fp-dim">N</span></td><td v-for="a in STAT_AXES" :key="'r' + a">{{ fmtStat(sigStats.axes[a].rms) }}</td></tr>
				<tr><td>Std <span class="fp-dim">N</span></td><td v-for="a in STAT_AXES" :key="'s' + a">{{ fmtStat(sigStats.axes[a].std) }}</td></tr>
				<tr><td>Min / Max <span class="fp-dim">N</span></td><td v-for="a in STAT_AXES" :key="'x' + a">{{ fmtStat(sigStats.axes[a].min) }} / {{ fmtStat(sigStats.axes[a].max) }}</td></tr>
				<tr><td>Dyn. range <span class="fp-dim">bits</span></td><td v-for="a in STAT_AXES" :key="'b' + a">{{ sigStats.axes[a].effBits?.toFixed(1) ?? '—' }}</td></tr>
				<tr><td>Rail hits <span class="fp-dim">lo/hi %</span></td><td v-for="a in STAT_AXES" :key="'c' + a">
					<span :class="{ bad: sigStats.axes[a].clipped }">{{ sigStats.axes[a].railLoPct.toFixed(2) }} / {{ sigStats.axes[a].railHiPct.toFixed(2) }}<template v-if="sigStats.axes[a].clipped"> ⚠ clip</template></span>
				</td></tr>
			</tbody>
		</table>
		<div class="fp-pg"><span>RPM (window)</span><span class="v">{{ fmtStat(sigStats.rpm.mean) }} ± {{ fmtStat(sigStats.rpm.std) }} <span class="fp-dim">({{ fmtStat(sigStats.rpm.min) }}–{{ fmtStat(sigStats.rpm.max) }})</span></span></div>
		<p class="fp-note">Force stats over the crop window; bits + rails over the whole cached signal (CSV columns ending _whole). Dyn. range = log2(signal span ÷ noise floor); a clean full-range 12-bit capture sits near ~12–13, well below = under-ranged. Sustained rail hits = clipped / over-ranged.</p>
	</template>
	<button v-else class="fp-btn primary compute" :disabled="statsBusy" @click="computeStats">
		<v-icon name="calculate" x-small /> Compute<template v-if="statsCacheMb"> (downloads ~{{ statsCacheMb }} MB signal cache)</template>
	</button>
</template>

<style scoped>
.win .v { flex-basis: auto; }
.stats { width: 100%; border-collapse: collapse; margin: 6px 0 4px; font-size: var(--fs-sm, 12px); }
.stats th { text-align: right; padding: 2px 6px; font-size: var(--fs-xs, 11px); color: var(--fp-dim); font-weight: 600; }
.stats td { text-align: right; padding: 4px 6px; font-variant-numeric: tabular-nums; border-top: 1px solid var(--fp-line); }
.stats td:first-child { text-align: left; padding-left: 0; font-weight: 600; white-space: nowrap; }
.bad { color: var(--theme--danger, #dc2626); font-weight: 700; }
.compute { margin-top: 4px; height: auto; min-height: 28px; white-space: normal; }
</style>
