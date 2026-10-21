<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { AppLink, assetThumbUrl } from '@d1/ui';
import type { DataPreview } from './model/dataPreview';

// The small data picture of a record (spec §6.6): for a machining operation with a finished force
// analysis, the Fz figure as the small image the index cards use (assetThumbUrl: Directus scales it; never the data file itself); for a FAST run
// with finished run data, the words "FAST run data" (there is no cheap picture of it) and a link to the
// plotter; for a Conform run with a log, "Conform run data" over a small trace of its window (wheel speed and Tooling 1, each on
// its own scale, as in the plotter's overview), and a link to the Conform plotter. Nothing for a record with no data, or while the answer is still on its way. In the hover card
// the plotter link is plain text (the card takes no pointer).
const props = defineProps<{ preview?: DataPreview; link?: boolean }>();

// Square: the force figures are mostly round (a face of the part), so a square shows them at their size.
const src = computed(() => (props.preview?.kind === 'force' && props.preview.imageFileId ? assetThumbUrl(props.preview.imageFileId, 480, 480) : null));
// A figure that cannot be made (most force figures cannot be transformed yet) falls back to the words.
const failed = ref(false);
watch(src, () => void (failed.value = false));

const CAPTION = { fast: 'FAST run data', conform: 'Conform run data', force: 'Force data · Fz' } as const;
const ACTION = { fast: 'Open in FAST plotter', conform: 'Open in Conform plotter', force: 'Open in Force dashboard' } as const;
const caption = computed(() => CAPTION[props.preview?.kind === 'fast' || props.preview?.kind === 'conform' ? props.preview.kind : 'force']);
const action = computed(() => ACTION[props.preview?.kind === 'fast' || props.preview?.kind === 'conform' ? props.preview.kind : 'force']);

// The trace: one polyline per channel, each scaled to its own range; a gap (no reading) breaks the line.
const W = 280;
const H = 64;
const lines = computed(() => {
  const thumb = props.preview?.kind === 'conform' ? props.preview.thumb : undefined;
  if (!thumb) return [];
  return thumb.series.map((s, i) => {
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
    return { key: s.key, label: s.label, unit: s.unit, cls: `l${i}`, parts };
  });
});
const traceLabel = computed(() => `Conform run window: ${lines.value.map((l) => l.label).join(' and ')}`);
</script>

<template>
	<div v-if="preview && preview.kind !== 'none'" class="dthumb">
		<div class="cap">
			<span>{{ caption }}</span>
			<AppLink v-if="link && preview.plotterPath" :to="preview.plotterPath" class="open">{{ action }}</AppLink>
			<span v-else-if="preview.plotterPath" class="open">{{ action }}</span>
		</div>
		<svg v-if="lines.length" class="trace" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" :aria-label="traceLabel">
			<template v-for="l in lines" :key="l.key">
				<polyline v-for="(pts, k) in l.parts" :key="k" :points="pts" :class="l.cls" fill="none" />
			</template>
		</svg>
		<img v-if="src && !failed" :src="src" :alt="`${caption} figure`" loading="lazy" decoding="async" @error="failed = true" />
	</div>
</template>

<style scoped>
.dthumb { border-radius: 10px; background: var(--d1-tile); border: 1px solid var(--d1-line); padding: 6px 8px; min-width: 0; }
.cap { display: flex; justify-content: space-between; gap: 8px; font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
.open { color: var(--d1-accent, var(--theme--primary)); text-decoration: none; font-weight: 600; white-space: nowrap; }
a.open:hover { text-decoration: underline; }
.trace { display: block; width: 100%; height: 64px; margin-top: 4px; }
.trace polyline { stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.trace .l0 { stroke: var(--d1-series-1, var(--theme--primary)); }
.trace .l1 { stroke: var(--d1-series-2, var(--theme--warning)); }
img { display: block; width: 100%; max-width: 280px; aspect-ratio: 1; height: auto; margin: 4px auto 0; object-fit: contain; }
</style>
