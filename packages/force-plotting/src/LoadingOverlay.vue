<script setup lang="ts">
// The one loading overlay for the FRM views (Figure / Lite / Full): the loading orb, the stage as text
// ("Downloading live cache 42%") and a determinate bar when the progress is known. A stage that
// still has the previous picture (streaming LOD nodes) shows as a small pill instead of a veil so
// the cloud stays visible. The text carries the meaning, so reduced motion only slows the orb.
import { computed } from 'vue';
import ThinkingOrb from './ThinkingOrb.vue';
import { stageLabel, stageProgress, type LoadStage } from './loadStage';

const props = defineProps<{ stage: LoadStage | null }>();
const label = computed(() => (props.stage ? stageLabel(props.stage) : 'Loading…'));
const progress = computed(() => (props.stage ? stageProgress(props.stage) : null));
const compact = computed(() => props.stage?.kind === 'stream');
</script>

<template>
	<div class="lo" :class="{ compact }" role="status" aria-live="polite">
		<div class="lo-box">
			<ThinkingOrb :size="compact ? 14 : 20" label="" />
			<span class="lo-label">{{ label }}</span>
			<span v-if="progress != null && !compact" class="lo-bar" aria-hidden="true"><i :style="{ width: Math.round(progress * 100) + '%' }"></i></span>
		</div>
	</div>
</template>

<style scoped>
.lo { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text-dim, #94a3b8); font-size: var(--fs-sm, 12px); pointer-events: none; }
.lo-box { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: center; max-width: 90%; }
.lo-label { font-variant-numeric: tabular-nums; }
.lo-bar { flex: 1 0 100%; height: 3px; border-radius: 2px; background: color-mix(in srgb, currentColor 22%, transparent); overflow: hidden; }
.lo-bar i { display: block; height: 100%; background: var(--accent, #38bdf8); transition: width 0.15s linear; }
/* Streaming: the cloud is already on screen, so just a pill in the corner. */
.lo.compact { inset: auto auto 8px 8px; display: block; }
.lo.compact .lo-box { flex-wrap: nowrap; white-space: nowrap; padding: 3px 9px; border-radius: 999px; background: color-mix(in srgb, var(--plot-bg, #0b1020) 82%, transparent); }
@media (prefers-reduced-motion: reduce) {
	.lo-bar i { transition: none; }
}
</style>
