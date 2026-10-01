<script setup lang="ts">
import type { SelectionStats } from './selection';

const props = defineProps<{ stats: SelectionStats }>();
const fmt = (v: number, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
</script>

<template>
	<div class="sel-inspector">
		<div class="sel-field"><span class="sel-label">points</span><span class="sel-value">{{ props.stats.n.toLocaleString() }}</span></div>
		<div class="sel-field"><span class="sel-label">t-span</span><span class="sel-value">{{ fmt(props.stats.tMin) }} – {{ fmt(props.stats.tMax) }} s</span></div>
		<div class="sel-field"><span class="sel-label">r-range</span><span class="sel-value">{{ fmt(props.stats.rMin) }} – {{ fmt(props.stats.rMax) }} mm</span></div>
		<div class="sel-field"><span class="sel-label">mean resid_z</span><span class="sel-value">{{ fmt(props.stats.meanResidZ) }}</span></div>
	</div>
</template>

<style scoped>
.sel-inspector { display: flex; flex-wrap: wrap; gap: 14px; padding: 8px 12px; font-size: var(--fs-sm, 12px); color: var(--text-dim); border-top: 1px solid var(--border); }
.sel-field { display: flex; flex-direction: column; gap: 2px; }
.sel-label { font-size: var(--fs-xs, 11px); text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
.sel-value { font-variant-numeric: tabular-nums; color: var(--text, #e5e7eb); }
</style>
