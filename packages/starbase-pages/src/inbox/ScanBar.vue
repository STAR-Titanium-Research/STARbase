<script setup lang="ts">
import { computed } from 'vue';
import { barTone, countText, formatPercent, type Measure } from './progressModel';

// One measure of the scan progress: a thin bar and its percentage, the same in the Inbox page's card and in the admin table. The label is optional (the table's
// column head says it). Green at 100%, amber below 50% after a scan has finished, neutral otherwise; the exact counts are the tooltip and the screen reader's.
const props = defineProps<{
	measure: Measure;
	/** A full scan has finished at least once: only then is a low number a warning. */
	scanFinished: boolean;
	/** Without the label (a table cell). */
	bare?: boolean;
}>();
const tone = computed(() => barTone(props.measure.pct, props.scanFinished));
const text = computed(() => formatPercent(props.measure.pct));
const width = computed(() => `${props.measure.pct ?? 0}%`);
const detail = computed(() => (props.measure.pct === null ? `${props.measure.label}: nothing to measure yet` : `${props.measure.label}: ${countText(props.measure)}`));
</script>

<template>
	<div class="bar" :class="[`tone-${tone}`, { bare }]" :title="detail" data-test="scan-bar" :data-measure="measure.key">
		<span v-if="!bare" class="label">{{ measure.label }}</span>
		<span class="value" data-test="scan-pct">{{ text }}</span>
		<div class="track" role="progressbar" :aria-label="detail" :aria-valuenow="measure.pct === null ? undefined : Math.round(measure.pct)" aria-valuemin="0" aria-valuemax="100">
			<div class="fill" :style="{ width }" />
		</div>
	</div>
</template>

<style scoped>
.bar { display: grid; grid-template-columns: 1fr auto; align-items: baseline; gap: 3px 10px; min-width: 0; --bar-ink: var(--d1-dim); }
.bar.bare { grid-template-columns: 1fr; justify-items: end; gap: 3px; }
.label { font-size: var(--fs-sm, 12px); color: var(--d1-dim); min-width: 0; }
.value { font-size: var(--fs-md, 13px); font-weight: 600; font-variant-numeric: tabular-nums; color: var(--theme--foreground); white-space: nowrap; }
.bar.tone-ok .value { color: var(--d1-ok); }
.bar.tone-warn .value { color: var(--d1-warn); }
.track { grid-column: 1 / -1; width: 100%; height: 4px; border-radius: 99px; background: var(--theme--background-normal); overflow: hidden; }
.fill { height: 100%; border-radius: 99px; background: var(--bar-ink); }
.bar.tone-ok { --bar-ink: var(--d1-ok); }
.bar.tone-warn { --bar-ink: var(--d1-warn); }
.bar.bare .track { min-width: 72px; }
</style>
