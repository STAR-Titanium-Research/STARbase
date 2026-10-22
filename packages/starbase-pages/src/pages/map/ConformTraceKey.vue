<script setup lang="ts">
import { TRACE_DASH, type ConformThumb } from './model/conformThumb';

// The one-line key of ConformTrace: a short line sample (solid, then dashed) and the channel's name, "— Wheel speed · - - Tooling 1".
// Colour and dash together, never colour alone; the text keeps the secondary ink.
defineProps<{ thumb: ConformThumb }>();
</script>

<template>
	<p v-if="thumb.series.length" class="tkey">
		<template v-for="(s, i) in thumb.series" :key="s.key">
			<span v-if="i" class="sep" aria-hidden="true">·</span>
			<span class="item">
				<svg class="sw" :class="`l${i}`" width="18" height="6" viewBox="0 0 18 6" aria-hidden="true"><line x1="0" y1="3" x2="18" y2="3" :stroke-dasharray="TRACE_DASH[i] || undefined" /></svg>{{ s.label }}
			</span>
		</template>
	</p>
</template>

<style scoped>
.tkey { display: flex; flex-wrap: wrap; align-items: center; gap: 0 6px; margin: 4px 0 0; font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
.item { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.sw line { stroke-width: 2; }
.sw.l0 { stroke: var(--d1-series-1, var(--theme--primary)); }
.sw.l1 { stroke: var(--d1-series-2, var(--theme--warning)); }
</style>
