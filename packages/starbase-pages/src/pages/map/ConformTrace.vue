<script setup lang="ts">
import { computed } from 'vue';
import { TRACE_DASH, type ConformThumb } from './model/conformThumb';

// The small trace of a Conform run's window (wheel speed and Tooling 1, each on its own scale, as in the plotter's overview):
// one polyline per channel, a gap in the readings breaks the line. Used on the Process map's data thumbnail and on the Operation
// page's Conform run section. Theme series colours only; the second line is dashed (4 3), and ConformTraceKey names the lines.
const props = defineProps<{ thumb: ConformThumb; height?: number }>();

const W = 280;
const H = 64;
const lines = computed(() =>
  props.thumb.series.map((s, i) => {
    const span = s.max - s.min || 1;
    const n = s.values.length;
    const parts: string[] = [];
    let run: string[] = [];
    s.values.forEach((v, k) => {
      if (v === null) {
        if (run.length) parts.push(run.join(' '));
        run = [];
        return;
      }
      const x = n > 1 ? (k / (n - 1)) * W : W / 2;
      const y = H - 3 - ((v - s.min) / span) * (H - 6);
      run.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    });
    if (run.length) parts.push(run.join(' '));
    return { key: s.key, label: s.label, cls: `l${i}`, dash: TRACE_DASH[i] || undefined, parts };
  }),
);
const label = computed(() => `Conform run window: ${lines.value.map((l) => l.label).join(' and ')}`);
</script>

<template>
  <svg v-if="lines.length" class="trace" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" :aria-label="label" :style="height ? { height: `${height}px` } : undefined">
    <template v-for="l in lines" :key="l.key">
      <polyline v-for="(pts, k) in l.parts" :key="k" :points="pts" :class="l.cls" :stroke-dasharray="l.dash" fill="none" />
    </template>
  </svg>
</template>

<style scoped>
.trace { display: block; width: 100%; height: 64px; }
.trace polyline { stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.trace .l0 { stroke: var(--d1-series-1, var(--theme--primary)); }
.trace .l1 { stroke: var(--d1-series-2, var(--theme--warning)); }
</style>
