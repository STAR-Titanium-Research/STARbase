<script setup lang="ts">
// diag_metrics (the JSON column populated by process_diag_row) may or may not carry
// dyno_fn_hz/quantitative_limit_hz -- analyse() only sets them when a caller passes fn_hz,
// which nothing currently does (no setup record exists yet -- see the design spec's deferred
// Component 4). This strip degrades honestly rather than showing a fabricated limit.
const props = defineProps<{
	metrics: {
		effective_fs_hz?: number;
		effective_nyquist_hz?: number;
		dyno_fn_hz?: number;
		quantitative_limit_hz?: number;
	} | null;
}>();
const fmtHz = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(0)} Hz` : null);
</script>

<template>
	<div class="bw-strip">
		<template v-if="props.metrics?.quantitative_limit_hz">
			<span class="bw-seg bw-quant">quantitative &lt; {{ fmtHz(props.metrics.quantitative_limit_hz) }}</span>
			<span class="bw-seg bw-event">event only above {{ fmtHz(props.metrics.quantitative_limit_hz) }}</span>
		</template>
		<template v-else>
			<span class="bw-seg bw-unknown">
				dynamometer natural frequency not recorded for this setup — bandwidth validity unknown;
				treat all channels as event-detection only
			</span>
		</template>
		<span v-if="fmtHz(props.metrics?.effective_nyquist_hz)" class="bw-nyquist">
			effective Nyquist: {{ fmtHz(props.metrics?.effective_nyquist_hz) }}
		</span>
	</div>
</template>

<style scoped>
.bw-strip { display: flex; align-items: center; gap: 10px; padding: 5px 12px; font-size: var(--fs-xs, 11px); border-top: 1px solid var(--border); flex-wrap: wrap; }
.bw-seg { padding: 2px 8px; border-radius: 4px; }
.bw-quant { background: color-mix(in srgb, #16a34a 22%, transparent); color: #86efac; }
.bw-event { background: color-mix(in srgb, #d97706 22%, transparent); color: #fcd34d; }
.bw-unknown { background: color-mix(in srgb, #64748b 22%, transparent); color: var(--text-dim); }
.bw-nyquist { margin-left: auto; color: var(--text-dim); font-variant-numeric: tabular-nums; }
</style>
